/**
 * Line a {@link RunState} up against the pipeline it is executing, by step
 * identity rather than by array position.
 *
 * ## Why this exists
 *
 * An epic's steps are written down three times: the pipeline's `steps` in
 * `workspace.yaml`, `stepStates[]` in the epic's `state.json`, and `steps[]`
 * in `.aidlc/runs/<id>.json`. Historically only the first recorded a step
 * *name* — the other two, and `currentStepIdx`, were bare positions, and the
 * runner's only check was that an index still fell inside `pipeline.steps`.
 * A pipeline that lost a step therefore kept satisfying every guard while
 * every record after the removal pointed at the wrong step, with no error at
 * all. A pipeline that gained one produced a step record with no agent.
 *
 * {@link StepRecord.name} closes that: a record now carries the same identity
 * the rest of the system already keys steps by — `name` falling back to
 * `agent`, exactly what `stepDagId` and the runner's DAG resolution use. This
 * module compares the two sides on that identity and says precisely what
 * moved, so a drifted run fails loudly instead of quietly running the wrong
 * work.
 *
 * ## Matching is deliberately forgiving
 *
 * `name` is additive information: run files written before it existed have
 * only an `agent`, while their pipeline steps may well carry names. Treating
 * a missing name as a mismatch would declare every pre-existing run broken.
 * So a record without a name matches on `agent` alone, and names are only
 * compared when both sides have one. {@link withBackfilledStepNames} then
 * heals such a record the first time the run is touched, after which the two
 * steps that share an agent stay distinguishable.
 */

import type { PipelineConfig, PipelineStepConfig } from '../schema/WorkspaceSchema';
import { normalizeStep } from '../schema/WorkspaceSchema';
import type { RunState, StepRecord } from './RunState';
import { stepIdentity } from './RunState';

/** What happened to one step between the run's record of it and the pipeline. */
export type StepAlignmentKind =
  /** Same identity, same position — nothing to do. */
  | 'matched'
  /** Same identity, different position: the run's index no longer points at it. */
  | 'moved'
  /** In the pipeline, with no record in the run — the pipeline gained a step. */
  | 'added'
  /** Recorded in the run, with no step in the pipeline — the pipeline lost one. */
  | 'removed';

export interface StepAlignment {
  /** Identity both sides are compared on: `name ?? agent`. */
  id: string;
  /** Index into `pipeline.steps`, or -1 when the pipeline no longer has it. */
  pipelineIdx: number;
  /** Index into `state.steps`, or -1 when the run has no record of it. */
  runIdx: number;
  kind: StepAlignmentKind;
}

export interface RunReconciliation {
  /**
   * True when every step matched at its own index — the only case in which
   * the run's positional fields (`stepIdx`, `currentStepIdx`) still mean what
   * they say.
   */
  aligned: boolean;
  /** One entry per step on either side, pipeline order first, then removals. */
  alignments: StepAlignment[];
  added: string[];
  removed: string[];
  moved: string[];
}

/** Identity of a pipeline step: its `name`, falling back to its `agent` id. */
function pipelineStepIdentity(raw: PipelineStepConfig): string {
  const norm = normalizeStep(raw);
  return norm.name ?? norm.agent;
}

/**
 * Can this record and this pipeline step be the same step? Agents must always
 * agree; names are compared only when both sides carry one, so a run file
 * written before `name` existed is not declared broken for lacking it.
 */
function isSameStep(rec: StepRecord, raw: PipelineStepConfig): boolean {
  const norm = normalizeStep(raw);
  if (rec.agent !== norm.agent) { return false; }
  if (rec.name === undefined || norm.name === undefined) { return true; }
  return rec.name === norm.name;
}

/**
 * Diff a run's step records against a pipeline's steps by identity.
 *
 * Pure and total — never throws, and reports drift rather than repairing it.
 * Candidates are consumed left to right, so two steps backed by the same
 * agent (common: one persona owning several phases) still pair up in order
 * when neither side has names to tell them apart.
 */
export function reconcileRunSteps(
  state: RunState,
  pipeline: PipelineConfig,
): RunReconciliation {
  const pipelineSteps = Array.isArray(pipeline.steps) ? pipeline.steps : [];
  const unclaimed = state.steps.map((_, i) => i);
  const alignments: StepAlignment[] = [];

  pipelineSteps.forEach((raw, pipelineIdx) => {
    const at = unclaimed.findIndex((runIdx) => isSameStep(state.steps[runIdx], raw));
    if (at < 0) {
      alignments.push({
        id: pipelineStepIdentity(raw),
        pipelineIdx,
        runIdx: -1,
        kind: 'added',
      });
      return;
    }
    const runIdx = unclaimed[at];
    unclaimed.splice(at, 1);
    alignments.push({
      id: pipelineStepIdentity(raw),
      pipelineIdx,
      runIdx,
      kind: runIdx === pipelineIdx ? 'matched' : 'moved',
    });
  });

  for (const runIdx of unclaimed) {
    alignments.push({
      id: stepIdentity(state.steps[runIdx]),
      pipelineIdx: -1,
      runIdx,
      kind: 'removed',
    });
  }

  const pick = (kind: StepAlignmentKind): string[] =>
    alignments.filter((a) => a.kind === kind).map((a) => a.id);

  const added = pick('added');
  const removed = pick('removed');
  const moved = pick('moved');
  return {
    aligned: added.length === 0 && removed.length === 0 && moved.length === 0,
    alignments,
    added,
    removed,
    moved,
  };
}

/**
 * One line naming what drifted, or null when nothing did. Written to be read
 * at the end of an error message, so it says what changed and not what to do
 * about it.
 */
export function describeDrift(r: RunReconciliation): string | null {
  if (r.aligned) { return null; }
  const parts: string[] = [];
  const list = (xs: string[]): string => xs.map((x) => `"${x}"`).join(', ');
  if (r.removed.length > 0) { parts.push(`${list(r.removed)} no longer in the pipeline`); }
  if (r.added.length > 0) { parts.push(`${list(r.added)} added to the pipeline`); }
  if (r.moved.length > 0) { parts.push(`${list(r.moved)} moved to a different position`); }
  return parts.join('; ');
}

/**
 * Copy each pipeline step's `name` onto the matching run record when the
 * record has none, so a run started before names existed gains the identity
 * that keeps it checkable from here on.
 *
 * Only backfills from an aligned reconciliation: if the shapes already
 * disagree, positions prove nothing and stamping names on would be inventing
 * history. Returns `state` itself when there is nothing to fill in, so the
 * common path allocates nothing.
 */
export function withBackfilledStepNames(
  state: RunState,
  pipeline: PipelineConfig,
): RunState {
  const r = reconcileRunSteps(state, pipeline);
  if (!r.aligned) { return state; }
  const pipelineSteps = Array.isArray(pipeline.steps) ? pipeline.steps : [];

  let changed = false;
  const steps = state.steps.map((rec, i) => {
    if (rec.name !== undefined) { return rec; }
    const raw = pipelineSteps[i];
    if (!raw) { return rec; }
    const name = normalizeStep(raw).name;
    if (name === undefined) { return rec; }
    changed = true;
    return { ...rec, name };
  });

  return changed ? { ...state, steps } : state;
}
