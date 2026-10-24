import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  markStepDone,
  approveStep,
  rejectStep,
  submitAutoReviewVerdict,
  isRunComplete,
  deriveRunProgress,
  weighStepProgress,
  effectiveDependsOn,
  disabledStepIssues,
  planSetEpicStepEnabled,
  scaffoldEpic,
  RunStateStore,
  EpicStepEditError,
  PipelineRunError,
  type PipelineConfig,
  type RunState,
} from '../src';
import { nextEligiblePhase } from '../src/presets/commandModel';

/**
 * `enabled: false` on a step: never opened, recorded `skipped`, and a
 * dependency on it resolves to what it depended on. CR-261023-00 is the case
 * that found it — `cr-build` and `cr-review` disabled, and `cr-close` waited
 * on them forever.
 */

function pipeline(steps: Array<Record<string, unknown>>, id = 'P'): PipelineConfig {
  return { id, on_failure: 'stop', steps } as unknown as PipelineConfig;
}

/** The `cr-internal` recipe as a DAG, with the given steps switched off. */
function crInternal(disabled: string[] = [], dag = true): PipelineConfig {
  const names = ['cr-intake', 'cr-build-spec', 'cr-build', 'cr-review', 'cr-close'];
  return pipeline(names.map((name, i) => ({
    name,
    agent: name,
    ...(dag && i > 0 ? { depends_on: [names[i - 1]] } : {}),
    ...(name === 'cr-build-spec' ? { human_review: true } : {}),
    ...(disabled.includes(name) ? { enabled: false } : {}),
  })), 'cr-internal');
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-disabled-'));

function done(state: RunState, p: PipelineConfig, stepIdx: number): RunState {
  return markStepDone({ state, pipeline: p, workspaceRoot: ws, stepIdx });
}

const statuses = (s: RunState): string[] => s.steps.map((r) => r.status);

describe('disabled steps — the CR-261023-00 repro', () => {
  for (const dag of [true, false]) {
    describe(dag ? 'DAG' : 'legacy linear', () => {
      const p = crInternal(['cr-build', 'cr-review'], dag);

      it('starts with the disabled steps skipped', () => {
        const s = startRun({ runId: 'CR-261023-00', pipeline: p, context: {} });
        expect(statuses(s)).toEqual(['awaiting_work', 'pending', 'skipped', 'skipped', 'pending']);
      });

      it('opens cr-close once cr-build-spec is approved', () => {
        let s = startRun({ runId: 'CR-261023-00', pipeline: p, context: {} });
        s = done(s, p, 0);
        expect(s.steps[1].status).toBe('awaiting_work');
        s = done(s, p, 1);
        s = approveStep({ state: s, pipeline: p, stepIdx: 1 });
        expect(statuses(s)).toEqual(['approved', 'approved', 'skipped', 'skipped', 'awaiting_work']);
        expect(s.currentStepIdx).toBe(4);

        s = done(s, p, 4);
        expect(s.status).toBe('completed');
        expect(isRunComplete(s, p)).toBe(true);
        expect(deriveRunProgress(s, p).status).toBe('done');
      });
    });
  }

  it('resolves cr-close through both disabled steps to cr-build-spec', () => {
    expect(effectiveDependsOn(crInternal(['cr-build', 'cr-review']))[4]).toEqual(['cr-build-spec']);
  });

  it('leaves a pipeline with nothing disabled exactly as it was', () => {
    const p = crInternal();
    expect(effectiveDependsOn(p)).toEqual(p.steps.map((s) => (s as { depends_on?: string[] }).depends_on ?? []));
    expect(statuses(startRun({ runId: 'R', pipeline: p, context: {} })))
      .toEqual(['awaiting_work', 'pending', 'pending', 'pending', 'pending']);
  });
});

describe('disabled steps — shapes', () => {
  it('a disabled leaf: approving the step before it completes the run', () => {
    const p = pipeline([
      { name: 'a', agent: 'a' },
      { name: 'b', agent: 'b', depends_on: ['a'] },
      { name: 'c', agent: 'c', depends_on: ['b'], enabled: false },
    ]);
    let s = startRun({ runId: 'R', pipeline: p, context: {} });
    s = done(s, p, 0);
    s = done(s, p, 1);
    expect(statuses(s)).toEqual(['approved', 'approved', 'skipped']);
    expect(s.status).toBe('completed');
  });

  it('a disabled leaf on a sequential pipeline completes too', () => {
    const p = pipeline([{ agent: 'a' }, { agent: 'b', enabled: false }]);
    let s = startRun({ runId: 'R', pipeline: p, context: {} });
    s = done(s, p, 0);
    expect(s.status).toBe('completed');
  });

  it('a disabled middle step in a chain is passed over', () => {
    const p = pipeline([
      { name: 'a', agent: 'a' },
      { name: 'b', agent: 'b', depends_on: ['a'], enabled: false },
      { name: 'c', agent: 'c', depends_on: ['b'] },
    ]);
    let s = startRun({ runId: 'R', pipeline: p, context: {} });
    s = done(s, p, 0);
    expect(statuses(s)).toEqual(['approved', 'skipped', 'awaiting_work']);
  });

  it('a disabled step with two dependents opens both', () => {
    const p = pipeline([
      { name: 'a', agent: 'a' },
      { name: 'b', agent: 'b', depends_on: ['a'], enabled: false },
      { name: 'c', agent: 'c', depends_on: ['b'] },
      { name: 'd', agent: 'd', depends_on: ['b'] },
    ]);
    let s = startRun({ runId: 'R', pipeline: p, context: {} });
    s = done(s, p, 0);
    expect(statuses(s)).toEqual(['approved', 'skipped', 'awaiting_work', 'awaiting_work']);
  });

  it('a disabled root makes its dependents roots', () => {
    const p = pipeline([
      { name: 'a', agent: 'a', enabled: false },
      { name: 'b', agent: 'b', depends_on: ['a'] },
    ]);
    const s = startRun({ runId: 'R', pipeline: p, context: {} });
    expect(statuses(s)).toEqual(['skipped', 'awaiting_work']);
    expect(s.currentStepIdx).toBe(1);
  });

  it('a disabled first step on a sequential pipeline starts the run at the next one', () => {
    const p = pipeline([{ agent: 'a', enabled: false }, { agent: 'b' }]);
    const s = startRun({ runId: 'R', pipeline: p, context: {} });
    expect(statuses(s)).toEqual(['skipped', 'awaiting_work']);
    expect(s.currentStepIdx).toBe(1);
  });

  it('refuses to start a pipeline with every step disabled', () => {
    const p = pipeline([{ agent: 'a', enabled: false }]);
    expect(() => startRun({ runId: 'R', pipeline: p, context: {} })).toThrow(PipelineRunError);
  });

  it('a disabled step that is still pending in an older run is skipped on the next advance', () => {
    const p = pipeline([
      { name: 'a', agent: 'a' },
      { name: 'b', agent: 'b', depends_on: ['a'], enabled: false },
      { name: 'c', agent: 'c', depends_on: ['b'] },
    ]);
    // Started before `b` was switched off by hand, so the run still has it pending.
    let s = startRun({ runId: 'R', pipeline: p, context: {} });
    s = { ...s, steps: s.steps.map((r, i) => ({ ...r, status: i === 0 ? 'awaiting_work' : 'pending' })) };
    s = done(s, p, 0);
    expect(statuses(s)).toEqual(['approved', 'skipped', 'awaiting_work']);
  });

  it('the next eligible phase is never a disabled step', () => {
    const p = crInternal(['cr-build', 'cr-review']);
    const s = startRun({ runId: 'R', pipeline: p, context: {} });
    s.steps[0].status = 'approved';
    s.steps[1].status = 'approved';
    expect(nextEligiblePhase(s, p)?.phaseId).toBe('cr-close');
  });
});

describe('disabled steps — send-back', () => {
  const withRoute = (target: string): PipelineConfig => pipeline([
    { name: 'spec', agent: 'pm' },
    { name: 'build', agent: 'dev', depends_on: ['spec'], enabled: false },
    { name: 'fix', agent: 'dev2', depends_on: ['build'] },
    {
      name: 'review', agent: 'rev', depends_on: ['fix'],
      auto_review: true, auto_review_runner: 'v.mjs', on_reject: { send_back_to: target },
    },
  ]);

  function atReview(p: PipelineConfig): RunState {
    const s = startRun({ runId: 'R', pipeline: p, context: {} });
    s.steps[0].status = 'approved';
    s.steps[2].status = 'approved';
    s.steps[3].status = 'awaiting_auto_review';
    s.currentStepIdx = 3;
    return s;
  }

  const verdict = { decision: 'reject' as const, reason: 'no', at: '2026-10-24T00:00:00.000Z', runner: 'v.mjs' };

  it('an on_reject into a disabled step stops with a reason instead of stalling', () => {
    const p = withRoute('build');
    const s = submitAutoReviewVerdict({ state: atReview(p), pipeline: p, verdict });
    expect(s.steps[3].status).toBe('rejected');
    expect(s.steps[3].rejectReason).toMatch(/"build" is disabled/);
    expect(s.steps[1].status).toBe('skipped');
  });

  it('a send-back across a disabled step leaves it skipped', () => {
    const p = withRoute('spec');
    const s = submitAutoReviewVerdict({ state: atReview(p), pipeline: p, verdict });
    expect(statuses(s)).toEqual(['awaiting_work', 'skipped', 'pending', 'pending']);
  });

  it('a validator asking for a disabled step is refused the same way', () => {
    const p = withRoute('spec');
    const s = submitAutoReviewVerdict({ state: atReview(p), pipeline: p, verdict: { ...verdict, sendBackTo: 'build' } });
    expect(s.steps[3].status).toBe('rejected');
    expect(s.steps[3].rejectReason).toMatch(/disabled/);
  });

  it('a human send-back to a disabled step is an error', () => {
    const p = pipeline([
      { agent: 'a', enabled: false },
      { agent: 'b' },
      { agent: 'c', human_review: true },
    ]);
    const s = startRun({ runId: 'R', pipeline: p, context: {} });
    s.steps[1].status = 'approved';
    s.steps[2].status = 'awaiting_review';
    s.currentStepIdx = 2;
    expect(() => rejectStep({ state: s, pipeline: p, stepIdx: 2, targetIdx: 0, reason: 'x' }))
      .toThrow(/disabled/);
    // The sequential reset range runs over a skipped step without touching it.
    const back = rejectStep({ state: s, pipeline: p, stepIdx: 2, targetIdx: 1, reason: 'x' });
    expect(statuses(back)).toEqual(['skipped', 'awaiting_work', 'pending']);
  });
});

describe('planSetEpicStepEnabled — toggling a running epic', () => {
  function runAt(p: PipelineConfig, approved: number[]): RunState {
    let s = startRun({ runId: 'CR-261023-00', pipeline: p, context: {} });
    for (const i of approved) {
      s = done(s, p, i);
      if (s.steps[i].status === 'awaiting_review') { s = approveStep({ state: s, pipeline: p, stepIdx: i }); }
    }
    return s;
  }

  it('disabling the open steps opens what waited on them', () => {
    let p = crInternal();
    const s = runAt(p, [0, 1]);
    expect(s.steps[2].status).toBe('awaiting_work');

    const first = planSetEpicStepEnabled({ runState: s, pipeline: p, step: 'cr-build', enabled: false });
    expect(first.changed).toBe(true);
    expect((first.pipeline.steps[2] as { enabled?: boolean }).enabled).toBe(false);
    // cr-review now waits on cr-build-spec, which is approved.
    expect(statuses(first.runState)).toEqual(['approved', 'approved', 'skipped', 'awaiting_work', 'pending']);
    expect(first.opened).toEqual(['cr-review']);

    p = first.pipeline;
    const second = planSetEpicStepEnabled({ runState: first.runState, pipeline: p, step: 'cr-review', enabled: false });
    expect(statuses(second.runState)).toEqual(['approved', 'approved', 'skipped', 'skipped', 'awaiting_work']);
    expect(second.runState.currentStepIdx).toBe(4);
  });

  it('re-enabling a skipped step reopens it and closes untouched downstream work', () => {
    const p = crInternal(['cr-build', 'cr-review']);
    const s = runAt(p, [0, 1]);
    expect(s.steps[4].status).toBe('awaiting_work');

    const plan = planSetEpicStepEnabled({ runState: s, pipeline: p, step: 'cr-review', enabled: true });
    expect((plan.pipeline.steps[3] as { enabled?: boolean }).enabled).toBeUndefined();
    expect(statuses(plan.runState)).toEqual(['approved', 'approved', 'skipped', 'awaiting_work', 'pending']);
    // The cursor was on cr-close, which just closed again.
    expect(plan.runState.currentStepIdx).toBe(3);
  });

  it('refuses to re-enable a step something after it has already worked past', () => {
    const p = crInternal(['cr-build', 'cr-review']);
    const s = runAt(p, [0, 1, 4]);
    expect(s.status).toBe('completed');
    expect(() => planSetEpicStepEnabled({ runState: s, pipeline: p, step: 'cr-review', enabled: true }))
      .toThrow(/already approved/);
  });

  it('refuses to disable a step that has done work', () => {
    const p = crInternal();
    const s = runAt(p, [0]);
    expect(() => planSetEpicStepEnabled({ runState: s, pipeline: p, step: 'cr-intake', enabled: false }))
      .toThrow(EpicStepEditError);
  });

  it('refuses to disable the last enabled step', () => {
    const p = pipeline([{ agent: 'a' }, { agent: 'b', enabled: false }]);
    const s = startRun({ runId: 'R', pipeline: p, context: {} });
    expect(() => planSetEpicStepEnabled({ runState: s, pipeline: p, step: 'a', enabled: false }))
      .toThrow(/last enabled step/);
  });

  it('is a no-op when the step already has the setting', () => {
    const p = crInternal(['cr-build']);
    const s = runAt(p, []);
    const plan = planSetEpicStepEnabled({ runState: s, pipeline: p, step: 'cr-build', enabled: false });
    expect(plan.changed).toBe(false);
    expect(plan.runState).toBe(s);
  });

  it('brings a run in line with a step disabled by hand in pipeline.yaml', () => {
    // CR-261023-00: started with every step enabled, then `enabled: false`
    // typed into the epic's pipeline.yaml while cr-build-spec was open.
    const s = runAt(crInternal(), [0]);
    const p = crInternal(['cr-build', 'cr-review']);
    expect(statuses(s)).toEqual(['approved', 'awaiting_work', 'pending', 'pending', 'pending']);
    const first = planSetEpicStepEnabled({ runState: s, pipeline: p, step: 'cr-build', enabled: false });
    expect(first.changed).toBe(true);
    expect(first.pipeline.steps).toEqual(p.steps);
    const second = planSetEpicStepEnabled({ runState: first.runState, pipeline: p, step: 'cr-review', enabled: false });
    expect(statuses(second.runState)).toEqual(['approved', 'awaiting_work', 'skipped', 'skipped', 'pending']);
  });

  it('works on a sequential pipeline', () => {
    const p = crInternal([], false);
    const s = runAt(p, [0, 1]);
    const plan = planSetEpicStepEnabled({ runState: s, pipeline: p, step: 'cr-build', enabled: false });
    expect(statuses(plan.runState)).toEqual(['approved', 'approved', 'skipped', 'awaiting_work', 'pending']);
  });
});

describe('disabledStepIssues — aidlc doctor', () => {
  it('says nothing about a pipeline with nothing disabled', () => {
    expect(disabledStepIssues(crInternal())).toEqual([]);
  });

  it('the repro pipeline is clean', () => {
    expect(disabledStepIssues(crInternal(['cr-build', 'cr-review']))).toEqual([]);
  });

  it('flags a required file only a disabled step produces', () => {
    const p = pipeline([
      { name: 'a', agent: 'a', produces: ['spec.md'], enabled: false },
      { name: 'b', agent: 'b', requires: ['spec.md'] },
      { name: 'c', agent: 'c', requires: [{ path: 'spec.md', optional: true }] },
    ]);
    const issues = disabledStepIssues(p);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ stepIdx: 1, severity: 'error' });
    expect(issues[0].message).toMatch(/requires spec\.md/);
  });

  it('does not flag a file an enabled step also produces', () => {
    const p = pipeline([
      { name: 'a', agent: 'a', produces: ['spec.md'], enabled: false },
      { name: 'a2', agent: 'a2', produces: ['spec.md'] },
      { name: 'b', agent: 'b', requires: ['spec.md'] },
    ]);
    expect(disabledStepIssues(p)).toEqual([]);
  });

  it('flags an enabled step with no path to a root', () => {
    const p = pipeline([
      { name: 'a', agent: 'a' },
      { name: 'b', agent: 'b', depends_on: ['ghost'], enabled: false },
      { name: 'c', agent: 'c', depends_on: ['b'] },
    ]);
    const issues = disabledStepIssues(p);
    expect(issues.map((i) => [i.stepIdx, i.severity])).toEqual([[2, 'error']]);
    expect(issues[0].message).toMatch(/no path to a root/);
  });

  it('flags a send-back into a disabled step — a warning when the sender is off too', () => {
    const route = { auto_review: true, auto_review_runner: 'v.mjs', on_reject: { send_back_to: 'a' } };
    const on = pipeline([{ name: 'a', agent: 'a', enabled: false }, { name: 'b', agent: 'b', ...route }]);
    expect(disabledStepIssues(on).map((i) => i.severity)).toEqual(['error']);
    const off = pipeline([
      { name: 'a', agent: 'a', enabled: false },
      { name: 'b', agent: 'b', enabled: false, ...route },
      { name: 'c', agent: 'c' },
    ]);
    expect(disabledStepIssues(off).map((i) => i.severity)).toEqual(['warning']);
  });

  it('flags a pipeline with every step disabled', () => {
    expect(disabledStepIssues(pipeline([{ agent: 'a', enabled: false }]))[0].message).toMatch(/Every step/);
  });
});

