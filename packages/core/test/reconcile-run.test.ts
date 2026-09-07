import { describe, it, expect } from 'vitest';

import {
  reconcileRunSteps,
  describeDrift,
  withBackfilledStepNames,
  stepIdentity,
  migrateRunState,
  markStepDone,
  approveStep,
  startRun,
  RUN_STATE_SCHEMA_VERSION,
  type RunState,
  type StepRecord,
  type PipelineConfig,
} from '../src';

/**
 * A run's history is keyed by step, and every transition addresses steps by
 * index. These tests pin the thing that makes those two facts compatible:
 * the run and its pipeline are compared by identity (`name ?? agent`), so a
 * pipeline that has been reshaped underneath a live run is refused instead of
 * being replayed onto whatever now sits at those indices.
 */

function pipeline(
  steps: Array<{ agent: string; name?: string }>,
  id = 'p1',
): PipelineConfig {
  return { id, steps } as unknown as PipelineConfig;
}

function record(agent: string, name?: string, stepIdx = 0): StepRecord {
  return {
    stepIdx,
    agent,
    ...(name === undefined ? {} : { name }),
    revision: 1,
    status: 'pending',
    artifactsProduced: [],
  };
}

function run(steps: StepRecord[], overrides: Partial<RunState> = {}): RunState {
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: 'EPIC-001',
    pipelineId: 'p1',
    context: {},
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    currentStepIdx: 0,
    status: 'running',
    steps: steps.map((s, i) => ({ ...s, stepIdx: i })),
    ...overrides,
  } as RunState;
}

describe('stepIdentity', () => {
  it('prefers the name, so two steps on one persona stay distinct', () => {
    expect(stepIdentity(record('qa', 'test-plan'))).toBe('test-plan');
    expect(stepIdentity(record('qa', 'test-cases'))).toBe('test-cases');
  });

  it('falls back to the agent when the step has no name', () => {
    expect(stepIdentity(record('qa'))).toBe('qa');
  });
});

describe('reconcileRunSteps', () => {
  it('reports an untouched pipeline as aligned', () => {
    const r = reconcileRunSteps(
      run([record('a', 'intent'), record('b', 'spec')]),
      pipeline([{ agent: 'a', name: 'intent' }, { agent: 'b', name: 'spec' }]),
    );
    expect(r.aligned).toBe(true);
    expect(r.alignments.every((x) => x.kind === 'matched')).toBe(true);
    expect(describeDrift(r)).toBeNull();
  });

  /**
   * The failure that motivated all of this: with only an index guard, a
   * shortened pipeline still satisfied every check, so the run kept going
   * against steps that had shifted under it.
   */
  it('catches a removed step, which no index check ever could', () => {
    const r = reconcileRunSteps(
      run([record('a', 'intent'), record('b', 'spec'), record('c', 'build')]),
      pipeline([{ agent: 'b', name: 'spec' }, { agent: 'c', name: 'build' }]),
    );
    expect(r.aligned).toBe(false);
    expect(r.removed).toEqual(['intent']);
    expect(r.moved).toEqual(['spec', 'build']);
    expect(describeDrift(r)).toContain('"intent" no longer in the pipeline');
  });

  it('catches a step appended to the pipeline', () => {
    const r = reconcileRunSteps(
      run([record('a', 'intent')]),
      pipeline([{ agent: 'a', name: 'intent' }, { agent: 'z', name: 'deploy' }]),
    );
    expect(r.aligned).toBe(false);
    expect(r.added).toEqual(['deploy']);
    expect(r.removed).toEqual([]);
  });

  it('catches a reorder, where the length gives nothing away', () => {
    const r = reconcileRunSteps(
      run([record('a', 'intent'), record('b', 'spec')]),
      pipeline([{ agent: 'b', name: 'spec' }, { agent: 'a', name: 'intent' }]),
    );
    expect(r.aligned).toBe(false);
    expect(r.moved.sort()).toEqual(['intent', 'spec']);
  });

  it('pairs two steps sharing one persona in order', () => {
    const r = reconcileRunSteps(
      run([record('eng', 'build'), record('eng', 'review')]),
      pipeline([{ agent: 'eng', name: 'build' }, { agent: 'eng', name: 'review' }]),
    );
    expect(r.aligned).toBe(true);
  });

  it('sees through a swap of two steps that share a persona', () => {
    const r = reconcileRunSteps(
      run([record('eng', 'build'), record('eng', 'review')]),
      pipeline([{ agent: 'eng', name: 'review' }, { agent: 'eng', name: 'build' }]),
    );
    expect(r.aligned).toBe(false);
    expect(r.moved.sort()).toEqual(['build', 'review']);
  });

  /**
   * `name` is additive: run files written before it existed carry only an
   * agent, and their pipeline steps may well be named. Calling that drift
   * would declare every pre-existing run broken.
   */
  it('does not call a pre-schema-2 record drifted for lacking a name', () => {
    const r = reconcileRunSteps(
      run([record('a'), record('b')]),
      pipeline([{ agent: 'a', name: 'intent' }, { agent: 'b', name: 'spec' }]),
    );
    expect(r.aligned).toBe(true);
  });
});

