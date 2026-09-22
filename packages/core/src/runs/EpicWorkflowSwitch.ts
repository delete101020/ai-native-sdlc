/**
 * Changing the workflow an epic runs, while it is still safe to change it.
 *
 * The recipe is picked at the very start, from a one-line brief and before
 * anybody has read the epic properly — which is exactly when the choice is
 * least informed. Until this module the choice was final: `state.json` named a
 * pipeline, `pipeline.yaml` held it, and `.aidlc/runs/<id>.json` had already
 * laid out one record per step. Getting it wrong meant deleting the epic and
 * starting again under a new id, or hand-editing three files that are keyed to
 * each other by position.
 *
 * ## The window
 *
 * A switch throws the run's step records away and lays out new ones, so it is
 * only offered while those records say nothing worth keeping: every step still
 * `pending` or `awaiting_work`, at revision 1, with no history, no produced
 * artifacts, and the run itself still `running`. That is the state
 * {@link startRun} leaves behind and nothing else does — the first approval,
 * rejection or rerun closes the window for good. {@link epicWorkflowLock} is
 * the single place that decision is made, and it answers with *why* rather
 * than a boolean so every front door can say the same sentence.
 *
 * After that point {@link planAddEpicStep} / {@link planRemoveEpicStep} are
 * the way to reshape an epic: they splice both stores together and keep the
 * history pointing at the step it was always about. This module deliberately
 * does not: re-deriving twelve steps from a different recipe has no honest
 * mapping onto records of work that already happened.
 *
 * ## The three writes, in order
 *
 * The caller owns `workspace.yaml`, so the operation is split:
 *
 *   1. {@link planEpicWorkflowSwitch} — reads, checks, assembles. No writes.
 *   2. {@link stageEpicWorkflowSwitch} — mutates the caller's parsed document
 *      (swap the pipeline, re-point the epic's ownership); the caller then
 *      writes it however it normally does.
 *   3. {@link applyEpicWorkflowSwitch} — rewrites `state.json` and the run.
 *
 * The order matters for the same reason it does at scaffold time: the pipeline
 * definition has to be on disk before anything points at it, so a failure
 * between steps leaves a workspace that still loads.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { PipelineConfig, WorkspaceConfig } from '../schema/WorkspaceSchema';
import { normalizeStep } from '../schema/WorkspaceSchema';
import type { RunState } from './RunState';
import { startRun } from './PipelineRunner';
import { RunStateStore } from './RunStateStore';
import { assemblePipeline, recipePipelineId } from './PipelineAssembler';
import { epicsRoot, mirrorRunStateToEpic } from './EpicScaffold';
import {
  epicPipelinePath,
  epicOwningPipeline,
  stageEpicPipeline,
  unstageEpicPipeline,
} from '../loader/EpicPipelineStore';

export class EpicWorkflowSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpicWorkflowSwitchError';
  }
}

/** What an epic can be re-pointed at: a recipe to assemble, or a pipeline that exists. */
export type EpicWorkflowTarget =
  | { kind: 'recipe'; id: string }
  | { kind: 'pipeline'; id: string };

/** The minimal document shape this module reads and mutates. */
export interface WorkflowSwitchCarrier {
  pipelines: Array<Record<string, unknown>>;
  state?: unknown;
}

export interface EpicWorkflowSwitchPlan {
  epicId: string;
  /** What the epic runs today. `null` id for an epic bound to neither. */
  from: { kind: 'pipeline' | 'agent' | 'none'; id: string | null };
  to: EpicWorkflowTarget;
  /** The pipeline the epic will run, assembled or resolved. */
  pipeline: PipelineConfig;
  /** True when the pipeline belongs to this epic — i.e. lives in its own file. */
  owned: boolean;
  /** The epic-owned pipeline being replaced, if the epic had one. */
  previousOwnedPipelineId: string | null;
  /** Step agents, in order — what `state.json` calls `agents`. */
  agents: string[];
}

export interface EpicWorkflowSwitchResult {
  epicId: string;
  pipelineId: string;
  agents: string[];
  previousPipelineId: string | null;
  /** The epic's own `pipeline.yaml`, deleted because a shared pipeline took over. */
  removedPipelineFile: string | null;
  runState: RunState;
}

// ── Is the window still open? ─────────────────────────────────────────────────

/**
 * Why this epic's workflow can no longer be changed, or `null` while it still
 * can. The sentence is written to be shown as-is, after "…can't change the
 * workflow: ".
 *
 * A missing run is not a lock. An epic bound to a single agent never started
 * one, and an epic whose run file was deleted has no records to protect — in
 * both cases pointing it at a pipeline is the repair, not the risk.
 */