describe('weighStepProgress — skipped steps take no stage', () => {
  it('ranks a step behind skipped ones by what they waited on', () => {
    const w = weighStepProgress([
      { id: 'a', done: true },
      { id: 'b', dependsOn: ['a'], done: false, skipped: true },
      { id: 'c', dependsOn: ['b'], done: false },
    ]);
    expect(w.ranks).toEqual([0, -1, 1]);
    expect(w.stages).toBe(2);
    expect(w.percent).toBe(50);
  });

  it('drops skipped steps from a sequential count', () => {
    const w = weighStepProgress([
      { id: 'a', done: true },
      { id: 'b', done: false, skipped: true },
      { id: 'c', done: false },
    ]);
    expect(w.stages).toBe(2);
    expect(w.percent).toBe(50);
  });
});

describe('scaffoldEpic — disabled steps in both state files', () => {
  it('writes them skipped in state.json and in the run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-disabled-scaffold-'));
    const p = crInternal(['cr-build', 'cr-review']);
    scaffoldEpic({
      workspaceRoot: root,
      doc: { pipelines: [p] } as never,
      epicId: 'CR-261023-00',
      title: 't',
      description: '',
      target: { kind: 'pipeline', id: p.id },
      agents: p.steps.map((s) => (s as { agent: string }).agent),
      inputs: {},
      pipeline: p,
    });
    const run = RunStateStore.load(root, 'CR-261023-00')!;
    expect(statuses(run)).toEqual(['awaiting_work', 'pending', 'skipped', 'skipped', 'pending']);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'docs/epics/CR-261023-00/state.json'), 'utf8'));
    expect(state.stepStates.map((s: { status: string }) => s.status))
      .toEqual(['in_progress', 'pending', 'skipped', 'skipped', 'pending']);
  });
});
