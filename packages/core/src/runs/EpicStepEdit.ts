/**
 * Add or remove a step on an epic that is already running.
 *
 * ## Why this is not just an array splice
 *
 * An epic's steps are written down three times — the pipeline's `steps` in
 * `workspace.yaml`, `stepStates[]` in the epic's `state.json`, and `steps[]`
 * in `.aidlc/runs/<id>.json` — and the last two are keyed by position. Editing
 * the pipeline alone moves the definitions out from under the history, which
 * is why the extension's Add/Delete/Reorder controls are locked while an epic
 * owns a pipeline (`epicPinningPipeline`). This module is the way back in: it
 * reshapes both lists together, so the history keeps describing the step it
 * was always about.
 *
 * ## The shape of the operation
 *
 * Planning is pure and validating; committing is the only part that writes.
 * {@link planAddEpicStep} and {@link planRemoveEpicStep} either throw an
 * {@link EpicStepEditError} that says what is wrong, or hand back both stores
 * already reshaped and consistent. Nothing reaches disk until every check has
 * passed, so a rejected edit cannot leave a half-applied epic behind.
 *
 * ## What is refused, and why
 *
 * A run is only editable while it still matches its pipeline: `reconcileRun`
 * has to say the two sides are aligned before either side is touched, because
 * a splice computed against a list that already drifted would bake the drift
 * in rather than fix it.
 *
 * Beyond that the rule is the same in both directions — **the past is not
 * editable**. Only a `pending` step can be removed, and a step can only be
 * inserted after every step that is no longer pending. A step that has been
 * started, reviewed, approved or rejected is a record of work that happened,
 * and deleting it deletes the record; inserting ahead of one would claim a
 * slot the run has already gone past, leaving a step that is pending forever
 * behind an advancing pointer. `aidlc step skip` remains the answer for a step
 * in flight that should not run: it changes a status and leaves every index
 * and the length alone.
 *
 * ## Gates are a cheaper edit than shape
 *
 * {@link planSetEpicStepGates} is in this module for the company, not because
 * it shares the hard part. `human_review` and `auto_review` are never copied
 * into the run: the runner reads them off the live pipeline at the moment a
 * step's work is submitted. So a gate edit touches one file, has no second
 * store to keep in step with, and needs no rollback — the reason the extension
 * lets gates be edited on a pinned pipeline while it locks the step list.
 *
 * What it cannot do is reach backwards. A gate that has already fired for the
 * current revision of a step stays fired; {@link describeGateEffect} turns
 * that into something to tell the user rather than a refusal, because the
 * setting is still the right one for the next time the step runs.
 */

import type { PipelineConfig, PipelineStepConfig } from '../schema/WorkspaceSchema';
import { normalizeStep, stepDagId } from '../schema/WorkspaceSchema';
import type { RunState, StepRecord, StepHistoryEntry, StepStatus } from './RunState';
import { stepIdentity, RUN_STATE_SCHEMA_VERSION } from './RunState';
import { reconcileRunSteps, describeDrift } from './reconcileRun';
import { RunStateStore } from './RunStateStore';
import { mirrorRunStateToEpic } from './EpicScaffold';

export class EpicStepEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpicStepEditError';
  }
}

/** The parts of a new step a caller supplies. Everything else defaults. */
export interface EpicStepSpec {
  agent: string;
  /**
   * The step's identity in `depends_on`, recipes and the run's records. Worth
   * setting whenever the agent already owns another step in this pipeline —
   * without it the two are only distinguishable by position, which is the
   * problem this module exists to avoid.
   */
  name?: string;
  produces?: string[];
  requires?: string[];
  depends_on?: string[];
  human_review?: boolean;
  auto_review?: boolean;
}

/** Where a new step goes. Omit both to append at the end. */
export interface EpicStepPosition {
  /** Insert immediately after this step (name, agent id, or index). */
  after?: string;
  /** Insert immediately before this step (name, agent id, or index). */
  before?: string;
}

/**
 * Both stores, reshaped and consistent with each other — the result of a
 * validated edit that has not been written yet.
 */
