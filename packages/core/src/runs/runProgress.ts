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
import { isStepEnabled, effectiveDepsOf } from './enabledSteps';

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

  const effDeps = pipeline && dag ? effectiveDepsOf(pipeline.steps.map(normalizeStep)) : [];
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
    if (s.status === 'pending' && pipeline && dag && isStepEnabled(pipeline, i)) {
      const deps = effDeps[i] ?? [];
      if (deps.length > 0 && deps.every((d) => approvedDagIds.has(d))) {
        actionable.push(i);
      }
    }
  });

  const stuck = blocking.length > 0 && actionable.length === 0;
  // Completion is written only when a step is approved or rejected, so a run
  // settled under an older rule (CR-Y01, before dead-end peers were excused)
  // would never be re-judged. Read it here too, so no one has to touch it.
  const complete = state.status === 'completed'
    || (pipeline != null && state.steps.length > 0 && isRunComplete(state, pipeline));
  const status = complete
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
 * said was skippable.
 *
 * On a DAG, so does a dead-end peer of an approved step: nothing declares
 * `depends_on` it, and a step at the same stage (see {@link weighStepProgress})
 * is approved. That is the rule the progress bar already counts by — CR-Y01
 * read 100% with `cr-solo-ba` rejected and `cr-solo-qc` still open, because
 * `cr-merge` only waits on `cr-solo-dev`, yet stayed `in_progress` forever
 * after `cr-close` was approved. A peer something does wait on is never
 * excused: its dependent has not run against its current output.
 *
 * A `skipped` step is settled, and so is any step the pipeline has disabled
 * that never got going — the run was never going to open it.
 *
 * Anything else still owes the run something.
 */
export function isRunComplete(state: RunState, pipeline: PipelineConfig): boolean {
  const excused = usesDag(pipeline) ? deadEndPeersOfApproved(state, pipeline) : new Set<number>();
  return state.steps.every((s, i) => {
    if (s.status === 'approved' || s.status === 'skipped') { return true; }
    if (!isStepEnabled(pipeline, i) && !isActiveStatus(s.status)) { return true; }
    if (excused.has(i)) { return true; }
    if (!isStepOptional(pipeline, i)) { return false; }
    return s.status === 'rejected' || s.status === 'pending';
  });
}

/**
 * The open step the autopilot loop should run next, or -1 when none of the
 * open steps is worth running.
 *
 * The cursor alone is not that answer on a DAG. It stays put while it points
 * at an open step, and an open step can be one the run no longer needs:
 * CR-261023-02 had its cursor on `cr-solo-ba` long after `cr-solo-dev`,
 * `cr-merge` and `cr-build-spec` were approved, so an autopilot started to
 * run `cr-build` through `cr-review` ran `cr-solo-ba` instead.
 *
 * An open step is skipped when it is a dead-end peer of an approved step (the
 * run completes without it, see {@link isRunComplete}), or, given `untilIdx`,
 * when it is neither that step nor something it transitively waits on. The
 * cursor wins when it is not skipped; otherwise the first open step that is
 * not skipped. A sequential pipeline always gets its cursor back.
 *
 * Pure: no filesystem, no clock, no mutation.
 */
export function nextRunnableStep(
  state: RunState,
  pipeline: PipelineConfig,
  untilIdx = -1,
): number {
  if (!usesDag(pipeline)) { return state.currentStepIdx; }

  const skipped = deadEndPeersOfApproved(state, pipeline);
  if (untilIdx >= 0) {
    skipped.delete(untilIdx);
    const onPath = ancestorsOf(pipeline, untilIdx);
    onPath.add(untilIdx);
    state.steps.forEach((_, i) => { if (!onPath.has(i)) { skipped.add(i); } });
  }

  const runnable = (i: number): boolean =>
    isActiveStatus(state.steps[i]?.status ?? 'pending') && !skipped.has(i);
  if (runnable(state.currentStepIdx)) { return state.currentStepIdx; }
  return state.steps.findIndex((_, i) => runnable(i));
}

