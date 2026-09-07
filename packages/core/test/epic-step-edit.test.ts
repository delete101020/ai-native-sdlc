import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  planAddEpicStep,
  planRemoveEpicStep,
  commitEpicStepEdit,
  resolveStepRef,
  EpicStepEditError,
  RunStateStore,
  RUN_STATE_SCHEMA_VERSION,
  type RunState,
  type StepRecord,
  type StepStatus,
  type PipelineConfig,
} from '../src';

/**
 * `epic step add|remove` is the one supported way to reshape a pipeline an
 * epic is already running. These tests pin both halves of that: the two lists
 * move together and stay consistent, and the edits that cannot be made
 * coherently are refused with a reason rather than half-applied.
 */

function pipeline(steps: Array<Record<string, unknown>>, id = 'EPIC-001'): PipelineConfig {
  return { id, on_failure: 'stop', steps } as unknown as PipelineConfig;
}

function record(agent: string, name: string, status: StepStatus = 'pending'): StepRecord {
  return { stepIdx: 0, agent, name, revision: 1, status, artifactsProduced: [] };
}

function run(steps: StepRecord[], overrides: Partial<RunState> = {}): RunState {
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: 'EPIC-001',
    pipelineId: 'EPIC-001',
    context: {},
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    currentStepIdx: 0,
    status: 'running',
    steps: steps.map((s, i) => ({ ...s, stepIdx: i })),
    ...overrides,
  } as RunState;
}

/** A three-step sequential epic, one step done and the second in flight. */
function midFlight(): { runState: RunState; pipelineCfg: PipelineConfig } {
  return {
    runState: run(
      [
        record('po', 'intent', 'approved'),
        record('eng', 'build', 'awaiting_work'),
        record('qa', 'verify'),
      ],
      { currentStepIdx: 1 },
    ),
    pipelineCfg: pipeline([
      { agent: 'po', name: 'intent' },
      { agent: 'eng', name: 'build' },
      { agent: 'qa', name: 'verify' },
    ]),
  };
}

describe('resolveStepRef', () => {
  it('takes a name, an agent id or an index', () => {
    const { runState } = midFlight();
    expect(resolveStepRef(runState, 'verify')).toBe(2);
    expect(resolveStepRef(runState, 'qa')).toBe(2);
    expect(resolveStepRef(runState, '0')).toBe(0);
  });

  it('refuses an agent that owns more than one step instead of guessing', () => {
    const state = run([record('eng', 'build'), record('eng', 'implement')]);
    expect(() => resolveStepRef(state, 'eng')).toThrow(/owns more than one step/);
  });

  it('lists the steps when the reference matches nothing', () => {
    const { runState } = midFlight();
    expect(() => resolveStepRef(runState, 'nope')).toThrow(/0:intent, 1:build, 2:verify/);
  });
});

