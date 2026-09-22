import { describe, it, expect } from 'vitest';

import {
  deriveRunProgress,
  isRunComplete,
  isStepOptional,
  nextEligiblePhase,
  startRun,
  approveStep,
  rejectStep,
  submitAutoReviewVerdict,
  markStepDone,
  type PipelineConfig,
  type RunState,
  type StepStatus,
} from '../src';

/**
 * The CR-Y01 shape: an intake, three independent solo lenses, and a merge that
 * only depends on ONE of them — so the other two are side branches nothing
 * waits on. `optional` is declared on the BA lens only, so the tests can tell
 * "nothing depends on it" from "the author said it is skippable".
 */
const SQUAD: PipelineConfig = {
  id: 'cr-squad',
  on_failure: 'stop',
  steps: [
    { agent: 'ba', name: 'intake' },
    { agent: 'solo-ba', name: 'solo-ba', optional: true, depends_on: ['intake'] },
    { agent: 'solo-dev', name: 'solo-dev', depends_on: ['intake'] },
    { agent: 'facilitator', name: 'merge', depends_on: ['solo-dev'] },
  ] as unknown as PipelineConfig['steps'],
};

const SEQUENTIAL: PipelineConfig = {
  id: 'seq',
  on_failure: 'stop',
  steps: [
    { agent: 'po', name: 'plan' },
    { agent: 'qa', name: 'extra-review', optional: true },
    { agent: 'dev', name: 'build' },
  ] as unknown as PipelineConfig['steps'],
};

function stateFor(pipeline: PipelineConfig, statuses: StepStatus[], currentStepIdx = 0): RunState {
  return {
    schemaVersion: 2,
    runId: 'CR-Y01',
    pipelineId: pipeline.id,
    context: { epic: 'CR-Y01' },
    startedAt: 't',
    updatedAt: 't',
    currentStepIdx,
    status: 'running',
    steps: statuses.map((status, i) => {
      const cfg = pipeline.steps[i] as { agent: string; name?: string };
      return {
        stepIdx: i,
        agent: cfg.agent,
        ...(cfg.name === undefined ? {} : { name: cfg.name }),
        revision: 1,
        status,
        artifactsProduced: [],
      };
    }),
  } as RunState;
}

describe('runProgress — is this rejection holding the run back?', () => {
  it('reads a rejected side branch with work open elsewhere as in_progress', () => {
    // CR-Y01 verbatim: solo-ba rejected, solo-dev approved, merge open.
    const p = deriveRunProgress(
      stateFor(SQUAD, ['approved', 'rejected', 'approved', 'awaiting_work'], 1),
      SQUAD,
    );
    expect(p.status).toBe('in_progress');
    expect(p.stuck).toBe(false);
    expect(p.actionable).toEqual([3]);
    expect(p.rejected).toEqual([1]);
  });

  it('reads a rejection with nothing else actionable as failed', () => {
    // solo-ba rejected (optional, ignorable), solo-dev rejected (needed), and
    // merge can never open without it.
    const p = deriveRunProgress(
      stateFor(SQUAD, ['approved', 'rejected', 'rejected', 'pending'], 2),
      SQUAD,
    );
    expect(p.status).toBe('failed');
    expect(p.stuck).toBe(true);
    expect(p.blocking).toEqual([2]);
  });

  it('never counts an optional step as blocking, even when it is the only rejection', () => {
    const p = deriveRunProgress(
      stateFor(SQUAD, ['approved', 'rejected', 'approved', 'approved'], 1),
      SQUAD,
    );
    expect(p.rejected).toEqual([1]);
    expect(p.blocking).toEqual([]);
    expect(p.status).toBe('in_progress');
  });

  it('counts a non-optional rejection as blocking', () => {
    expect(isStepOptional(SQUAD, 1)).toBe(true);
    expect(isStepOptional(SQUAD, 2)).toBe(false);
    // No pipeline in hand → nothing is optional, rather than a guess.
    expect(isStepOptional(undefined, 1)).toBe(false);
  });

  it('treats a completed run as done whatever its steps say', () => {
    const s = stateFor(SQUAD, ['approved', 'rejected', 'approved', 'approved'], 3);
    s.status = 'completed';
    expect(deriveRunProgress(s, SQUAD).status).toBe('done');
  });

  it('lets a run complete with an optional step rejected, but not a required one', () => {
    expect(isRunComplete(
      stateFor(SQUAD, ['approved', 'rejected', 'approved', 'approved']),
      SQUAD,
    )).toBe(true);
    expect(isRunComplete(
      stateFor(SQUAD, ['approved', 'approved', 'rejected', 'approved']),
      SQUAD,
    )).toBe(false);
  });
});