export function epicWorkflowLock(run: RunState | null): string | null {
  if (!run) { return null; }
  if (run.status !== 'running') { return `the run is already ${run.status}`; }
  for (const step of run.steps) {
    const id = step.name ?? step.agent;
    if (step.status !== 'pending' && step.status !== 'awaiting_work') {
      return `step "${id}" is ${step.status}`;
    }
    if (step.revision > 1) { return `step "${id}" has already been rerun`; }
    if ((step.history?.length ?? 0) > 0) { return `step "${id}" already has history`; }
    if (step.artifactsProduced.length > 0) { return `step "${id}" has produced artifacts`; }
  }
  return null;
}

/** Convenience over {@link epicWorkflowLock} for a UI that only wants the flag. */
export function canSwitchEpicWorkflow(workspaceRoot: string, epicId: string): boolean {
  return epicWorkflowLock(RunStateStore.load(workspaceRoot, epicId)) === null;
}

// ── Plan ──────────────────────────────────────────────────────────────────────

function readEpicState(epicDir: string, epicId: string): Record<string, unknown> {
  const file = path.join(epicDir, 'state.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new EpicWorkflowSwitchError(`Epic "${epicId}" has no state.json at ${file}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EpicWorkflowSwitchError(
      `Epic "${epicId}" has a state.json that is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EpicWorkflowSwitchError(`Epic "${epicId}" has a state.json that is not an object.`);
  }
  return parsed as Record<string, unknown>;
}

function stepAgents(pipeline: PipelineConfig): string[] {
  return pipeline.steps.map((s) => normalizeStep(s).agent);
}

/**
 * Work out what the switch would do, or throw saying why it cannot happen.
 * Reads `state.json` and the run; writes nothing.
 */
export function planEpicWorkflowSwitch(args: {
  workspaceRoot: string;
  /** The parsed workspace document — for `state.root` and pipeline ownership. */
  doc: WorkflowSwitchCarrier;
  /** The same workspace, validated — what {@link assemblePipeline} needs. */
  config: WorkspaceConfig;
  epicId: string;
  target: EpicWorkflowTarget;
}): EpicWorkflowSwitchPlan {
  const { workspaceRoot, doc, config, epicId, target } = args;

  const epicDir = path.join(epicsRoot(workspaceRoot, doc), epicId);
  const state = readEpicState(epicDir, epicId);

  const lock = epicWorkflowLock(RunStateStore.load(workspaceRoot, epicId));
  if (lock) {
    throw new EpicWorkflowSwitchError(
      `Epic "${epicId}" has already started, so its workflow can't be changed: ${lock}. `
      + 'Add or remove individual steps instead (`aidlc epic step add` / `remove`), or start a new epic.',
    );
  }

  const currentPipelineId = typeof state.pipeline === 'string' && state.pipeline ? state.pipeline : null;
  const currentAgentId = typeof state.agent === 'string' && state.agent ? state.agent : null;
  const from: EpicWorkflowSwitchPlan['from'] = currentPipelineId
    ? { kind: 'pipeline', id: currentPipelineId }
    : currentAgentId
      ? { kind: 'agent', id: currentAgentId }
      : { kind: 'none', id: null };

  // The epic owns a pipeline when it has a file of its own to put it in. The
  // file is the fact on disk; the document's origin map only knows what the
  // last merge told it, and a caller may hand us a document built otherwise.
  const ownFile = epicPipelinePath(workspaceRoot, doc, epicId);
  const previousOwnedPipelineId = fs.existsSync(ownFile) && currentPipelineId
    ? currentPipelineId
    : null;

  let pipeline: PipelineConfig;
  let owned: boolean;

  if (target.kind === 'pipeline') {
    const found = config.pipelines.find((p) => p.id === target.id);
    if (!found) {
      const available = config.pipelines.map((p) => p.id).join(', ') || '(none defined)';
      throw new EpicWorkflowSwitchError(
        `Pipeline "${target.id}" is not defined. Available: ${available}`,
      );
    }
    const otherOwner = epicOwningPipeline(doc as object, target.id);
    if (otherOwner && otherOwner !== epicId) {
      throw new EpicWorkflowSwitchError(
        `Pipeline "${target.id}" belongs to epic "${otherOwner}" — it lives in that epic's folder and `
        + 'editing it there would reshape that epic too. Pick a recipe instead, and this epic gets its own copy.',
      );
    }
    if (target.id === currentPipelineId) {
      throw new EpicWorkflowSwitchError(`Epic "${epicId}" already runs pipeline "${target.id}".`);
    }
    if (found.steps.length === 0) {
      throw new EpicWorkflowSwitchError(`Pipeline "${target.id}" has no steps to run.`);
    }
    pipeline = found;
    owned = otherOwner === epicId;
  } else {
    // A fresh assembly is named the way `recipePipelineId` names one at start
    // time — and the epic's *current* pipeline id is not "taken" for this
    // purpose, because we are about to replace it.
    const taken = new Set(
      config.pipelines.map((p) => p.id).filter((id) => id !== previousOwnedPipelineId),
    );
    const pipelineId = recipePipelineId({ recipeId: target.id, epicId, taken });
    pipeline = assemblePipeline(config, { recipeId: target.id, pipelineId });
    owned = true;
  }

  return {
    epicId,
    from,
    to: target,
    pipeline,
    owned,
    previousOwnedPipelineId,
    agents: stepAgents(pipeline),
  };
}