describe('planRemoveEpicStep', () => {
  it('drops the step from both lists and renumbers what is left', () => {
    const { runState, pipelineCfg } = midFlight();
    const plan = planRemoveEpicStep({ runState, pipeline: pipelineCfg, step: 'verify' });

    expect(plan.pipeline.steps).toHaveLength(2);
    expect(plan.runState.steps.map((s) => s.name)).toEqual(['intent', 'build']);
    expect(plan.runState.steps.map((s) => s.stepIdx)).toEqual([0, 1]);
  });

  /** The pointer is a position, so it has to be re-derived, not carried over. */
  it('keeps the pointer on the same step when an earlier one is removed', () => {
    const runState = run(
      [record('po', 'intent'), record('eng', 'build', 'awaiting_work')],
      { currentStepIdx: 1 },
    );
    const plan = planRemoveEpicStep({
      runState,
      pipeline: pipeline([{ agent: 'po', name: 'intent' }, { agent: 'eng', name: 'build' }]),
      step: 'intent',
    });
    expect(plan.runState.currentStepIdx).toBe(0);
    expect(plan.runState.steps[0].name).toBe('build');
  });

  it('refuses a step that has already started, and names the tool that can skip it', () => {
    const { runState, pipelineCfg } = midFlight();
    expect(() => planRemoveEpicStep({ runState, pipeline: pipelineCfg, step: 'build' }))
      .toThrow(/is awaiting_work, not pending[\s\S]*aidlc step skip EPIC-001 build/);
  });

  it('refuses to leave a pipeline with no steps', () => {
    const runState = run([record('po', 'intent')]);
    expect(() => planRemoveEpicStep({
      runState,
      pipeline: pipeline([{ agent: 'po', name: 'intent' }]),
      step: 'intent',
    })).toThrow(/no steps left/);
  });

  /** A `depends_on` naming a step that is gone is a step that never opens. */
  it('refuses a step other steps depend on', () => {
    const runState = run([record('po', 'intent'), record('eng', 'build')]);
    expect(() => planRemoveEpicStep({
      runState,
      pipeline: pipeline([
        { agent: 'po', name: 'intent' },
        { agent: 'eng', name: 'build', depends_on: ['intent'] },
      ]),
      step: 'intent',
    })).toThrow(/"build" depends on it/);
  });

  it('refuses to edit a run that has already drifted from its pipeline', () => {
    const runState = run([record('po', 'intent'), record('qa', 'verify')]);
    expect(() => planRemoveEpicStep({
      runState,
      pipeline: pipeline([{ agent: 'qa', name: 'verify' }]),
      step: 'verify',
    })).toThrow(/does not currently match pipeline/);
  });

  /** "Sent back to step 3" has to keep meaning the step it meant. */
  it('rewrites the step indices recorded in history', () => {
    const withHistory: StepRecord = {
      ...record('qa', 'sign-off'),
      history: [{ kind: 'reject', at: '2026-01-01T00:00:00.000Z', revision: 1, sentBackToIdx: 2 }],
    };
    const runState = run([
      record('po', 'intent'),
      record('eng', 'build'),
      record('qa', 'verify'),
      withHistory,
    ]);
    const plan = planRemoveEpicStep({
      runState,
      pipeline: pipeline([
        { agent: 'po', name: 'intent' },
        { agent: 'eng', name: 'build' },
        { agent: 'qa', name: 'verify' },
        { agent: 'qa', name: 'sign-off' },
      ]),
      step: 'build',
    });
    const entry = plan.runState.steps[2].history?.[0] as { sentBackToIdx: number };
    expect(entry.sentBackToIdx).toBe(1);
  });

  it('completes a run whose last outstanding step is removed', () => {
    const runState = run(
      [record('po', 'intent', 'approved'), record('qa', 'verify')],
      { currentStepIdx: 1 },
    );
    const plan = planRemoveEpicStep({
      runState,
      pipeline: pipeline([{ agent: 'po', name: 'intent' }, { agent: 'qa', name: 'verify' }]),
      step: 'verify',
    });
    expect(plan.runState.status).toBe('completed');
  });
});

describe('planAddEpicStep', () => {
  it('appends by default, as a pending step in both lists', () => {
    const { runState, pipelineCfg } = midFlight();
    const plan = planAddEpicStep({
      runState,
      pipeline: pipelineCfg,
      step: { agent: 'reviewer', name: 'review', produces: ['review.md'] },
    });

    expect(plan.index).toBe(3);
    expect(plan.runState.steps.map((s) => s.name)).toEqual(['intent', 'build', 'verify', 'review']);
    expect(plan.runState.steps[3].status).toBe('pending');
    expect((plan.pipeline.steps[3] as { produces: string[] }).produces).toEqual(['review.md']);
  });

  it('honours --after and --before', () => {
    const { runState, pipelineCfg } = midFlight();
    expect(planAddEpicStep({
      runState, pipeline: pipelineCfg,
      step: { agent: 'qa', name: 'test-plan' },
      position: { after: 'build' },
    }).index).toBe(2);

    expect(planAddEpicStep({
      runState, pipeline: pipelineCfg,
      step: { agent: 'qa', name: 'test-plan' },
      position: { before: 'verify' },
    }).index).toBe(2);
  });

  /**
   * The rule that makes an insert safe: a step added behind the pointer would
   * sit pending for the rest of the run, since nothing ever goes back for it.
   */
  it('refuses to insert at or before a step that has already started', () => {
    const { runState, pipelineCfg } = midFlight();
    expect(() => planAddEpicStep({
      runState, pipeline: pipelineCfg,
      step: { agent: 'qa', name: 'test-plan' },
      position: { before: 'build' },
    })).toThrow(/"build" at index 1 is awaiting_work[\s\S]*earliest position available is 2/);
  });

  it('refuses an identity the pipeline already has', () => {
    const { runState, pipelineCfg } = midFlight();
    expect(() => planAddEpicStep({
      runState, pipeline: pipelineCfg, step: { agent: 'qa', name: 'verify' },
    })).toThrow(/already has a step called "verify"/);
  });

  /** Without a name a step is identified by its agent, and two of those clash. */
  it('asks for a name when an unnamed step would collide with its own agent', () => {
    const runState = run([
      { stepIdx: 0, agent: 'po', revision: 1, status: 'approved', artifactsProduced: [] },
      { stepIdx: 1, agent: 'eng', revision: 1, status: 'awaiting_work', artifactsProduced: [] },
    ], { currentStepIdx: 1 });
    expect(() => planAddEpicStep({
      runState,
      pipeline: pipeline([{ agent: 'po' }, { agent: 'eng' }]),
      step: { agent: 'eng' },
    })).toThrow(/Give the new step a `--name`/);
  });

  it('refuses a depends_on that names nothing', () => {
    const { runState, pipelineCfg } = midFlight();
    expect(() => planAddEpicStep({
      runState, pipeline: pipelineCfg,
      step: { agent: 'reviewer', name: 'review', depends_on: ['design'] },
    })).toThrow(/depends_on names "design"/);
  });

  /**
   * `advance` only ever opens a pending step whose `depends_on` are approved,
   * so in a DAG pipeline a step without one has nothing that can start it.
   */
  it('refuses a step with no depends_on in a DAG pipeline', () => {
    const runState = run([record('po', 'intent', 'approved'), record('eng', 'build', 'awaiting_work')], { currentStepIdx: 1 });
    const dag = pipeline([
      { agent: 'po', name: 'intent' },
      { agent: 'eng', name: 'build', depends_on: ['intent'] },
    ]);
    expect(() => planAddEpicStep({
      runState, pipeline: dag, step: { agent: 'qa', name: 'verify' },
    })).toThrow(/runs as a DAG[\s\S]*--depends-on build/);
  });

  it('puts a completed run back to running', () => {
    const runState = run([record('po', 'intent', 'approved')], { status: 'completed' });
    const plan = planAddEpicStep({
      runState,
      pipeline: pipeline([{ agent: 'po', name: 'intent' }]),
      step: { agent: 'qa', name: 'verify' },
    });
    expect(plan.runState.status).toBe('running');
  });

  it('is refused, like removal, once the run has drifted', () => {
    const runState = run([record('po', 'intent')]);
    expect(() => planAddEpicStep({
      runState,
      pipeline: pipeline([{ agent: 'qa', name: 'verify' }]),
      step: { agent: 'eng', name: 'build' },
    })).toThrow(EpicStepEditError);
  });
});