export interface EpicStepEditPlan {
  /** The pipeline with its `steps` replaced. Same object identity elsewhere. */
  pipeline: PipelineConfig;
  /** The run with its records spliced, renumbered and re-pointed. */
  runState: RunState;
  /** Identity (`name ?? agent`) of the step that was added or removed. */
  stepId: string;
  /** Index it was inserted at, or removed from. */
  index: number;
  /** `currentStepIdx` before the edit, for callers that want to report a move. */
  previousCurrentStepIdx: number;
}

// ── Resolving a step reference ────────────────────────────────────────────────

/**
 * Resolve a `<step>` argument against the run: an index, a step name, or an
 * agent id. Names win over agents because they are the more specific handle,
 * and an agent that owns several steps is refused rather than resolved to the
 * first of them — the whole point of the identity work is that "which step"
 * stops being a guess.
 */
export function resolveStepRef(state: RunState, ref: string): number {
  const asInt = Number.parseInt(ref, 10);
  if (!Number.isNaN(asInt) && String(asInt) === ref) {
    if (asInt < 0 || asInt >= state.steps.length) {
      throw new EpicStepEditError(
        `Step index ${asInt} is out of range for run "${state.runId}" (0–${state.steps.length - 1}).`,
      );
    }
    return asInt;
  }

  const byName = state.steps.findIndex((s) => s.name === ref);
  if (byName >= 0) { return byName; }

  const byAgent = state.steps
    .map((s, i) => (s.agent === ref ? i : -1))
    .filter((i) => i >= 0);
  if (byAgent.length > 1) {
    throw new EpicStepEditError(
      `Agent "${ref}" owns more than one step in run "${state.runId}" ` +
      `(${byAgent.map((i) => `${i}:${stepIdentity(state.steps[i])}`).join(', ')}). ` +
      'Name the step or give its index.',
    );
  }
  if (byAgent.length === 1) { return byAgent[0]; }

  throw new EpicStepEditError(
    `Step "${ref}" not found in run "${state.runId}". ` +
    `Steps: ${state.steps.map((s, i) => `${i}:${stepIdentity(s)}`).join(', ')}.`,
  );
}

// ── Shared checks ─────────────────────────────────────────────────────────────

/**
 * Refuse to edit a run that has already drifted from its pipeline. Splicing
 * against a list whose positions no longer mean what they say would write the
 * drift into both stores instead of resolving it.
 */
function requireAligned(state: RunState, pipeline: PipelineConfig): void {
  const r = reconcileRunSteps(state, pipeline);
  if (!r.aligned) {
    throw new EpicStepEditError(
      `Run "${state.runId}" does not currently match pipeline "${pipeline.id}" — ` +
      `${describeDrift(r)}. Reconcile the two before editing steps: an edit ` +
      'computed against a mismatched pair would preserve the mismatch, not fix it.',
    );
  }
}

function pipelineSteps(pipeline: PipelineConfig): PipelineStepConfig[] {
  return Array.isArray(pipeline.steps) ? pipeline.steps : [];
}

/** Index of the last step that is no longer `pending`, or -1 when none is. */
function lastSettledIdx(state: RunState): number {
  let last = -1;
  state.steps.forEach((s, i) => {
    if (s.status !== 'pending') { last = i; }
  });
  return last;
}

/**
 * Renumber `stepIdx`, move `currentStepIdx` to wherever the step it pointed at
 * ended up, and rewrite the step indices recorded in step history so a
 * "sent back to step 3" note keeps naming the same step.
 *
 * `oldToNew` maps a pre-edit index to its post-edit one; a removed step maps
 * to -1.
 */