/** Every step `idx` transitively depends on, matched by `name ?? agent`. */
function ancestorsOf(pipeline: PipelineConfig, idx: number): Set<number> {
  const normalized = pipeline.steps.map(normalizeStep);
  const idxByDagId = new Map<string, number>();
  normalized.forEach((s, i) => { idxByDagId.set(s.name ?? s.agent, i); });
  const effDeps = effectiveDepsOf(normalized);
  const found = new Set<number>();
  const queue = [idx];
  while (queue.length > 0) {
    const cur = queue.pop() as number;
    for (const dep of effDeps[cur] ?? []) {
      const di = idxByDagId.get(dep);
      if (di === undefined || found.has(di) || di === idx) { continue; }
      found.add(di);
      queue.push(di);
    }
  }
  return found;
}

/**
 * Unapproved steps nothing depends on whose stage an approved peer has
 * already settled. Ranks come from {@link weighStepProgress}, so completion
 * and the percentage can never disagree about what a stage is.
 */
function deadEndPeersOfApproved(state: RunState, pipeline: PipelineConfig): Set<number> {
  const normalized = state.steps.map((s, i) => normalizeStep(pipeline.steps[i] ?? { agent: s.agent }));
  const ids = normalized.map((n) => n.name ?? n.agent);
  const { ranks } = weighStepProgress(normalized.map((n, i) => ({
    id: ids[i],
    dependsOn: n.depends_on,
    done: state.steps[i].status === 'approved',
    skipped: !n.enabled,
  })));

  // What enabled steps actually wait on — a step only a disabled one names
  // is not waited on by anything that runs.
  const effDeps = effectiveDepsOf(normalized);
  const dependedOn = new Set<string>();
  normalized.forEach((n, i) => {
    if (!n.enabled) { return; }
    for (const d of effDeps[i]) { dependedOn.add(d); }
  });

  const approvedRanks = new Set<number>();
  state.steps.forEach((s, i) => { if (s.status === 'approved') { approvedRanks.add(ranks[i]); } });

  const excused = new Set<number>();
  state.steps.forEach((s, i) => {
    if (s.status === 'approved' || ranks[i] < 0) { return; }
    if (dependedOn.has(ids[i])) { return; }
    if (approvedRanks.has(ranks[i])) { excused.add(i); }
  });
  return excused;
}

/** One step, as the progress weighting needs to see it. */
export interface ProgressStep {
  /** The step's identity — `name ?? agent`, the same id `depends_on` uses. */
  id: string;
  /** Ids this step waits on. Absent/empty means it starts at the front. */
  dependsOn?: readonly string[];
  /** Whether this step is finished, however the caller defines finished. */
  done: boolean;
  /**
   * The step is disabled — not part of the run at all. It takes no rank and
   * no share, and a step that depends on it is ranked by what it depended on.
   */
  skipped?: boolean;
}

/** How far along a run is, counting parallel steps as one unit of work. */
export interface ProgressWeighting {
  /** Longest-path depth per step — steps sharing one are peers. -1 for a skipped step. */
  ranks: number[];
  /** Each step's share of the run, in [0, 1]. Peers split their rank's unit; skipped steps get 0. */
  weights: number[];
  /** Number of distinct ranks: the units the run is measured in. */
  stages: number;
  /** Completed stages: a rank counts once any one of its peers is done. */
  stagesDone: number;
  /** `stagesDone / stages` as a rounded percentage. */
  percent: number;
}