describe('commitEpicStepEdit', () => {
  function workspace(): { root: string; runState: RunState; pipelineCfg: PipelineConfig } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-stepedit-'));
    const { runState, pipelineCfg } = midFlight();
    fs.mkdirSync(path.join(root, 'docs', 'epics', 'EPIC-001'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'docs', 'epics', 'EPIC-001', 'state.json'),
      JSON.stringify({ id: 'EPIC-001', pipeline: 'EPIC-001', agents: [], stepStates: [] }, null, 2),
    );
    RunStateStore.save(root, runState);
    return { root, runState, pipelineCfg };
  }

  it('writes the run state and the epic mirror together', () => {
    const { root, runState, pipelineCfg } = workspace();
    const plan = planRemoveEpicStep({ runState, pipeline: pipelineCfg, step: 'verify' });

    let written: PipelineConfig | null = null;
    commitEpicStepEdit({
      workspaceRoot: root,
      doc: null,
      plan,
      writeWorkspace: (p) => { written = p; },
      restoreWorkspace: () => { throw new Error('should not roll back'); },
    });

    expect((written as unknown as PipelineConfig).steps).toHaveLength(2);
    expect(RunStateStore.load(root, 'EPIC-001')?.steps.map((s) => s.name)).toEqual(['intent', 'build']);

    const mirror = JSON.parse(
      fs.readFileSync(path.join(root, 'docs', 'epics', 'EPIC-001', 'state.json'), 'utf8'),
    ) as { stepStates: Array<{ name: string }>; agents: string[] };
    expect(mirror.stepStates.map((s) => s.name)).toEqual(['intent', 'build']);
    expect(mirror.agents).toEqual(['po', 'eng']);
  });

  /**
   * The definitions must never be left ahead of the history: a workspace that
   * was written for an edit whose run write failed gets put back.
   */
  it('rolls the workspace back when the run state cannot be saved', () => {
    const { root, runState, pipelineCfg } = workspace();
    const plan = planRemoveEpicStep({ runState, pipeline: pipelineCfg, step: 'verify' });
    const broken = { ...plan, runState: { ...plan.runState, runId: 'not a valid id' } };

    let restored = false;
    expect(() => commitEpicStepEdit({
      workspaceRoot: root,
      doc: null,
      plan: broken,
      writeWorkspace: () => { /* pretend it landed */ },
      restoreWorkspace: () => { restored = true; },
    })).toThrow();
    expect(restored).toBe(true);
  });
});