function reindex(
  state: RunState,
  steps: StepRecord[],
  oldToNew: number[],
  fallbackCurrent: number,
): RunState {
  const renumbered = steps.map((s, i) => {
    const history = s.history?.map((h) => remapHistory(h, oldToNew));
    return { ...s, stepIdx: i, ...(history ? { history } : {}) };
  });

  const mappedCurrent = oldToNew[state.currentStepIdx];
  const currentStepIdx = mappedCurrent !== undefined && mappedCurrent >= 0
    ? mappedCurrent
    : fallbackCurrent;

  // A finished run that gains a step has work to do again, and one whose last
  // outstanding step was removed is finished. Anything else keeps the status it
  // had — an edit is not an opinion about a run that `failed`.
  const allApproved = renumbered.every((s) => s.status === 'approved');
  const status = allApproved
    ? 'completed'
    : state.status === 'completed'
      ? 'running'
      : state.status;

  return {
    ...state,
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    steps: renumbered,
    currentStepIdx: Math.max(0, Math.min(currentStepIdx, renumbered.length - 1)),
    status,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * History entries are a record of what happened, not machine state — but a
 * rejection records the *index* it sent work back to, and that number is shown
 * to the user. Remap it so it keeps pointing at the same step; leave it alone
 * when its target is gone, since there is no honest number to replace it with.
 */
function remapHistory(entry: StepHistoryEntry, oldToNew: number[]): StepHistoryEntry {
  if (entry.kind !== 'reject') { return entry; }
  const mapped = oldToNew[entry.sentBackToIdx];
  if (mapped === undefined || mapped < 0) { return entry; }
  return { ...entry, sentBackToIdx: mapped };
}

// ── Remove ────────────────────────────────────────────────────────────────────

/**
 * Plan the removal of one step from a running epic.
 *
 * Refuses a step that is not `pending`, a step other steps depend on, and the
 * last remaining step. Nothing is written — see {@link commitEpicStepEdit}.
 */
export function planRemoveEpicStep(args: {
  runState: RunState;
  pipeline: PipelineConfig;
  /** Step name, agent id, or index. */
  step: string;
}): EpicStepEditPlan {
  const { runState, pipeline } = args;
  requireAligned(runState, pipeline);

  const raw = pipelineSteps(pipeline);
  const idx = resolveStepRef(runState, args.step);
  const record = runState.steps[idx];
  const id = stepIdentity(record);

  if (raw.length <= 1) {
    throw new EpicStepEditError(
      `Cannot remove "${id}" — pipeline "${pipeline.id}" would have no steps left. ` +
      'An epic with nothing to run is not a state the runner has; delete the epic instead.',
    );
  }

  if (record.status !== 'pending') {
    throw new EpicStepEditError(
      `Step "${id}" is ${record.status}, not pending — removing it would delete the ` +
      'record of work that already happened. ' +
      `Use \`aidlc step skip ${runState.runId} ${id}\` to jump over it instead: that ` +
      'marks it approved with a reason and leaves every index and the length alone.',
    );
  }

  // A `depends_on` edge naming a step that no longer exists never resolves, so
  // the dependent would sit pending for the rest of the run.
  const dependents = raw
    .filter((_, i) => i !== idx)
    .filter((s) => normalizeStep(s).depends_on.includes(id))
    .map((s) => stepDagId(s));
  if (dependents.length > 0) {
    throw new EpicStepEditError(
      `Cannot remove "${id}" — ${dependents.map((d) => `"${d}"`).join(', ')} ` +
      `depend${dependents.length === 1 ? 's' : ''} on it, and a dependency on a step ` +
      'that does not exist is never satisfied. Repoint or remove those steps first.',
    );
  }

  const oldToNew = runState.steps.map((_, i) => (i === idx ? -1 : i > idx ? i - 1 : i));
  const nextSteps = runState.steps.filter((_, i) => i !== idx);

  // If the pointer was on the removed step, land on the first step still to
  // be done rather than an arbitrary neighbour.
  const firstOpen = nextSteps.findIndex((s) => s.status !== 'approved');

  return {
    pipeline: { ...pipeline, steps: raw.filter((_, i) => i !== idx) },
    runState: reindex(runState, nextSteps, oldToNew, firstOpen >= 0 ? firstOpen : 0),
    stepId: id,
    index: idx,
    previousCurrentStepIdx: runState.currentStepIdx,
  };
}

// ── Add ───────────────────────────────────────────────────────────────────────

/**
 * Plan the insertion of a step into a running epic.
 *
 * Refuses a duplicate identity, an insertion point at or before a step that is
 * no longer pending, a `depends_on` that names nothing, and — in a pipeline
 * that uses the DAG — a step with no `depends_on` at all, since `advance` only
 * ever opens steps that declare one and a step without one would never start.
 */
export function planAddEpicStep(args: {
  runState: RunState;
  pipeline: PipelineConfig;
  step: EpicStepSpec;
  position?: EpicStepPosition;
}): EpicStepEditPlan {
  const { runState, pipeline, step } = args;
  requireAligned(runState, pipeline);

  const raw = pipelineSteps(pipeline);
  const agent = step.agent.trim();
  if (!agent) {
    throw new EpicStepEditError('A new step needs an agent.');
  }
  const name = step.name?.trim() || undefined;
  const id = name ?? agent;

  const existing = raw.map((s) => stepDagId(s));
  if (existing.includes(id)) {
    throw new EpicStepEditError(
      `Pipeline "${pipeline.id}" already has a step called "${id}". ` +
      (name
        ? 'Step identities have to be unique — `depends_on`, recipes and the run ' +
          'records all address steps by this name.'
        : `Give the new step a \`--name\` so it is distinguishable from the ` +
          `existing "${agent}" step.`),
    );
  }

  const at = resolveInsertIdx(runState, raw, args.position);

  const settled = lastSettledIdx(runState);
  if (at <= settled) {
    const blocker = stepIdentity(runState.steps[settled]);
    throw new EpicStepEditError(
      `Cannot insert "${id}" at index ${at} — "${blocker}" at index ${settled} is ` +
      `${runState.steps[settled].status}, so the run has already reached that point. ` +
      'A step added behind the pointer never opens; it can only go after every step ' +
      `that has started. The earliest position available is ${settled + 1}.`,
    );
  }

  const dependsOn = (step.depends_on ?? []).map((d) => d.trim()).filter(Boolean);
  const unknown = dependsOn.filter((d) => !existing.includes(d));
  if (unknown.length > 0) {
    throw new EpicStepEditError(
      `depends_on names ${unknown.map((d) => `"${d}"`).join(', ')}, which ` +
      `pipeline "${pipeline.id}" does not have. Steps: ${existing.join(', ')}.`,
    );
  }

  // In a DAG pipeline `advance` only opens a pending step once its declared
  // dependencies are approved — a step with none is opened at start time or
  // never, and this one is being added long after start time.
  const usesDag = raw.some((s) => normalizeStep(s).depends_on.length > 0);
  if (usesDag && dependsOn.length === 0) {
    throw new EpicStepEditError(
      `Pipeline "${pipeline.id}" runs as a DAG, where a step opens when the steps ` +
      'it depends on are approved. A step added with no `depends_on` has nothing to ' +
      'wait for and nothing to open it, so it would stay pending for the rest of the ' +
      `run. Give it one — e.g. \`--depends-on ${existing[Math.max(0, at - 1)]}\`.`,
    );
  }

  const newStep: PipelineStepConfig = {
    agent,
    ...(name ? { name } : {}),
    ...(step.produces?.length ? { produces: step.produces } : {}),
    ...(step.requires?.length ? { requires: step.requires } : {}),
    ...(dependsOn.length ? { depends_on: dependsOn } : {}),
    ...(step.human_review ? { human_review: true } : {}),
    ...(step.auto_review ? { auto_review: true } : {}),
  } as PipelineStepConfig;

  const newRecord: StepRecord = {
    stepIdx: at,
    agent,
    ...(name ? { name } : {}),
    revision: 1,
    status: 'pending',
    artifactsProduced: [],
  };

  const nextRaw = [...raw.slice(0, at), newStep, ...raw.slice(at)];
  const nextSteps = [...runState.steps.slice(0, at), newRecord, ...runState.steps.slice(at)];
  const oldToNew = runState.steps.map((_, i) => (i >= at ? i + 1 : i));

  return {
    pipeline: { ...pipeline, steps: nextRaw },
    runState: reindex(runState, nextSteps, oldToNew, runState.currentStepIdx),
    stepId: id,
    index: at,
    previousCurrentStepIdx: runState.currentStepIdx,
  };
}

/** Turn `--after` / `--before` into an insertion index, defaulting to the end. */
function resolveInsertIdx(
  state: RunState,
  raw: PipelineStepConfig[],
  position?: EpicStepPosition,
): number {
  if (position?.after && position?.before) {
    throw new EpicStepEditError('Give either --after or --before, not both.');
  }
  if (position?.after) { return resolveStepRef(state, position.after) + 1; }
  if (position?.before) { return resolveStepRef(state, position.before); }
  return raw.length;
}

// ── Commit ────────────────────────────────────────────────────────────────────

export interface CommitEpicStepEditArgs {
  workspaceRoot: string;
  /** Raw workspace doc, for `state.root`. */
  doc: { state?: unknown } | null;
  plan: EpicStepEditPlan;
  /**
   * Persist the reshaped pipeline back into `workspace.yaml`. Supplied by the
   * caller because the CLI and the extension each own their YAML round-trip
   * (comments, formatting, atomic rename) and core should not have a second
   * opinion about it.
   */
  writeWorkspace: (pipeline: PipelineConfig) => void;
  /**
   * Put `workspace.yaml` back the way it was. Called if a later write fails,
   * so an interrupted edit does not leave the definitions ahead of the history.
   */
  restoreWorkspace: () => void;
}

/**
 * Write a plan to all three stores.
 *
 * There is no filesystem transaction across three files, so this does the two
 * things that are actually available. Everything is validated and computed
 * before the first byte is written, so no write happens on account of an edit
 * that was going to be rejected; and if a later write fails, the earlier ones
 * are put back. What remains — a crash between two writes — leaves the run and
 * its pipeline mismatched, which since schema 2 is a state the runner detects
 * and refuses rather than one it acts on.
 *
 * The epic's `state.json` is written last because it is a mirror: it is
 * derived from the run state and rewritten on every transition, so it is the
 * one of the three that can be regenerated rather than reconstructed.
 */
export function commitEpicStepEdit(args: CommitEpicStepEditArgs): void {
  const { workspaceRoot, doc, plan } = args;

  args.writeWorkspace(plan.pipeline);
  try {
    RunStateStore.save(workspaceRoot, plan.runState);
  } catch (err) {
    args.restoreWorkspace();
    throw err;
  }
  mirrorRunStateToEpic(workspaceRoot, plan.runState, doc);
}

// ── Gates ─────────────────────────────────────────────────────────────────────

/** The gate flags a caller can change. Omitted keys are left as they are. */
export interface EpicStepGateSpec {
  human_review?: boolean;
  auto_review?: boolean;
  /** Validator path. Required whenever `auto_review` ends up on. */
  auto_review_runner?: string;
}

export interface EpicStepGateChange {
  gate: 'human_review' | 'auto_review';
  from: boolean;
  to: boolean;
}

export interface EpicStepGatePlan extends EpicStepEditPlan {
  /** What actually changed. Empty when the step already had these settings. */
  changes: EpicStepGateChange[];
  /** The step's status when the edit was planned — see {@link describeGateEffect}. */
  stepStatus: StepStatus;
}

/**
 * Plan a gate change on one step of a running epic.
 *
 * Unlike {@link planAddEpicStep} and {@link planRemoveEpicStep} this reshapes
 * nothing: `runState` is handed back untouched, and the caller only has the
 * pipeline to write. It is still planned rather than applied directly so the
 * refusals live next to the ones they resemble, and so a caller can see what
 * it is about to change before it changes it.
 *
 * The alignment check is kept. An epic whose run has already drifted from its
 * pipeline is one where "step 3" means two different things, and picking the
 * wrong one to re-gate is the same class of mistake as splicing the wrong one.
 */
export function planSetEpicStepGates(args: {
  runState: RunState;
  pipeline: PipelineConfig;
  step: string;
  gates: EpicStepGateSpec;
}): EpicStepGatePlan {
  const { runState, pipeline, gates } = args;
  requireAligned(runState, pipeline);

  if (
    gates.human_review === undefined &&
    gates.auto_review === undefined &&
    gates.auto_review_runner === undefined
  ) {
    throw new EpicStepEditError('Nothing to set — name at least one gate to change.');
  }

  const idx = resolveStepRef(runState, args.step);
  const raw = pipelineSteps(pipeline);
  const current = raw[idx];
  const norm = normalizeStep(current);
  const id = stepDagId(current);

  const human = gates.human_review ?? norm.human_review;
  const auto = gates.auto_review ?? norm.auto_review;
  const runner = gates.auto_review_runner?.trim() || norm.auto_review_runner;

  // The schema refuses this pair too, but catching it here names the step and
  // happens before anything is serialized. A gate with no validator behind it
  // would leave the step parked in `awaiting_auto_review` with nothing able to
  // move it, which is a stall rather than an error.
  if (auto && !runner) {
    throw new EpicStepEditError(
      `Step "${id}" would have \`auto_review\` on with no \`auto_review_runner\` to run. ` +
      'Give the validator path along with the gate.',
    );
  }

  const changes: EpicStepGateChange[] = [];
  if (human !== norm.human_review) {
    changes.push({ gate: 'human_review', from: norm.human_review, to: human });
  }
  if (auto !== norm.auto_review) {
    changes.push({ gate: 'auto_review', from: norm.auto_review, to: auto });
  }

  // Absent means false throughout the schema, so an off gate is deleted rather
  // than written as `false` — a workspace.yaml edited by this command should
  // read like one written by hand.
  const next: Record<string, unknown> =
    typeof current === 'object' && current !== null
      ? { ...(current as unknown as Record<string, unknown>) }
      : { agent: norm.agent };
  if (human) { next.human_review = true; } else { delete next.human_review; }
  if (auto) {
    next.auto_review = true;
    next.auto_review_runner = runner;
  } else {
    delete next.auto_review;
    delete next.auto_review_runner;
    delete next.auto_review_timeout_ms;
  }

  const nextRaw = [...raw];
  nextRaw[idx] = next as unknown as PipelineStepConfig;

  return {
    pipeline: { ...pipeline, steps: nextRaw },
    runState,
    stepId: id,
    index: idx,
    previousCurrentStepIdx: runState.currentStepIdx,
    changes,
    stepStatus: runState.steps[idx].status,
  };
}

/**
 * Explain what a gate change does *not* do, given where the step already is.
 *
 * The runner reads gates when a step's work is submitted, so a change reaches
 * any step that has not got that far — `pending` and `awaiting_work` need no
 * explanation at all. Past that point the gate for the current revision has
 * already been decided, and the new setting waits for the next revision: a
 * rerun, or a step sent back for an update.
 *
 * Returns `null` when there is nothing worth saying, so callers can treat a
 * note as exceptional rather than printing an empty one.
 */
export function describeGateEffect(
  status: StepStatus,
  changes: EpicStepGateChange[],
): string | null {
  if (changes.length === 0) { return null; }
  if (status === 'pending' || status === 'awaiting_work') { return null; }

  const touched = (gate: EpicStepGateChange['gate']): boolean =>
    changes.some((c) => c.gate === gate);

  if (status === 'awaiting_auto_review' && touched('auto_review')) {
    return 'The step is already waiting on its auto-reviewer, so this does not ' +
      'call it off — submit a verdict, or reset the step, to get past it. ' +
      'The new setting applies the next time the step runs.';
  }
  if (status === 'awaiting_review' && touched('human_review')) {
    return 'The step is already waiting for approval, so turning the gate off ' +
      'does not release it — approve it (aidlc run approve <epicId>) to move on. ' +
      'The new setting applies the next time the step runs.';
  }
  return 'The step has already passed its gates for this revision, so nothing ' +
    'reopens — the new setting applies if the step is rerun or sent back for ' +
    'an update.';
}
