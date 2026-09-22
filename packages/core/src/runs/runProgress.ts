/**
 * Where a run actually stands — one answer, shared by every surface.
 *
 * A rejected step used to be read as "this run failed", by the epic list, the
 * `state.json` mirror, the card badge and the autopilot loop, each on its own.
 * On a DAG that reading is wrong: reject a side branch nothing waits on and
 * the pipeline keeps going, yet the epic stayed red and the cursor stayed
 * parked on the rejection while the work had moved four steps along (CR-Y01).
 *
 * So the question "is this rejection holding the run back?" is answered here,
 * once, from the same facts the runner advances on:
 *
 *   - a step declared `optional: true` never holds a run back — it is the
 *     pipeline author saying "fail this and carry on";
 *   - a rejection with work still open elsewhere (a step `awaiting_*`, or a
 *     `pending` step whose deps are all approved) has not stopped anything;
 *   - a rejection with nothing else actionable is what "stuck" means.
 *
 * Pure: no filesystem, no clock, no mutation.
 */

import type { PipelineConfig } from '../schema/WorkspaceSchema';
import { normalizeStep } from '../schema/WorkspaceSchema';
import type { RunState, StepStatus } from './RunState';

/** Statuses that mean "open work" — someone can pick this step up now. */
const ACTIVE: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'awaiting_work',
  'awaiting_auto_review',
  'awaiting_review',
]);

/** True when the step's status means work is open on it. */
export function isActiveStatus(status: StepStatus): boolean {
  return ACTIVE.has(status);
}

/**
 * Is the step at `idx` declared `optional: true`?
 *
 * Without a pipeline nothing is optional: the flag lives in the pipeline, and
 * guessing it from the run would turn "we can't tell" into "carry on".
 */
export function isStepOptional(pipeline: PipelineConfig | null | undefined, idx: number): boolean {
  const cfg = pipeline?.steps?.[idx];
  return cfg === undefined ? false : normalizeStep(cfg).optional;
}

/**
 * Does this pipeline use `depends_on` anywhere? Mirrors the same test in
 * `startRun` / `advance`, so "actionable" here means the same thing the
 * runner would do next.
 */
function usesDag(pipeline: PipelineConfig): boolean {
  return pipeline.steps.some((s) => normalizeStep(s).depends_on.length > 0);
}

/** A run's progress, as every surface should read it. */
export interface RunProgress {
  /** Indices with open work — `awaiting_*`, plus DAG steps whose deps just cleared. */
  actionable: number[];
  /** Rejected steps, optional ones included. */
  rejected: number[];
  /** Rejected steps that are not optional — the ones completion still needs. */
  blocking: number[];
  /** A rejection is blocking and there is nothing else to act on. */
  stuck: boolean;
  /** Epic-facing roll-up: `done` | `failed` | `in_progress`. */
  status: 'done' | 'failed' | 'in_progress';
}

/**
 * Read a run's position without changing it.
 *
 * `pipeline` is optional so callers holding only a run state (a legacy epic,
 * a pipeline since renamed) still get the status roll-up; without it, no step
 * counts as optional and `pending` steps are never actionable.
 */
export function deriveRunProgress(
  state: RunState,
  pipeline?: PipelineConfig | null,
): RunProgress {
  const dag = pipeline ? usesDag(pipeline) : false;
  const approvedDagIds = new Set<string>();
  if (pipeline && dag) {
    state.steps.forEach((s, i) => {
      if (s.status !== 'approved') { return; }
      const norm = normalizeStep(pipeline.steps[i] ?? { agent: s.agent });
      approvedDagIds.add(norm.name ?? norm.agent);
    });
  }

  const actionable: number[] = [];
  const rejected: number[] = [];
  const blocking: number[] = [];

  state.steps.forEach((s, i) => {
    if (isActiveStatus(s.status)) {
      actionable.push(i);
      return;
    }
    if (s.status === 'rejected') {
      rejected.push(i);
      if (!isStepOptional(pipeline, i)) { blocking.push(i); }
      return;
    }
    // A `pending` step is the runner's to open, except on a DAG where its
    // deps may have cleared in a branch that has since been rejected — then
    // nobody is going to open it but the next approval, and it is work the
    // user can start now.
    if (s.status === 'pending' && pipeline && dag) {
      const deps = normalizeStep(pipeline.steps[i] ?? { agent: s.agent }).depends_on;
      if (deps.length > 0 && deps.every((d) => approvedDagIds.has(d))) {
        actionable.push(i);
      }
    }
  });

  const stuck = blocking.length > 0 && actionable.length === 0;
  const status = state.status === 'completed'
    ? 'done' as const
    : stuck
      ? 'failed' as const
      : 'in_progress' as const;

  return { actionable, rejected, blocking, stuck, status };
}

/**
 * Is every step settled for the purpose of completing the run?
 *
 * Approved counts, and so does an optional step the run gave up on — a
 * `rejected` or never-opened `pending` optional step is a branch the author
 * said was skippable. Anything else still owes the run something.
 */
export function isRunComplete(state: RunState, pipeline: PipelineConfig): boolean {
  return state.steps.every((s, i) => {
    if (s.status === 'approved') { return true; }
    if (!isStepOptional(pipeline, i)) { return false; }
    return s.status === 'rejected' || s.status === 'pending';
  });
}