describe('withBackfilledStepNames', () => {
  it('fills a legacy record in from the pipeline it still matches', () => {
    const next = withBackfilledStepNames(
      run([record('a'), record('b')]),
      pipeline([{ agent: 'a', name: 'intent' }, { agent: 'b', name: 'spec' }]),
    );
    expect(next.steps.map((s) => s.name)).toEqual(['intent', 'spec']);
  });

  it('returns the same object when there is nothing to fill in', () => {
    const before = run([record('a', 'intent')]);
    expect(withBackfilledStepNames(before, pipeline([{ agent: 'a', name: 'intent' }])))
      .toBe(before);
  });

  /**
   * Stamping names onto a drifted run would be inventing history: once the
   * shapes disagree, position is no longer evidence of anything.
   */
  it('refuses to name steps once the shapes already disagree', () => {
    const before = run([record('a'), record('b')]);
    const after = withBackfilledStepNames(before, pipeline([{ agent: 'b', name: 'spec' }]));
    expect(after).toBe(before);
    expect(after.steps.every((s) => s.name === undefined)).toBe(true);
  });
});

describe('migrateRunState', () => {
  it('raises a version-1 file to the current schema, fields intact', () => {
    const legacy = { ...run([record('a')]), schemaVersion: 1 };
    const migrated = migrateRunState(legacy);
    expect(migrated?.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(migrated?.steps).toHaveLength(1);
  });

  it('passes a current file through untouched', () => {
    const current = run([record('a', 'intent')]);
    expect(migrateRunState(current)).toBe(current);
  });

  it('declines a version it does not know and anything malformed', () => {
    expect(migrateRunState({ ...run([]), schemaVersion: 99 })).toBeNull();
    expect(migrateRunState({ schemaVersion: 1, runId: 'x' })).toBeNull();
    expect(migrateRunState(null)).toBeNull();
    expect(migrateRunState('nope')).toBeNull();
  });
});

describe('the runner refuses a drifted run', () => {
  const cfg = pipeline([
    { agent: 'a', name: 'intent' },
    { agent: 'b', name: 'spec' },
  ]);

  it('startRun records each step name', () => {
    const state = startRun({ runId: 'EPIC-001', pipeline: cfg, context: {} });
    expect(state.steps.map((s) => s.name)).toEqual(['intent', 'spec']);
    expect(state.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
  });

  it('markStepDone throws once a step has been dropped from the pipeline', () => {
    const state = startRun({ runId: 'EPIC-001', pipeline: cfg, context: {} });
    expect(() =>
      markStepDone({
        state,
        pipeline: pipeline([{ agent: 'b', name: 'spec' }]),
        workspaceRoot: process.cwd(),
      }),
    ).toThrow(/no longer matches pipeline .* "intent" no longer in the pipeline/);
  });

  it('names `aidlc step skip` as the supported way to drop a step', () => {
    const state = startRun({ runId: 'EPIC-001', pipeline: cfg, context: {} });
    expect(() =>
      approveStep({ state, pipeline: pipeline([{ agent: 'b', name: 'spec' }]) }),
    ).toThrow(/aidlc step skip EPIC-001 <index>/);
  });

  it('still runs a legacy run whose records have no names', () => {
    const legacy = run(
      [
        { ...record('a'), status: 'awaiting_review' as const },
        record('b'),
      ],
    );
    expect(() => approveStep({ state: legacy, pipeline: cfg })).not.toThrow();
  });
});