describe('PipelineRunner — the cursor does not park on a rejection', () => {
  it('moves the cursor off a rejected step when a sibling advances the run', () => {
    // Regression: approving solo-dev used to leave currentStepIdx on the
    // rejected solo-ba, so every surface reported a run that had moved on as
    // "rejected".
    let state = startRun({ runId: 'CR-Y01', pipeline: SQUAD, context: { epic: 'CR-Y01' } });
    state = { ...state, steps: state.steps.map((s) => ({ ...s })) };
    // intake approved, solo-ba + solo-dev open (DAG roots after intake).
    state.steps[0].status = 'approved';
    state.steps[1].status = 'awaiting_review';
    state.steps[2].status = 'awaiting_review';
    state.currentStepIdx = 1;

    state = rejectStep({ state, reason: 'no answers recorded', stepIdx: 1, pipeline: SQUAD });
    state = approveStep({ state, pipeline: SQUAD, stepIdx: 2 });

    expect(state.steps[1].status).toBe('rejected');
    expect(state.steps[3].status).toBe('awaiting_work');
    expect(state.currentStepIdx).toBe(3);
    expect(deriveRunProgress(state, SQUAD).status).toBe('in_progress');
  });

  it('follows the step it just unblocked rather than an older sibling', () => {
    const state = stateFor(SQUAD, ['approved', 'awaiting_work', 'awaiting_review', 'pending'], 2);
    const next = approveStep({ state, pipeline: SQUAD, stepIdx: 2 });
    // solo-dev approving opens merge; solo-ba has been open all along, and
    // dragging focus backwards onto it would hide the new work.
    expect(next.currentStepIdx).toBe(3);
  });

  it('leaves the cursor alone when it points at a step still working', () => {
    const state = stateFor(SQUAD, ['approved', 'awaiting_work', 'awaiting_review', 'pending'], 1);
    const next = approveStep({ state, pipeline: SQUAD, stepIdx: 2 });
    expect(next.currentStepIdx).toBe(1);
  });

  it('completes a run whose only unapproved step is an optional rejection', () => {
    let state = stateFor(SQUAD, ['approved', 'rejected', 'approved', 'awaiting_review'], 3);
    state = approveStep({ state, pipeline: SQUAD, stepIdx: 3 });
    expect(state.status).toBe('completed');
  });

  it('opens the following step when a sequential optional step is rejected', () => {
    let state = stateFor(SEQUENTIAL, ['approved', 'awaiting_review', 'pending'], 1);
    state = rejectStep({ state, reason: 'skip it', stepIdx: 1, pipeline: SEQUENTIAL });
    expect(state.steps[1].status).toBe('rejected');
    expect(state.steps[2].status).toBe('awaiting_work');
    expect(state.currentStepIdx).toBe(2);
    expect(deriveRunProgress(state, SEQUENTIAL).status).toBe('in_progress');
  });

  it('parks on a rejection the run does need', () => {
    let state = stateFor(SEQUENTIAL, ['awaiting_review', 'pending', 'pending'], 0);
    state = rejectStep({ state, reason: 'thin', stepIdx: 0, pipeline: SEQUENTIAL });
    expect(state.currentStepIdx).toBe(0);
    expect(deriveRunProgress(state, SEQUENTIAL).status).toBe('failed');
  });

  it('settles an auto-review rejection on an optional step', () => {
    let state = stateFor(SQUAD, ['approved', 'awaiting_auto_review', 'awaiting_work', 'pending'], 1);
    state = submitAutoReviewVerdict({
      state,
      pipeline: SQUAD,
      stepIdx: 1,
      verdict: { decision: 'reject', reason: 'no answers recorded', at: 't', runner: 'v.mjs' },
    });
    expect(state.steps[1].status).toBe('rejected');
    // Cursor left the optional rejection for the sibling still working.
    expect(state.currentStepIdx).toBe(2);
  });
});

describe('commandModel — nextEligiblePhase skips past a settled rejection', () => {
  it('prefers open work over an earlier rejected step', () => {
    const next = nextEligiblePhase(
      stateFor(SQUAD, ['approved', 'rejected', 'approved', 'awaiting_work'], 1),
      SQUAD,
    );
    expect(next).toEqual({ index: 3, phaseId: 'merge', reason: 'awaiting_work' });
  });

  it('still sends the user back to a rejection the run needs', () => {
    const next = nextEligiblePhase(
      stateFor(SQUAD, ['approved', 'approved', 'rejected', 'pending'], 2),
      SQUAD,
    );
    expect(next).toEqual({ index: 2, phaseId: 'solo-dev', reason: 'rejected' });
  });

  it('offers an optional rejection last, after unblocked pending work', () => {
    const next = nextEligiblePhase(
      stateFor(SQUAD, ['approved', 'rejected', 'approved', 'pending'], 1),
      SQUAD,
    );
    expect(next).toEqual({ index: 3, phaseId: 'merge', reason: 'unblocked' });
  });

  it('offers the optional rejection when nothing else is left', () => {
    const next = nextEligiblePhase(
      stateFor(SQUAD, ['approved', 'rejected', 'approved', 'approved'], 1),
      SQUAD,
    );
    expect(next).toEqual({ index: 1, phaseId: 'solo-ba', reason: 'rejected' });
  });
});

describe('WorkspaceSchema — optional step flag', () => {
  it('defaults to false and survives normalization', async () => {
    const { normalizeStep } = await import('../src');
    expect(normalizeStep({ agent: 'x' }).optional).toBe(false);
    expect(normalizeStep('x').optional).toBe(false);
    expect(normalizeStep({ agent: 'x', optional: true }).optional).toBe(true);
  });
});

// markStepDone is imported to keep the runner's surface honest in this file:
// a step that auto-approves still flows through advance()'s refocus.
describe('PipelineRunner — refocus on an auto-approving step', () => {
  const AUTO: PipelineConfig = {
    id: 'auto',
    on_failure: 'stop',
    steps: [
      { agent: 'po', name: 'plan', produces: [], human_review: false, auto_review: false },
      { agent: 'dev', name: 'build', produces: [], human_review: false, auto_review: false },
    ] as unknown as PipelineConfig['steps'],
  };

  it('advances the cursor on a sequential auto-approve', () => {
    let state = stateFor(AUTO, ['awaiting_work', 'pending'], 0);
    state = markStepDone({ state, pipeline: AUTO, workspaceRoot: process.cwd(), stepIdx: 0 });
    expect(state.currentStepIdx).toBe(1);
  });
});
