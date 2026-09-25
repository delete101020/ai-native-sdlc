/**
 * State machine for a pipeline run.
 *
 * Pure functions over {@link RunState}: each transition takes the current
 * state + a pipeline definition and returns the next state. The store
 * persists; nothing here touches the filesystem (except gate-check, which
 * is a read-only `existsSync` against produced artifacts).
 *
 * Phase 1 implements:
 *   - start: scaffold a fresh RunState from a pipeline + context map
 *   - markStepDone: validate the current step's `produces` exist; transition
 *     to awaiting_review (if human_review) or auto-approve + advance
 *   - undoStepDone: take back a mark-done nothing downstream has acted on
 *   - approve: human accepts current awaiting_review step → advance
 *   - reject: human rejects current awaiting_review step → step rejected
 *     (in-place) OR cascade to an upstream step with intermediate steps
 *     reset to pending
 *   - rerun: user retries a rejected step → revision++, back to awaiting_work
 *   - rerunApprovedStep: redo a step that already passed, without throwing
 *     away what was built on top of it — downstream approvals are kept and
 *     marked `dirty` instead
 *
 * Phase 2 will layer in: requires gate-check on advance, hooks (before/after
 * step), automatic worker dispatch.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { PipelineConfig } from '../schema/WorkspaceSchema';
import { normalizeStep, stepSkillAlternatives } from '../schema/WorkspaceSchema';
import type { RunState, StepRecord, StepStatus, AutoReviewVerdict, StepHistoryEntry, StepDirtyMark } from './RunState';
import { resolvePath, stepIdentity, RUN_STATE_SCHEMA_VERSION } from './RunState';
import { isActiveStatus, isRunComplete, isStepOptional } from './runProgress';
import { reconcileRunSteps, describeDrift, withBackfilledStepNames } from './reconcileRun';

export class PipelineRunError extends Error {
  constructor(message: string, public readonly missing?: string[]) {
    super(message);
    this.name = 'PipelineRunError';
  }
}

/**
 * Refuse to advance a run whose step list no longer matches its pipeline, and
 * return the state with any missing step names filled in.
 *
 * Every transition below addresses steps by index. That is only meaningful
 * while the two lists still describe the same steps in the same order, and
 * nothing used to check it: a step removed from the pipeline left every later
 * index quietly pointing one step early, and the old `index in range` guard
 * had no opinion about that at all. Comparing identities turns it into a
 * refusal that names what moved.
 *
 * The backfill rides along because this is the one place a run and its
 * pipeline are both in hand on a write path: a pre-schema-2 run acquires its
 * step names the first time it is touched, and stays checkable afterwards.
 */
function alignedOrThrow(state: RunState, pipeline: PipelineConfig): RunState {
  const r = reconcileRunSteps(state, pipeline);
  if (!r.aligned) {
    throw new PipelineRunError(
      `Run "${state.runId}" no longer matches pipeline "${pipeline.id}" — ` +
      `${describeDrift(r)}. The run records what happened by step, so it ` +
      'cannot be replayed onto a different step list. Use ' +
      `\`aidlc step skip ${state.runId} <index>\` to drop a step from this run ` +
      'without reshaping the pipeline.',
    );
  }
  return withBackfilledStepNames(state, pipeline);
}

/**
 * Create a fresh run for the given pipeline + context. Caller persists
 * the result via {@link RunStateStore.save}.
 *
 * Throws if the pipeline has zero steps (caught by Zod, but we double-
 * check so a misconfigured runtime doesn't produce an invalid run).
 */
export function startRun(args: {
  runId: string;
  pipeline: PipelineConfig;
  context: Record<string, string>;
}): RunState {
  const { runId, pipeline, context } = args;
  if (pipeline.steps.length === 0) {
    throw new PipelineRunError(`Pipeline "${pipeline.id}" has no steps`);
  }
  const now = new Date().toISOString();

  // DAG roots: every step without a `depends_on` opens up at start time.
  // Pipelines without any depends_on declarations fall back to the legacy
  // sequential behavior (only step 0 starts) so existing workspace.yamls
  // keep their old semantics.
  const usesDag = pipeline.steps.some((s) => normalizeStep(s).depends_on.length > 0);
  const steps: StepRecord[] = pipeline.steps.map((s, idx) => {
    const norm = normalizeStep(s);
    const isRoot = usesDag ? norm.depends_on.length === 0 : idx === 0;
    return {
      stepIdx: idx,
      agent: norm.agent,
      // Recorded so the run can later be checked against the pipeline by
      // *which* step, not by position. Undefined when the step has no name,
      // which `stepIdentity` reads as "identified by agent alone".
      ...(norm.name === undefined ? {} : { name: norm.name }),
      revision: 1,
      status: isRoot ? 'awaiting_work' : 'pending',
      startedAt: isRoot ? now : undefined,
      artifactsProduced: [],
    };
  });

  // currentStepIdx tracks the UI's primary focus. For DAG runs we point it
  // at the first open step; the UI lets the user switch focus across active
  // steps but every gate operation passes an explicit stepIdx anyway.
  const firstOpen = steps.findIndex((s) => s.status === 'awaiting_work');
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId,
    pipelineId: pipeline.id,
    context: { ...context },
    startedAt: now,
    updatedAt: now,
    currentStepIdx: firstOpen >= 0 ? firstOpen : 0,
    status: 'running',
    steps,
  };
}

/**
 * Soft gate-check for a step's `requires`. Returns `{ ok: true }` when all
 * required upstream artifacts exist on disk, `{ ok: false, missing: [...] }`
 * otherwise. Used by the extension UI to surface a warning *before* the user
 * starts work on a step (e.g. show a banner / disable the "Mark step done"
 * button) — orthogonal to the hard-block at markStepDone time.
 *
 * Pure read-only — does not mutate state, does not throw.
 */