/**
 * Weigh a run's progress by stage rather than by step.
 *
 * Counting steps makes a pipeline's percentage depend on how wide it is, not
 * how far it has come: CR-Y01 fans out to `cr-solo-ba`, `cr-solo-dev` and
 * `cr-solo-qc`, which all wait on the same step and all feed the same one, so
 * finishing the three of them is one round of work — yet by step count it is
 * a third of the pipeline, and a pipeline that split that round five ways
 * would claim more progress for the same amount of review.
 *
 * So steps are grouped by rank (longest path from a root), each rank is one
 * unit, and the total is the number of ranks. Peers are takes on the same
 * round, so one finished peer completes its rank and the rest add nothing on
 * top — the others still open do not hold the epic back. A pipeline with no
 * `depends_on` gives every step its own rank, which is the old count exactly —
 * sequential pipelines are unaffected.
 *
 * Pure, and never throws: an id that nothing declares, a duplicate id, or a
 * dependency cycle each just stop constraining the rank they appear in.
 */
export function weighStepProgress(steps: ReadonlyArray<ProgressStep>): ProgressWeighting {
  const n = steps.length;
  if (n === 0) {
    return { ranks: [], weights: [], stages: 0, stagesDone: 0, percent: 0 };
  }

  // First index wins on a duplicate id: two steps can share an agent with no
  // `name`, and `depends_on` can only ever have meant one of them.
  const idxById = new Map<string, number>();
  steps.forEach((s, i) => { if (!idxById.has(s.id)) { idxById.set(s.id, i); } });

  // No step declares a dependency: index order is the chain, exactly as
  // `startRun` reads it. Every step is then its own stage, which is the plain
  // step count — a sequential pipeline's percentage does not move. A skipped
  // step is not a link of the chain at all.
  if (!steps.some((s) => (s.dependsOn?.length ?? 0) > 0)) {
    let next = 0;
    const ranks = steps.map((s) => (s.skipped ? -1 : next++));
    const weights = steps.map((s) => (s.skipped ? 0 : 1));
    const stagesDone = steps.reduce((sum, s) => (s.done && !s.skipped ? sum + 1 : sum), 0);
    return { ranks, weights, stages: next, stagesDone, percent: next > 0 ? Math.round((stagesDone / next) * 100) : 0 };
  }

  // `after[i]` is the lowest rank a dependent of step i can have: one past
  // its own rank, or — for a skipped step — whatever its own dependencies
  // already push a dependent to, so the skipped step adds no stage.
  const ranks = new Array<number>(n).fill(-1);
  const after = new Array<number>(n).fill(-1);
  const visiting = new Array<boolean>(n).fill(false);
  const afterOf = (i: number): number => {
    if (after[i] >= 0) { return after[i]; }
    // A cycle is a broken pipeline, not a reason to hang: treat the step we
    // re-entered as a root and let the rest of the graph resolve around it.
    if (visiting[i]) { return steps[i].skipped ? 0 : 1; }
    visiting[i] = true;
    let rank = 0;
    for (const dep of steps[i].dependsOn ?? []) {
      const j = idxById.get(dep);
      if (j === undefined || j === i) { continue; }
      rank = Math.max(rank, afterOf(j));
    }
    visiting[i] = false;
    if (!steps[i].skipped) { ranks[i] = rank; }
    after[i] = steps[i].skipped ? rank : rank + 1;
    return after[i];
  };
  for (let i = 0; i < n; i++) { afterOf(i); }

  const sizeByRank = new Map<number, number>();
  for (const r of ranks) { if (r >= 0) { sizeByRank.set(r, (sizeByRank.get(r) ?? 0) + 1); } }

  const weights = ranks.map((r) => (r < 0 ? 0 : 1 / (sizeByRank.get(r) ?? 1)));
  const stages = sizeByRank.size;
  // One finished peer settles its rank: the round has produced what the next
  // stage reads, and the peers still open do not hold the epic back.
  const doneRanks = new Set<number>();
  steps.forEach((s, i) => { if (s.done && ranks[i] >= 0) { doneRanks.add(ranks[i]); } });
  const stagesDone = doneRanks.size;

  return {
    ranks,
    weights,
    stages,
    stagesDone,
    percent: stages > 0 ? Math.round((stagesDone / stages) * 100) : 0,
  };
}