// ── Stage into the caller's document ──────────────────────────────────────────

/**
 * Swap the pipeline into the caller's parsed workspace document and re-point
 * the epic's ownership, so the caller's normal write puts the definition where
 * it belongs. Mutates `doc`; touches no files.
 *
 * The replacement keeps its position in `pipelines:` rather than being removed
 * and appended, so a switch does not reshuffle a file every other epic reads.
 */
export function stageEpicWorkflowSwitch(
  doc: WorkflowSwitchCarrier,
  plan: EpicWorkflowSwitchPlan,
): void {
  const { previousOwnedPipelineId, pipeline, owned, epicId } = plan;
  const next = pipeline as unknown as Record<string, unknown>;

  const at = previousOwnedPipelineId
    ? doc.pipelines.findIndex((p) => p.id === previousOwnedPipelineId)
    : -1;

  if (previousOwnedPipelineId) { unstageEpicPipeline(doc as object, previousOwnedPipelineId); }

  if (owned) {
    const existing = doc.pipelines.findIndex((p) => p.id === pipeline.id);
    if (existing >= 0) {
      doc.pipelines.splice(existing, 1, next);
    } else if (at >= 0) {
      doc.pipelines.splice(at, 1, next);
    } else {
      doc.pipelines.push(next);
    }
    // The old id is gone from the document whenever the new one differs.
    if (previousOwnedPipelineId && previousOwnedPipelineId !== pipeline.id) {
      doc.pipelines = doc.pipelines.filter(
        (p) => p.id !== previousOwnedPipelineId,
      );
    }
    stageEpicPipeline(doc as object, pipeline.id, epicId);
  } else if (at >= 0) {
    // A shared pipeline takes over: the epic's own definition leaves with it.
    doc.pipelines.splice(at, 1);
  }
}

// ── Apply ─────────────────────────────────────────────────────────────────────

/**
 * Point the epic at its new pipeline: rewrite `state.json`, lay out a fresh
 * run, and mirror it back. Call it *after* the document has been written, so
 * the pipeline it names is already on disk.
 *
 * The run's context is carried over from the run being replaced, falling back
 * to `inputs.json` — the capability inputs the user gave at start time are
 * about the epic, not about the workflow, and asking for them again because a
 * recipe changed would be the switch charging for itself.
 */
export function applyEpicWorkflowSwitch(
  workspaceRoot: string,
  doc: WorkflowSwitchCarrier,
  plan: EpicWorkflowSwitchPlan,
): EpicWorkflowSwitchResult {
  const { epicId } = plan;
  const epicDir = path.join(epicsRoot(workspaceRoot, doc), epicId);
  const stateFile = path.join(epicDir, 'state.json');
  const state = readEpicState(epicDir, epicId);

  const previous = RunStateStore.load(workspaceRoot, epicId);
  const lock = epicWorkflowLock(previous);
  if (lock) {
    throw new EpicWorkflowSwitchError(
      `Epic "${epicId}" has already started, so its workflow can't be changed: ${lock}.`,
    );
  }

  // The epic's own file only goes when a shared pipeline took over; a new
  // assembly is written to that same path by the caller's document write.
  let removedPipelineFile: string | null = null;
  if (!plan.owned && plan.previousOwnedPipelineId) {
    const file = epicPipelinePath(workspaceRoot, doc, epicId);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removedPipelineFile = file;
    }
  }

  // Only the binding is ours to write. `agents`, `stepStates`, `status` and
  // `currentStep` come from the run, via the mirror below — the one path that
  // writes them anywhere, and the reason `mirrorRunStateToEpic` keeps the
  // `pipeline` already on disk rather than taking it from the run.
  state.pipeline = plan.pipeline.id;
  state.agent = null;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');

  const context = previous?.context ?? readInputs(epicDir);
  const runState = startRun({
    runId: epicId,
    pipeline: plan.pipeline,
    context: { ...context, epic: epicId },
  });
  RunStateStore.save(workspaceRoot, runState);
  // Fills in `stepStates`, `agents`, `status` and `currentStep` from the run
  // that now exists — the same path every other transition writes them by.
  mirrorRunStateToEpic(workspaceRoot, runState, doc);

  return {
    epicId,
    pipelineId: plan.pipeline.id,
    agents: plan.agents,
    previousPipelineId: plan.from.kind === 'pipeline' ? plan.from.id : null,
    removedPipelineFile,
    runState,
  };
}

/** `inputs.json` as run context — string values only, which is all it holds. */
function readInputs(epicDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(epicDir, 'inputs.json'), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return {}; }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') { out[k] = v; }
    }
    return out;
  } catch {
    return {};
  }
}