export function canStartStep(args: {
  state: RunState;
  pipeline: PipelineConfig;
  workspaceRoot: string;
  /** Defaults to the current step. */
  stepIdx?: number;
}): { ok: true } | { ok: false; missing: string[] } {
  const { state, pipeline, workspaceRoot } = args;
  const idx = args.stepIdx ?? state.currentStepIdx;
  const stepConfig = pipeline.steps[idx];
  if (!stepConfig) {
    return { ok: false, missing: [`(no step at index ${idx})`] };
  }
  const norm = normalizeStep(stepConfig);
  const missing: string[] = [];
  for (const rel of norm.requires.map((p) => resolvePath(p, state.context))) {
    const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * User clicked "Mark step done". Validate the current step's `requires` AND
 * `produces` paths exist relative to workspaceRoot. On success, transition to:
 *
 *   - `awaiting_auto_review` when `auto_review: true`  (validator pending)
 *   - `awaiting_review`      when `human_review: true` and no auto-review
 *   - `approved` + advance   when neither gate is configured
 *
 * Throws PipelineRunError with `missing` populated when artifacts aren't
 * found — caller surfaces this in the UI so the user can fix and retry.
 */
export function markStepDone(args: {
  state: RunState;
  pipeline: PipelineConfig;
  workspaceRoot: string;
  /** Step to mark done. Defaults to `state.currentStepIdx` for back-compat. */
  stepIdx?: number;
}): RunState {
  const { pipeline, workspaceRoot } = args;
  const state = alignedOrThrow(args.state, pipeline);
  const idx = args.stepIdx ?? state.currentStepIdx;
  const step = state.steps[idx];
  if (!step) {
    throw new PipelineRunError(`No step at index ${idx}`);
  }
  // Idempotency: a duplicate mark-done for a step already moved past
  // awaiting_work in this revision (CI retry, dashboard double-click, exec
  // reloading state) is a safe no-op — return current state untouched, no
  // double history-append, no double advance. `rejected` needs rerun (which
  // bumps revision) and `pending` is not yet startable, so both still error.
  if (
    step.status === 'awaiting_auto_review' ||
    step.status === 'awaiting_review' ||
    step.status === 'approved'
  ) {
    return clone(state);
  }
  if (step.status !== 'awaiting_work') {
    throw new PipelineRunError(
      `Cannot mark step "${step.agent}" done: status is "${step.status}", expected "awaiting_work"`,
    );
  }

  const stepConfig = pipeline.steps[idx];
  if (!stepConfig) {
    throw new PipelineRunError(
      `Pipeline mismatch — step "${stepIdentity(step)}" is at index ${idx}, ` +
      `which pipeline "${pipeline.id}" does not have.`,
    );
  }
  const norm = normalizeStep(stepConfig);

  // Hard gate-check on requires (separate from the soft check at start time).
  const resolvedRequires = norm.requires.map((p) => resolvePath(p, state.context));
  const missingRequires: string[] = [];
  for (const rel of resolvedRequires) {
    const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
    if (!fs.existsSync(abs)) { missingRequires.push(rel); }
  }
  if (missingRequires.length > 0) {
    throw new PipelineRunError(
      `Step "${step.agent}" is blocked — required upstream artifacts are missing.`,
      missingRequires,
    );
  }

  // Validate produces — each path resolved with run context, then existsSync.
  // An optional entry that is absent is not missing: it is left out of what
  // the step produced, so the content check and the drift check never see it.
  const optionalProduces = new Set(norm.produces_optional);
  const resolvedProduces: string[] = [];
  const missing: string[] = [];
  for (const p of norm.produces) {
    const rel = resolvePath(p, state.context);
    const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
    if (fs.existsSync(abs)) { resolvedProduces.push(rel); }
    else if (!optionalProduces.has(p)) { missing.push(rel); }
  }
  if (missing.length > 0) {
    throw new PipelineRunError(
      `Step "${step.agent}" has not produced its expected artifacts.`,
      missing,
    );
  }

  // Content assertions — each marker must appear in at least one produced file.
  // Catches "file exists but empty / missing a required section" without a JS validator.
  if (norm.produces_contains.length > 0) {
    const haystack = resolvedProduces
      .map((rel) => {
        const abs = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
        try {
          return fs.readFileSync(abs, 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
    const missingMarkers = norm.produces_contains.filter((marker) => !haystack.includes(marker));
    if (missingMarkers.length > 0) {
      throw new PipelineRunError(
        `Step "${step.agent}" produced its files but they are missing required content.`,
        missingMarkers,
      );
    }
  }

  const next = clone(state);
  const nextStep = next.steps[idx];
  nextStep.artifactsProduced = resolvedProduces;
  // Clear any prior verdict so the new run gets a fresh one.
  nextStep.autoReviewVerdict = undefined;

  if (norm.auto_review) {
    nextStep.status = 'awaiting_auto_review';
    next.status = 'running';
    return next;
  }

  if (norm.human_review) {
    nextStep.status = 'awaiting_review';
    next.status = 'running';
    return next;
  }

  // Neither gate — auto-approve + advance.
  return advance(next, idx, pipeline);
}

/** Statuses a step can be undone *from* — the ones `markStepDone` produces. */
const UNDOABLE_STATUSES: StepStatus[] = ['awaiting_auto_review', 'awaiting_review', 'approved'];

/**
 * The steps an approval of `idx` would have opened: the next one on a
 * sequential pipeline, the direct dependents on a DAG.
 *
 * Direct dependents are enough for the undo below. A transitive descendant can
 * only have been opened through one of these, so if they are all still sitting
 * at `awaiting_work`, nothing further down has been reached.
 */
function followersOf(pipeline: PipelineConfig, idx: number): number[] {
  const normalized = pipeline.steps.map(normalizeStep);
  const usesDag = normalized.some((s) => s.depends_on.length > 0);
  if (!usesDag) {
    return idx + 1 < normalized.length ? [idx + 1] : [];
  }
  const dagId = normalized[idx] ? (normalized[idx].name ?? normalized[idx].agent) : undefined;
  if (dagId === undefined) { return []; }
  const out: number[] = [];
  normalized.forEach((s, i) => {
    if (s.depends_on.includes(dagId)) { out.push(i); }
  });
  return out;
}

/**
 * Whether a "Mark step done" can still be taken back — and, when it cannot,
 * the sentence to show the user.
 *
 * Undo is for the misclick: the button that advances the run sits next to the
 * one that starts it, and the only way back used to be `requestStepUpdate`,
 * which bumps the revision and resets every downstream step. That is the right
 * tool when requirements changed and the wrong one when nothing happened at
 * all except the wrong click.
 *
 * So the rule is narrow on purpose: the step must still be sitting where
 * mark-done left it, and nothing it opened may have moved. The moment a
 * follower has produced anything, this stops being an undo — the run has
 * history to rewind, and that is `requestStepUpdate`'s job.
 *
 * Pure, never throws — the UI calls it to decide whether to offer the button.
 */
export function canUndoStepDone(args: {
  state: RunState;
  pipeline: PipelineConfig;
  /** Defaults to the current step. */
  stepIdx?: number;
}): { ok: true } | { ok: false; reason: string } {
  const { state, pipeline } = args;
  const idx = args.stepIdx ?? state.currentStepIdx;
  const step = state.steps[idx];
  if (!step) { return { ok: false, reason: `No step at index ${idx}` }; }
  if (!reconcileRunSteps(state, pipeline).aligned) {
    return {
      ok: false,
      reason: `Run "${state.runId}" no longer matches pipeline "${pipeline.id}" — ` +
        'reconcile it before undoing anything.',
    };
  }
  if (!UNDOABLE_STATUSES.includes(step.status)) {
    return {
      ok: false,
      reason: `Step "${stepIdentity(step)}" is "${step.status}" — there is no "mark done" to undo.`,
    };
  }
  if (step.status === 'approved') {
    for (const i of followersOf(pipeline, idx)) {
      const follower = state.steps[i];
      if (!follower || follower.status === 'pending') { continue; }
      const untouched = follower.status === 'awaiting_work' && follower.artifactsProduced.length === 0;
      if (!untouched) {
        return {
          ok: false,
          reason: `Step ${i + 1} ("${stepIdentity(follower)}") has already moved on ` +
            `(${follower.status}) — undo would silently discard it. Use "Request update" instead.`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Take back a "Mark step done": the step goes back to `awaiting_work` at the
 * same revision, and anything the advance opened closes again.
 *
 * Deliberately *not* a rerun. The revision stays put, the carried feedback
 * stays put, and no artifact is touched on disk — the click is undone, not the
 * work. What it does record is an `undo` history entry, because the timeline is
 * append-only and an approve that vanished without a trace is worse than one
 * that is explained.
 *
 * Throws {@link PipelineRunError} with {@link canUndoStepDone}'s reason when
 * the undo is no longer safe.
 */
export function undoStepDone(args: {
  state: RunState;
  pipeline: PipelineConfig;
  /** Step to un-mark. Defaults to `state.currentStepIdx`. */
  stepIdx?: number;
}): RunState {
  const { pipeline } = args;
  const state = alignedOrThrow(args.state, pipeline);
  const idx = args.stepIdx ?? state.currentStepIdx;
  const gate = canUndoStepDone({ state, pipeline, stepIdx: idx });
  if (!gate.ok) { throw new PipelineRunError(gate.reason); }

  const step = state.steps[idx];
  const now = new Date().toISOString();
  const next = clone(state);

  if (step.status === 'approved') {
    for (const i of followersOf(pipeline, idx)) {
      const follower = next.steps[i];
      // `pending` followers were never opened; the guard above has already
      // ruled out anything further along.
      if (!follower || follower.status !== 'awaiting_work') { continue; }
      next.steps[i] = { ...follower, status: 'pending', startedAt: undefined };
    }
  }

  next.steps[idx] = {
    ...next.steps[idx],
    status: 'awaiting_work',
    finishedAt: undefined,
    artifactsProduced: [],
    autoReviewVerdict: undefined,
    // `startedAt` stays: this is the same attempt at the same step, and the
    // panel dates the artifact against it to tell "written for this step" from
    // "inherited from an earlier one".
    history: pushHistory(step.history, {
      kind: 'undo',
      at: now,
      revision: step.revision,
      from: step.status,
    }),
  };
  next.currentStepIdx = idx;
  next.status = 'running';
  return next;
}

/**
 * Apply an auto-reviewer verdict to the current `awaiting_auto_review` step.
 *
 *   - decision: 'pass' + step has `human_review: true`  → `awaiting_review`
 *   - decision: 'pass' + no human gate                  → approve + advance
 *   - decision: 'reject'                                → `rejected` + reason
 *
 * The verdict is also stored on the step record so the human reviewer (and
 * the rerun flow) can see why the validator failed.
 */
export function submitAutoReviewVerdict(args: {
  state: RunState;
  pipeline: PipelineConfig;
  verdict: AutoReviewVerdict;
  /** Step the verdict applies to. Defaults to `state.currentStepIdx`. */
  stepIdx?: number;
}): RunState {
  const { pipeline, verdict } = args;
  const state = alignedOrThrow(args.state, pipeline);
  const idx = args.stepIdx ?? state.currentStepIdx;
  const step = state.steps[idx];
  if (!step) {
    throw new PipelineRunError(`No step at index ${idx}`);
  }
  if (step.status !== 'awaiting_auto_review') {
    throw new PipelineRunError(
      `Cannot submit auto-review verdict for step "${step.agent}": status is "${step.status}", expected "awaiting_auto_review"`,
    );
  }

  const stepConfig = pipeline.steps[idx];
  if (!stepConfig) {
    throw new PipelineRunError(
      `Pipeline mismatch — step "${stepIdentity(step)}" is at index ${idx}, ` +
      `which pipeline "${pipeline.id}" does not have.`,
    );
  }
  const norm = normalizeStep(stepConfig);

  const next = clone(state);
  const nextStep = next.steps[idx];
  nextStep.autoReviewVerdict = verdict;
  nextStep.history = pushHistory(nextStep.history, {
    kind: 'auto_review',
    at: verdict.at,
    revision: nextStep.revision,
    decision: verdict.decision,
    reason: verdict.reason,
    runner: verdict.runner,
  });

  if (verdict.decision === 'reject') {
    nextStep.status = 'rejected';
    nextStep.rejectReason = verdict.reason;
    nextStep.history = pushHistory(nextStep.history, {
      kind: 'reject',
      at: verdict.at,
      revision: nextStep.revision,
      reason: verdict.reason,
      sentBackToIdx: idx,
      ...(nextStep.skill ? { skill: nextStep.skill } : {}),
    });
    next.status = 'running';
    settleOptionalRejection(next, idx, pipeline);
    return next;
  }

  // pass
  if (norm.human_review) {
    nextStep.status = 'awaiting_review';
    next.status = 'running';
    return next;
  }

  return advance(next, idx, pipeline);
}

/**
 * Put an auto-review-rejected step back in front of its validator.
 *
 * `rerunStep` is the wrong tool when the verdict is the only thing wrong:
 * it bumps the revision and drops `artifactsProduced`, which says "redo the
 * work". Often the work is fine — the artifact was edited by hand since, or
 * the agent that produced it is still writing, or the validator itself was
 * fixed — and all that is wanted is the check again. So this rewinds exactly
 * one transition, `rejected` → `awaiting_auto_review`, keeping the revision,
 * the artifacts and the history, and clearing only the verdict it is about
 * to replace.
 *
 * Refuses a step a human rejected, or one whose last verdict was a pass:
 * re-running a validator that already passed cannot advance the run, and a
 * human's rejection is not a validator's to overturn.
 */
export function retryAutoReview(args: {
  state: RunState;
  pipeline: PipelineConfig;
  /** Step to re-verify. Defaults to `state.currentStepIdx`. */
  stepIdx?: number;
}): RunState {
  const { pipeline } = args;
  const state = alignedOrThrow(args.state, pipeline);
  const idx = args.stepIdx ?? state.currentStepIdx;
  const step = state.steps[idx];
  if (!step) {
    throw new PipelineRunError(`No step at index ${idx}`);
  }
  if (step.status !== 'rejected') {
    throw new PipelineRunError(
      `Cannot re-run auto-review for step "${step.agent}": status is "${step.status}", expected "rejected"`,
    );
  }
  if (step.autoReviewVerdict?.decision !== 'reject') {
    throw new PipelineRunError(
      `Step "${step.agent}" was not rejected by its auto-reviewer — rerun it instead.`,
    );
  }
  const stepConfig = pipeline.steps[idx];
  if (!stepConfig) {
    throw new PipelineRunError(
      `Pipeline mismatch — step "${stepIdentity(step)}" is at index ${idx}, ` +
      `which pipeline "${pipeline.id}" does not have.`,
    );
  }
  if (!normalizeStep(stepConfig).auto_review) {
    throw new PipelineRunError(
      `Step "${step.agent}" no longer has auto_review enabled in pipeline "${pipeline.id}".`,
    );
  }

  const next = clone(state);
  next.steps[idx] = {
    ...step,
    status: 'awaiting_auto_review',
    rejectReason: undefined,
    autoReviewVerdict: undefined,
  };
  // `currentStepIdx` is deliberately left where it is: on a DAG pipeline the
  // cursor may sit on a sibling that is still working, and re-verifying this
  // step is no reason to drag it away.
  next.status = 'running';
  return next;
}

/** Human approved the awaiting_review step → advance to next. */
export function approveStep(args: {
  state: RunState;
  pipeline: PipelineConfig;
  /** Step to approve. Defaults to `state.currentStepIdx`. */
  stepIdx?: number;
}): RunState {
  const { pipeline } = args;
  const state = alignedOrThrow(args.state, pipeline);
  const idx = args.stepIdx ?? state.currentStepIdx;
  const step = state.steps[idx];
  if (!step) {
    throw new PipelineRunError(`No step at index ${idx}`);
  }
  if (step.status !== 'awaiting_review') {
    throw new PipelineRunError(
      `Cannot approve step "${step.agent}": status is "${step.status}", expected "awaiting_review"`,
    );
  }
  return advance(clone(state), idx, pipeline);
}

/**
 * Human rejected the awaiting_review step.
 *
 * Two modes:
 *   - In-place (default, `targetIdx` omitted or === currentStepIdx): the
 *     current step transitions to `rejected`. The user clicks Rerun to bump
 *     revision and try again on the same step.
 *   - Cascade upstream (`targetIdx < currentStepIdx`): the work needs to go
 *     back to an earlier step (e.g. PRD missing a requirement caught at
 *     review time). The target step is reset to `awaiting_work` with
 *     revision++, intermediate steps + the rejected current step are reset
 *     to `pending` and lose their artifacts/verdicts. The reject reason is
 *     copied into the target step's `feedback` so the user has context when
 *     they redo upstream work. `currentStepIdx` rewinds to the target.
 */
export function rejectStep(args: {
  state: RunState;
  reason?: string;
  targetIdx?: number;
  /** Step being rejected. Defaults to `state.currentStepIdx`. */
  stepIdx?: number;
  /**
   * Pipeline definition. When supplied and the pipeline uses `depends_on`,
   * cascade-reject resets only the *transitive descendants* of the target
   * step (DAG semantics) instead of the contiguous index range — index
   * positions in a DAG don't reflect dependency order.
   */
  pipeline?: PipelineConfig;
}): RunState {
  const { state, reason, targetIdx, pipeline } = args;
  const idx = args.stepIdx ?? state.currentStepIdx;
  const step = state.steps[idx];
  if (!step) {
    throw new PipelineRunError(`No step at index ${idx}`);
  }
  if (step.status !== 'awaiting_review') {
    throw new PipelineRunError(
      `Cannot reject step "${step.agent}": status is "${step.status}", expected "awaiting_review"`,
    );
  }

  const now = new Date().toISOString();
  const isCascade = typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < idx;
  if (isCascade) {
    const next = clone(state);
    const blame = `Rejected at step ${idx + 1} (${step.agent})${reason ? `: ${reason}` : ''}`;
    const rejectedHistory = pushHistory(next.steps[idx].history, {
      kind: 'reject',
      at: now,
      revision: next.steps[idx].revision,
      reason,
      sentBackToIdx: targetIdx as number,
      ...(next.steps[idx].skill ? { skill: next.steps[idx].skill } : {}),
    });

    // Choose between sequential index-range and DAG transitive-descendants
    // reset based on whether the pipeline declares any depends_on edges.
    const usesDag = pipeline
      ? pipeline.steps.map(normalizeStep).some((s) => s.depends_on.length > 0)
      : false;
    const targetIdxN = targetIdx as number;
    const resetIndices = usesDag && pipeline
      ? collectDagResetSet(pipeline, state, targetIdxN, idx)
      : sequentialRange(targetIdxN, idx);

    for (const i of resetIndices) {
      const s = next.steps[i];
      if (i === targetIdxN) {
        // Target step: bump revision + reset to awaiting_work. Record the
        // cascade-rerun on its own history.
        const newRev = s.revision + 1;
        next.steps[i] = {
          ...s,
          status: 'awaiting_work',
          revision: newRev,
          feedback: blame,
          rejectReason: undefined,
          autoReviewVerdict: undefined,
          artifactsProduced: [],
          finishedAt: undefined,
          startedAt: now,
          history: pushHistory(s.history, {
            kind: 'rerun',
            at: now,
            revision: newRev,
            feedback: blame,
          }),
        };
      } else if (i === idx) {
        // The rejected step keeps its full history + the new reject entry,
        // even though we're about to reset its working fields.
        next.steps[i] = {
          ...s,
          status: 'pending',
          rejectReason: undefined,
          autoReviewVerdict: undefined,
          artifactsProduced: [],
          startedAt: undefined,
          finishedAt: undefined,
          history: rejectedHistory,
        };
      } else {
        // Intermediate step (target < i < idx). Reset to pending, history
        // preserved as-is — these steps weren't directly involved in this
        // rejection.
        next.steps[i] = {
          ...s,
          status: 'pending',
          rejectReason: undefined,
          autoReviewVerdict: undefined,
          artifactsProduced: [],
          startedAt: undefined,
          finishedAt: undefined,
        };
      }
    }
    next.currentStepIdx = targetIdx as number;
    next.status = 'running';
    return next;
  }

  const next = clone(state);
  next.steps[idx] = {
    ...step,
    status: 'rejected',
    rejectReason: reason ?? '',
    history: pushHistory(step.history, {
      kind: 'reject',
      at: now,
      revision: step.revision,
      reason,
      sentBackToIdx: idx,
      ...(step.skill ? { skill: step.skill } : {}),
    }),
  };
  next.status = 'running';
  if (pipeline) { settleOptionalRejection(next, idx, pipeline); }
  return next;
}

/**
 * User wants to retry a rejected step (presumably after re-reading
 * `feedback`). Resets the step to awaiting_work and bumps revision.
 * Optional `feedback` is stored on the step record so the user can keep
 * track of what they're addressing this time.
 */
export function rerunStep(args: {
  state: RunState;
  feedback?: string;
  /** Step to rerun. Defaults to `state.currentStepIdx`. */
  stepIdx?: number;
}): RunState {
  const { state, feedback } = args;
  const idx = args.stepIdx ?? state.currentStepIdx;
  const step = state.steps[idx];
  if (!step) {
    throw new PipelineRunError(`No step at index ${idx}`);
  }
  if (step.status !== 'rejected') {
    throw new PipelineRunError(
      `Cannot rerun step "${step.agent}": status is "${step.status}", expected "rejected"`,
    );
  }
  const now = new Date().toISOString();
  const next = clone(state);
  const newRev = step.revision + 1;
  const carriedFeedback = feedback ?? step.feedback;
  next.steps[idx] = {
    ...step,
    status: 'awaiting_work',
    revision: newRev,
    feedback: carriedFeedback,
    rejectReason: undefined,
    artifactsProduced: [],
    startedAt: now,
    history: pushHistory(step.history, {
      kind: 'rerun',
      at: now,
      revision: newRev,
      feedback: carriedFeedback,
    }),
  };
  next.status = 'running';
  return next;
}

/**
 * Pick which of a step's alternative skills (`default_skill`) it runs next.
 *
 * Only the choice moves: status, revision and history stay as they are — the
 * history records a skill once its output is judged, not when it is picked.
 * Refused for a step with no alternatives, and for a skill not among them.
 */
export function chooseStepSkill(args: {
  state: RunState;
  pipeline: PipelineConfig;
  stepIdx: number;
  skill: string;
}): RunState {
  const { state, pipeline, stepIdx, skill } = args;
  if (!Number.isInteger(stepIdx) || stepIdx < 0 || stepIdx >= state.steps.length) {
    throw new PipelineRunError(`Invalid stepIdx ${stepIdx}`);
  }
  const target = state.steps[stepIdx];
  const cfg = pipeline.steps[target.stepIdx];
  const alt = cfg ? stepSkillAlternatives(normalizeStep(cfg)) : undefined;
  if (!alt) {
    throw new PipelineRunError(`Step "${target.agent}" has no alternative skills to choose from.`);
  }
  if (!alt.options.includes(skill)) {
    throw new PipelineRunError(
      `Skill "${skill}" is not one of step "${target.agent}"'s alternatives (${alt.options.join(', ')}).`,
    );
  }
  const next = clone(state);
  next.steps[stepIdx] = { ...target, skill };
  return next;
}

/**
 * Request an update on a previously-approved step. Triggered by the user
 * outside the awaiting_review flow when requirements change after the step
 * was approved (or after the run already moved past it). Behaves like a
 * cascade reject but is callable from any current state:
 *
 *   - The targeted step rewinds to `awaiting_work` with revision++ and the
 *     supplied feedback carried forward (so the next agent run sees what
 *     changed).
 *   - All steps downstream of the target up to the current step (or end of
 *     pipeline if the run already completed) are reset to `pending`,
 *     losing their artifactsProduced / verdicts. Their history is
 *     preserved — UI can show "previously done, awaiting update".
 *   - currentStepIdx rewinds to the target step.
 *   - The whole run flips to `running` if it was completed.
 *
 * History on the target step records both a `rerun` entry (since revision
 * bumps) for symmetry with the regular rerun flow, so the audit trail
 * answers the question "why did this step get redone?".
 */
export function requestStepUpdate(args: {
  state: RunState;
  pipeline: PipelineConfig;
  stepIdx: number;
  feedback?: string;
}): RunState {
  const { state, pipeline, stepIdx, feedback } = args;
  if (
    !Number.isInteger(stepIdx) ||
    stepIdx < 0 ||
    stepIdx >= state.steps.length
  ) {
    throw new PipelineRunError(`Invalid stepIdx ${stepIdx}`);
  }
  const target = state.steps[stepIdx];
  if (target.status !== 'approved') {
    throw new PipelineRunError(
      `Cannot request update on step "${target.agent}": status is "${target.status}", expected "approved"`,
    );
  }

  const now = new Date().toISOString();
  const next = clone(state);

  const normalized = pipeline.steps.map(normalizeStep);
  const usesDag = normalized.some((s) => s.depends_on.length > 0);
  // For DAG pipelines, walk only transitive descendants. For sequential,
  // fall back to the legacy "everything from stepIdx through upper" range so
  // existing workspace.yamls keep their old semantics.
  const upper = state.status === 'completed'
    ? pipeline.steps.length - 1
    : state.currentStepIdx;
  const indices = usesDag
    ? collectDagResetSet(pipeline, state, stepIdx, upper)
    : sequentialRange(stepIdx, upper);

  for (const i of indices) {
    const s = next.steps[i];
    if (i === stepIdx) {
      const newRev = s.revision + 1;
      next.steps[i] = {
        ...s,
        status: 'awaiting_work',
        revision: newRev,
        feedback: feedback ?? s.feedback,
        rejectReason: undefined,
        autoReviewVerdict: undefined,
        artifactsProduced: [],
        finishedAt: undefined,
        startedAt: now,
        history: pushHistory(s.history, {
          kind: 'rerun',
          at: now,
          revision: newRev,
          feedback: feedback ?? s.feedback,
        }),
      };
    } else {
      // Downstream step — reset to pending, KEEP history so the UI can
      // distinguish "previously done, awaiting update" from "never reached".
      next.steps[i] = {
        ...s,
        status: 'pending',
        rejectReason: undefined,
        autoReviewVerdict: undefined,
        artifactsProduced: [],
        startedAt: undefined,
        finishedAt: undefined,
      };
    }
  }
  next.currentStepIdx = stepIdx;
  next.status = 'running';
  return next;
}

/**
 * Every step that transitively depends on `idx`, in ascending order.
 *
 * On a DAG these are the steps reachable by following `depends_on` edges
 * forwards. On a pipeline that declares no `depends_on` anywhere, the graph is
 * the implicit chain the runner advances along, so "downstream" is simply
 * every later index — the same reading {@link followersOf} and
 * {@link requestStepUpdate} already take of a sequential pipeline.
 *
 * Excludes `idx` itself.
 */
function descendantsOf(pipeline: PipelineConfig, idx: number): number[] {
  const normalized = pipeline.steps.map(normalizeStep);
  const usesDag = normalized.some((s) => s.depends_on.length > 0);
  if (!usesDag) {
    return sequentialRange(idx + 1, normalized.length - 1);
  }
  const idxByDagId = new Map<string, number>();
  normalized.forEach((s, i) => { idxByDagId.set(s.name ?? s.agent, i); });
  const found = new Set<number>([idx]);
  // Fixed point: a step joins the set once any of its deps is in it. O(n²)
  // at worst, which is nothing at the size real pipelines run to.
  let changed = true;
  while (changed) {
    changed = false;
    normalized.forEach((s, i) => {
      if (found.has(i)) { return; }
      if (s.depends_on.some((dep) => {
        const di = idxByDagId.get(dep);
        return di !== undefined && found.has(di);
      })) {
        found.add(i);
        changed = true;
      }
    });
  }
  found.delete(idx);
  return Array.from(found).sort((a, b) => a - b);
}

/**
 * The mirror of {@link descendantsOf}: every step `idx` transitively depends
 * on, in ascending order, excluding `idx`.
 */
function ancestorsOf(pipeline: PipelineConfig, idx: number): number[] {
  const normalized = pipeline.steps.map(normalizeStep);
  const usesDag = normalized.some((s) => s.depends_on.length > 0);
  if (!usesDag) {
    return sequentialRange(0, idx - 1);
  }
  const idxByDagId = new Map<string, number>();
  normalized.forEach((s, i) => { idxByDagId.set(s.name ?? s.agent, i); });
  const found = new Set<number>();
  const queue = [idx];
  while (queue.length > 0) {
    const cur = queue.pop() as number;
    for (const dep of normalized[cur]?.depends_on ?? []) {
      const di = idxByDagId.get(dep);
      if (di === undefined || found.has(di) || di === idx) { continue; }
      found.add(di);
      queue.push(di);
    }
  }
  return Array.from(found).sort((a, b) => a - b);
}

/**
 * The approved-but-suspect steps upstream of `idx` — what a warning shown
 * before working on `idx` should name.
 *
 * Reads the marks {@link rerunApprovedStep} left; it does not re-derive
 * staleness from timestamps, because the question "was this step's input
 * redone under it" is a fact about what the user did, not about file mtimes.
 *
 * Pure, never throws — every surface that offers to start a step calls it.
 */
export function dirtyUpstreamOf(args: {
  state: RunState;
  pipeline: PipelineConfig;
  stepIdx: number;
}): Array<{ stepIdx: number; step: string; dirty: StepDirtyMark }> {
  const { state, pipeline, stepIdx } = args;
  if (!state.steps[stepIdx]) { return []; }
  const out: Array<{ stepIdx: number; step: string; dirty: StepDirtyMark }> = [];
  for (const i of ancestorsOf(pipeline, stepIdx)) {
    const s = state.steps[i];
    if (!s?.dirty) { continue; }
    out.push({ stepIdx: i, step: stepIdentity(s), dirty: s.dirty });
  }
  return out;
}

/**
 * Whether a step that already passed can be rerun — and, when it cannot, the
 * sentence to show the user.
 *
 * Pure, never throws; the UI calls it to decide whether to offer the button.
 */
export function canRerunApprovedStep(args: {
  state: RunState;
  pipeline: PipelineConfig;
  /** Defaults to the current step. */
  stepIdx?: number;
}): { ok: true } | { ok: false; reason: string } {
  const { state, pipeline } = args;
  const idx = args.stepIdx ?? state.currentStepIdx;
  const step = state.steps[idx];
  if (!step) { return { ok: false, reason: `No step at index ${idx}` }; }
  if (!reconcileRunSteps(state, pipeline).aligned) {
    return {
      ok: false,
      reason: `Run "${state.runId}" no longer matches pipeline "${pipeline.id}" — ` +
        'reconcile it before rerunning anything.',
    };
  }
  if (step.status !== 'approved') {
    return {
      ok: false,
      reason: step.status === 'awaiting_review' || step.status === 'awaiting_auto_review'
        ? `Step "${stepIdentity(step)}" has not been approved yet — take the ` +
          'mark-done back with "Undo" instead.'
        : `Step "${stepIdentity(step)}" is "${step.status}", not "approved" — ` +
          'there is nothing to rerun.',
    };
  }
  return { ok: true };
}

/**
 * Redo a step that already passed, keeping everything built on top of it.
 *
 * The case this exists for: the step's prompt changed, so its output should be
 * regenerated — but the steps that consumed that output are done, and some of
 * them cost real work. {@link requestStepUpdate} answers this by resetting
 * every descendant to `pending`, which is correct when the change invalidates
 * them and far too much when the user only wants to see what the new prompt
 * produces.
 *
 * So this rewinds the target alone. Descendants that were already approved
 * keep their status, their artifacts and their history, and gain a
 * {@link StepRecord.dirty} mark: still done, but done against an input that
 * has since moved. Nothing is blocked by the mark — `dirty` means done — it
 * only gives the surfaces downstream something honest to warn with (see
 * {@link dirtyUpstreamOf}). Descendants that had not been approved are left
 * exactly as they were: a step still `awaiting_work` has nothing to
 * invalidate, and closing it would be the reset this function exists to avoid.
 *
 * A dirty mark is cleared only by that step being approved again — redoing the
 * target does not clear it, because the dirty step still has not seen the new
 * output.
 *
 * Throws {@link PipelineRunError} with {@link canRerunApprovedStep}'s reason
 * when the rerun is not available.
 */
export function rerunApprovedStep(args: {
  state: RunState;
  pipeline: PipelineConfig;
  /** Step to rerun. Defaults to `state.currentStepIdx`. */
  stepIdx?: number;
  /** Optional note carried onto the step, as on the other rerun paths. */
  feedback?: string;
}): RunState {
  const { pipeline, feedback } = args;
  const state = alignedOrThrow(args.state, pipeline);
  const idx = args.stepIdx ?? state.currentStepIdx;
  const gate = canRerunApprovedStep({ state, pipeline, stepIdx: idx });
  if (!gate.ok) { throw new PipelineRunError(gate.reason); }

  const step = state.steps[idx];
  const now = new Date().toISOString();
  const next = clone(state);
  const newRev = step.revision + 1;
  const carriedFeedback = feedback ?? step.feedback;

  next.steps[idx] = {
    ...step,
    status: 'awaiting_work',
    revision: newRev,
    feedback: carriedFeedback,
    rejectReason: undefined,
    autoReviewVerdict: undefined,
    // The target is being redone, so whatever made *it* suspect is moot.
    dirty: undefined,
    artifactsProduced: [],
    finishedAt: undefined,
    startedAt: now,
    history: pushHistory(step.history, {
      kind: 'rerun',
      at: now,
      revision: newRev,
      feedback: carriedFeedback,
    }),
  };

  const mark: StepDirtyMark = {
    since: now,
    byStepIdx: idx,
    byStep: stepIdentity(step),
    byRevision: newRev,
  };
  for (const i of descendantsOf(pipeline, idx)) {
    const d = next.steps[i];
    if (!d || d.status !== 'approved') { continue; }
    next.steps[i] = {
      ...d,
      dirty: mark,
      history: pushHistory(d.history, {
        kind: 'dirty',
        at: now,
        revision: d.revision,
        byStep: mark.byStep,
        byStepIdx: idx,
      }),
    };
  }

  next.currentStepIdx = idx;
  next.status = 'running';
  return next;
}

/**
 * Mark the given step approved, then open every now-unblocked dependent
 * step.
 *
 * For pipelines that don't use `depends_on`, this preserves the legacy
 * sequential behavior: approving step N opens step N+1. For DAG pipelines,
 * approving a step unblocks every pending step whose `depends_on` agents
 * are all approved — multiple may open at once.
 *
 * The run transitions to `completed` once every step is settled — approved,
 * or an `optional` step the run gave up on (see {@link isRunComplete}).
 */
function advance(next: RunState, idx: number, pipeline: PipelineConfig): RunState {
  const finishedAt = new Date().toISOString();
  const approved = next.steps[idx];
  next.steps[idx] = {
    ...approved,
    status: 'approved',
    finishedAt,
    // The step has now run against whatever its input currently is, so the
    // mark an upstream rerun left on it no longer describes anything. This is
    // the only thing that clears it.
    dirty: undefined,
    history: pushHistory(approved.history, {
      kind: 'approve',
      at: finishedAt,
      revision: approved.revision,
      ...(approved.skill ? { skill: approved.skill } : {}),
    }),
  };

  const normalized = pipeline.steps.map(normalizeStep);
  const usesDag = normalized.some((s) => s.depends_on.length > 0);

  if (!usesDag) {
    // Legacy sequential pipeline: open the immediately-following step.
    const nextIdx = idx + 1;
    if (nextIdx >= pipeline.steps.length) {
      next.status = 'completed';
      return next;
    }
    next.currentStepIdx = nextIdx;
    next.steps[nextIdx] = {
      ...next.steps[nextIdx],
      status: 'awaiting_work',
      startedAt: finishedAt,
    };
    next.status = 'running';
    return next;
  }

  // DAG: open every pending step whose deps are now all approved.
  // Match deps against the step's `name` (phase id) when present and fall
  // back to `agent` (persona id) — this lets multiple steps sharing a
  // persona stay distinct in the dependency graph (e.g. `test-plan` ⤴
  // from `plan`, `test-cases` ⤴ from `test-plan`, both backed by the
  // `aidlc-qa` persona).
  const dagId = (i: number): string => normalized[i].name ?? normalized[i].agent;
  const approvedDagIds = new Set(
    next.steps
      .filter((s) => s.status === 'approved')
      .map((s) => dagId(s.stepIdx)),
  );
  const opened: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const sStep = next.steps[i];
    if (sStep.status !== 'pending') { continue; }
    const deps = normalized[i].depends_on;
    if (deps.length === 0) { continue; }
    const ready = deps.every((dep) => approvedDagIds.has(dep));
    if (!ready) { continue; }
    next.steps[i] = {
      ...sStep,
      status: 'awaiting_work',
      startedAt: finishedAt,
    };
    opened.push(i);
  }

  if (isRunComplete(next, pipeline)) {
    next.status = 'completed';
    return next;
  }

  refocusCursor(next, opened);
  next.status = 'running';
  return next;
}

/**
 * Point the primary cursor at something actionable when it is sitting on a
 * step that has settled — the one just approved, or a rejection the run has
 * already walked around.
 *
 * The rejection case is the bug this exists for. The cursor used to move only
 * when it pointed at the step being approved, so a run that rejected a side
 * branch and then approved its sibling left the cursor on the rejection for
 * good: CR-Y01 read as `rejected` at step 2 of 9 while its work had reached
 * step 6, because every surface reads the cursor for "where is this run".
 *
 * `opened` are the steps this advance unblocked — the natural next focus.
 * Falling back to the first still-active step covers the advance that opened
 * nothing because a parallel sibling is already carrying the run.
 */
function refocusCursor(next: RunState, opened: number[]): void {
  const cur = next.steps[next.currentStepIdx];
  if (cur && cur.status !== 'approved' && cur.status !== 'rejected') { return; }
  const target = opened.length > 0
    ? Math.min(...opened)
    : next.steps.findIndex((s) => isActiveStatus(s.status));
  if (target >= 0) { next.currentStepIdx = target; }
}

/**
 * Let the run walk past a rejection on an `optional: true` step.
 *
 * The flag says the author is willing to lose this step's output, so the
 * rejection is an outcome rather than a stop: the cursor moves to whatever is
 * still open, and the run may complete without it ({@link isRunComplete}).
 *
 * On a sequential pipeline the following step is opened here, because nothing
 * else will open it — advance() only runs on an approval. On a DAG, steps that
 * declare `depends_on` this one stay `pending` on purpose: they were promised
 * an artifact that is not coming. Independent branches are already open and
 * carry the run by themselves.
 *
 * No-op for a step that is not optional — a rejection the run needs is worth
 * keeping the cursor on.
 */
function settleOptionalRejection(next: RunState, idx: number, pipeline: PipelineConfig): void {
  if (!isStepOptional(pipeline, idx)) { return; }
  const normalized = pipeline.steps.map(normalizeStep);
  const usesDag = normalized.some((s) => s.depends_on.length > 0);
  if (!usesDag) {
    const follower = next.steps[idx + 1];
    if (follower && follower.status === 'pending') {
      next.steps[idx + 1] = {
        ...follower,
        status: 'awaiting_work',
        startedAt: new Date().toISOString(),
      };
    }
  }
  refocusCursor(next, []);
  if (isRunComplete(next, pipeline)) { next.status = 'completed'; }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Inclusive numeric range `[from, to]`. Returns [] when `from > to`. */
function sequentialRange(from: number, to: number): number[] {
  if (from > to) { return []; }
  const out: number[] = [];
  for (let i = from; i <= to; i++) { out.push(i); }
  return out;
}

/**
 * Compute the set of step indices to reset on a DAG cascade rewind.
 *
 * Includes the target step itself and every step that transitively depends
 * (via `depends_on`) on the target — those need to be redone once the
 * target's output changes. The rejected step (`fromIdx`, if different from
 * target) is always included so its state is cleared too. Indices are
 * returned in ascending order so the caller can iterate left-to-right.
 */
function collectDagResetSet(
  pipeline: PipelineConfig,
  state: RunState,
  targetIdx: number,
  fromIdx: number,
): number[] {
  const normalized = pipeline.steps.map(normalizeStep);
  // Match deps by step `name` (phase id) when available; persona-id
  // (`agent`) is the fallback for legacy pipelines where steps didn't
  // carry a separate name.
  const idxByDagId = new Map<string, number>();
  normalized.forEach((s, i) => { idxByDagId.set(s.name ?? s.agent, i); });

  const toReset = new Set<number>([targetIdx, fromIdx]);
  // Iteratively expand: a step is in the reset set if any of its deps is in
  // the set. Loop until fixed point — at most O(steps²) which is fine for
  // typical workflows (<20 steps).
  let changed = true;
  while (changed) {
    changed = false;
    normalized.forEach((s, i) => {
      if (toReset.has(i)) { return; }
      // Only consider steps that actually ran; pending ones don't need reset.
      if (state.steps[i]?.status === 'pending') { return; }
      const depsHit = s.depends_on.some((dep) => {
        const di = idxByDagId.get(dep);
        return di !== undefined && toReset.has(di);
      });
      if (depsHit) { toReset.add(i); changed = true; }
    });
  }
  return Array.from(toReset).sort((a, b) => a - b);
}

function pushHistory(
  existing: StepHistoryEntry[] | undefined,
  entry: StepHistoryEntry,
): StepHistoryEntry[] {
  return existing ? [...existing, entry] : [entry];
}
