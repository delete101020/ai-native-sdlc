/**
 * An auto-review reject sends the work back (`on_reject`), bounded by
 * `max_send_backs` and by a check that the code actually changed; one exec
 * loop per run. See AUTOPILOT_READINESS.md §G2, §G4 and §4 (R5).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  markStepDone,
  approveStep,
  rejectStep,
  submitAutoReviewVerdict,
  runExecLoop,
  assemblePipeline,
  sendBackIssues,
  validateWorkspace,
  RunStateStore,
  WorkspaceLoader,
} from '../src/index';
import type { AutoReviewVerdict, PipelineConfig, RunState, WorkspaceConfig } from '../src/index';
import { codeFingerprint } from '../src/runs/codeFingerprint';
import { acquireRunLock, runLockFile } from '../src/runs/runLock';

const pipeline = {
  id: 'p',
  steps: [
    { name: 'spec', agent: 'pm', human_review: true },
    { name: 'implement', agent: 'dev' },
    { name: 'verify', agent: 'qa' },
    {
      name: 'review', agent: 'rev', auto_review: true, auto_review_runner: 'v.mjs',
      on_reject: { send_back_to: 'implement' },
    },
  ],
  on_failure: 'stop',
} as PipelineConfig;

/** The run with review done and waiting on its validator. */
function atReview(p: PipelineConfig = pipeline, sendBacks?: number): RunState {
  const s = startRun({ runId: 'R', pipeline: p, context: {} });
  s.steps.forEach((r, i) => { r.status = i < 3 ? 'approved' : 'awaiting_auto_review'; });
  s.currentStepIdx = 3;
  if (sendBacks !== undefined) { s.sendBacks = sendBacks; }
  return s;
}

function reject(extra: Partial<AutoReviewVerdict> = {}, p: PipelineConfig = pipeline, sendBacks?: number): RunState {
  return submitAutoReviewVerdict({
    state: atReview(p, sendBacks),
    pipeline: p,
    verdict: { decision: 'reject', reason: 'null check missing', at: '2026-10-17T00:00:00.000Z', runner: 'v.mjs', ...extra },
  });
}

describe('submitAutoReviewVerdict — where a reject goes', () => {
  it('sends the work back to on_reject.send_back_to', () => {
    const s = reject();
    expect(s.currentStepIdx).toBe(1);
    expect(s.sendBacks).toBe(1);
    expect(s.steps.map((r) => r.status)).toEqual(['approved', 'awaiting_work', 'pending', 'pending']);
    expect(s.steps[1].revision).toBe(2);
    expect(s.steps[1].feedback).toBe('Rejected at step 4 (review): null check missing');
    // The validator's own entry survives next to the reject that routed it.
    expect(s.steps[3].history!.map((h) => h.kind)).toEqual(['auto_review', 'reject']);
    expect(s.steps[3].history![1]).toMatchObject({ kind: 'reject', sentBackToIdx: 1, source: 'config' });
  });

  it('records a target the verdict confirmed as the verdict\'s', () => {
    for (const sendBackTo of ['implement', 'dev', 1]) {
      const s = reject({ sendBackTo });
      expect(s.currentStepIdx).toBe(1);
      expect(s.steps[3].history!.at(-1)).toMatchObject({ sentBackToIdx: 1, source: 'verdict' });
    }
  });

  it('stops in place when the verdict says so', () => {
    for (const sendBackTo of [null, 'review', 3]) {
      const s = reject({ sendBackTo });
      expect(s.currentStepIdx).toBe(3);
      expect(s.steps[3].status).toBe('rejected');
      expect(s.steps[3].rejectReason).toBe('null check missing');
      expect(s.sendBacks).toBeUndefined();
    }
  });

  it('hands a step on_reject does not name back to a person', () => {
    const s = reject({ sendBackTo: 'spec' });
    expect(s.currentStepIdx).toBe(0);
    expect(s.steps.map((r) => r.status)).toEqual(['awaiting_work', 'pending', 'pending', 'pending']);
    expect(s.steps[0].feedback).toBe('Rejected at step 4 (review): null check missing');
    expect(s.steps[3].history!.at(-1)).toMatchObject({ kind: 'reject', sentBackToIdx: 0, source: 'handoff' });
  });

  it('lets a person send a validator-rejected step back', () => {
    const s = rejectStep({ state: { ...reject({ sendBackTo: null }), sendBacks: 2 }, pipeline, reason: 'agreed', targetIdx: 0 });
    expect(s.currentStepIdx).toBe(0);
    expect(s.steps[0].status).toBe('awaiting_work');
    expect(s.sendBacks).toBeUndefined();
    // An in-place reject of a step that is already rejected still is refused.
    expect(() => rejectStep({ state: reject({ sendBackTo: null }), pipeline, reason: 'x' })).toThrow(/expected "awaiting_review"/);
  });

  it('stops on a target it cannot resolve', () => {
    for (const sendBackTo of ['nope', 9, 'review-later']) {
      const s = reject({ sendBackTo });
      expect(s.steps[3].status).toBe('rejected');
      expect(s.steps[3].rejectReason).toContain(`asked to send this back to "${sendBackTo}", which is not a step before this one`);
    }
  });

  it('rejects in place, as before, without on_reject', () => {
    const plain = { ...pipeline, steps: pipeline.steps.map((st, i) => (i === 3 ? { ...(st as object), on_reject: undefined } : st)) } as PipelineConfig;
    const s = reject({}, plain);
    expect(s.steps[3].status).toBe('rejected');
    expect(s.steps[3].rejectReason).toBe('null check missing');
    expect(s.steps[3].history!.at(-1)).toMatchObject({ sentBackToIdx: 3 });
    expect(s.steps[3].history!.at(-1)).not.toHaveProperty('source');
    const suggested = reject({ sendBackTo: 'implement' }, plain);
    expect(suggested.currentStepIdx).toBe(1);
    expect(suggested.steps[3].history!.at(-1)).toMatchObject({ sentBackToIdx: 1, source: 'handoff' });
  });
});

describe('max_send_backs', () => {
  it('stops at the ceiling and says which one', () => {
    expect(reject({}, pipeline, 2).sendBacks).toBe(3);
    const s = reject({}, pipeline, 3);
    expect(s.currentStepIdx).toBe(3);
    expect(s.steps[3].status).toBe('rejected');
    expect(s.steps[3].rejectReason).toBe(
      'null check missing\n\nSent back 3 times already (max_send_backs: 3) — stopping for a human instead of going round again.',
    );
  });

  it('honours the pipeline\'s own value, 0 included', () => {
    const none = { ...pipeline, max_send_backs: 0 };
    expect(reject({}, none).steps[3].rejectReason).toContain('Sent back 0 times already (max_send_backs: 0)');
    expect(reject({}, { ...pipeline, max_send_backs: 5 }, 4).currentStepIdx).toBe(1);
  });

  it('starts counting again once a person acts', () => {
    const s = startRun({ runId: 'R', pipeline, context: {} });
    s.sendBacks = 3;
    const done = markStepDone({ state: s, pipeline, workspaceRoot: os.tmpdir() });
    expect(done.sendBacks).toBe(3); // the loop marking a step done is not a person
    expect(approveStep({ state: done, pipeline }).sendBacks).toBeUndefined();
  });
});

describe('on_reject — checked before any run', () => {
  const steps = (target: string, extra: object = {}) => [
    { name: 'plan', agent: 'pm', human_review: true },
    { name: 'implement', agent: 'dev' },
    { name: 'review', agent: 'rev', auto_review: true, auto_review_runner: 'v.mjs', on_reject: { send_back_to: target }, ...extra },
  ];

  it('accepts an earlier step with no human gate', () => {
    expect(sendBackIssues(steps('implement'))).toEqual([]);
  });

  it('names what is wrong', () => {
    expect(sendBackIssues(steps('nope'))[0].message).toBe('Step "review": `on_reject.send_back_to` "nope" is not a step of this pipeline.');
    expect(sendBackIssues(steps('review'))[0].message).toContain('must be a step before this one');
    expect(sendBackIssues(steps('plan'))[0].message).toContain('"plan" has `human_review: true`');
    expect(sendBackIssues(steps('implement', { auto_review: false }))[0].message).toContain('this step has `auto_review` off');
  });

  it('fails workspace.yaml at load', () => {
    expect(() => validateWorkspace({
      version: '1.0', name: 'w', pipelines: [{ id: 'p', steps: steps('plan') }],
    }, 'workspace.yaml')).toThrow(/pipelines\.0\.steps\.2\.on_reject\.send_back_to: Step "review": .*"plan" has `human_review: true`/);
  });

  it('carries a recipe gate into the assembled pipeline, and refuses a bad one', () => {
    const config = {
      agents: ['pm', 'dev', 'rev'].map((id) => ({ id, name: id, skills: [], runner: 'claude' })),
      skills: [],
      pipelines: [{ id: 'src', steps: steps('implement', { on_reject: undefined }), on_failure: 'stop', max_send_backs: 2 }],
      recipes: [
        { id: 'auto', steps: ['plan', 'implement', 'review'], gates: { review: { on_reject: { send_back_to: 'implement' } } } },
        { id: 'gated', steps: ['plan', 'implement', 'review'], gates: { implement: { human_review: true }, review: { on_reject: { send_back_to: 'implement' } } } },
      ],
    } as unknown as WorkspaceConfig;
    const p = assemblePipeline(config, { recipeId: 'auto' });
    expect(p.steps[2]).toMatchObject({ on_reject: { send_back_to: 'implement' } });
    expect(p.max_send_backs).toBe(2);
    expect(() => assemblePipeline(config, { recipeId: 'gated' })).toThrow(/"implement" has `human_review: true`/);
  });
});

// ── The loop, against a real git checkout ───────────────────────────────────

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function gitRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-send-back-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'src.txt'), 'initial\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

describe('codeFingerprint', () => {
  it('moves with the code and with nothing else', () => {
    const root = gitRoot();
    const skip = ['docs/epics/R-1', '.aidlc'];
    const base = codeFingerprint(root, skip)!;
    expect(base).toMatch(/^[0-9a-f]{40}$/);

    fs.mkdirSync(path.join(root, 'docs', 'epics', 'R-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'epics', 'R-1', 'implement.md'), 'report');
    fs.mkdirSync(path.join(root, '.aidlc', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aidlc', 'runs', 'R-1.json'), '{}');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'report only');
    expect(codeFingerprint(root, skip)).toBe(base);

    fs.writeFileSync(path.join(root, 'new.txt'), 'x');
    const untracked = codeFingerprint(root, skip);
    expect(untracked).not.toBe(base);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'code');
    // Committed or not, the same code is the same fingerprint.
    expect(codeFingerprint(root, skip)).toBe(untracked);
    // And the real index is left alone.
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('has nothing to say outside git', () => {
    expect(codeFingerprint(fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-nogit-')), [])).toBeNull();
  });
});

describe('autopilot — implement → review → implement …', () => {
  /** `mode`: grow = every implement changes the code; once = only the first does. */
  function workspace(mode: 'grow' | 'once'): string {
    const root = gitRoot();
    const aidlc = path.join(root, '.aidlc');
    fs.mkdirSync(path.join(aidlc, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(aidlc, 'skills', 'work.md'), 'Do the work.\n');
    fs.writeFileSync(path.join(aidlc, 'dev.cjs'), `
const fs = require('fs'); const path = require('path');
module.exports = { async run(o) {
  fs.appendFileSync(path.join(o.workspaceRoot, '.aidlc', 'calls.log'), 'dev\\n');
  const src = path.join(o.workspaceRoot, 'src.txt');
  if (${JSON.stringify(mode)} === 'grow') { fs.appendFileSync(src, 'more\\n'); } else { fs.writeFileSync(src, 'fixed\\n'); }
  return { success: true, output: 'ok' };
} };
`);
    fs.writeFileSync(path.join(aidlc, 'noop.cjs'), 'module.exports = { async run() { return { success: true, output: "ok" }; } };\n');
    fs.writeFileSync(path.join(aidlc, 'hold.mjs'), 'export default () => ({ decision: "reject", reason: "still wrong" });\n');
    fs.writeFileSync(path.join(aidlc, 'workspace.yaml'), `
version: "1.0"
name: loop
agents:
  - { id: dev, name: Dev, skills: [work], runner: custom, runner_path: .aidlc/dev.cjs }
  - { id: rev, name: Rev, skills: [work], runner: custom, runner_path: .aidlc/noop.cjs }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - id: p
    steps:
      - { name: implement, agent: dev }
      - name: review
        agent: rev
        auto_review: true
        auto_review_runner: .aidlc/hold.mjs
        on_reject: { send_back_to: implement }
`);
    RunStateStore.save(root, startRun({
      runId: 'R-1', pipeline: WorkspaceLoader.load(root).config.pipelines[0], context: {},
    }));
    return root;
  }

  const devCalls = (root: string): number =>
    fs.readFileSync(path.join(root, '.aidlc', 'calls.log'), 'utf8').trim().split('\n').length;

  it('goes round max_send_backs times, then stops for a human', async () => {
    const root = workspace('grow');
    const sent: number[] = [];
    const outcome = await runExecLoop(root, 'R-1', {}, {
      onAutoReviewResult: (e) => { if (e.sentBackTo) { sent.push(e.sentBackTo.count); } },
    });
    expect(outcome).toEqual({ kind: 'rejected' });
    expect(sent).toEqual([1, 2, 3]);
    expect(devCalls(root)).toBe(4);
    const s = RunStateStore.load(root, 'R-1')!;
    expect(s.steps[0].revision).toBe(4);
    expect(s.steps[1].rejectReason).toContain('Sent back 3 times already (max_send_backs: 3)');
    expect(s.steps[1].history!.filter((h) => h.kind === 'reject' && h.source === 'config')).toHaveLength(3);
    expect(fs.existsSync(runLockFile(root, 'R-1'))).toBe(false);
  });

  it('hands a step on_reject does not name to a person, and stops there', async () => {
    const root = workspace('grow');
    const aidlc = path.join(root, '.aidlc');
    fs.writeFileSync(path.join(aidlc, 'hold.mjs'),
      'export default () => ({ decision: "reject", reason: "spec is wrong", sendBackTo: "implement" });\n');
    const yaml = path.join(aidlc, 'workspace.yaml');
    fs.writeFileSync(yaml, fs.readFileSync(yaml, 'utf8').replace(/\n\s+on_reject: .*\n/, '\n'));
    const stoppedAt: string[] = [];
    const outcome = await runExecLoop(root, 'R-1', {}, { onAttendedStep: (e) => { stoppedAt.push(e.label); } });
    expect(outcome).toEqual({ kind: 'attended' });
    expect(stoppedAt).toEqual(['implement']);
    expect(devCalls(root)).toBe(1);
    const s = RunStateStore.load(root, 'R-1')!;
    expect(s.currentStepIdx).toBe(0);
    expect(s.steps[0]).toMatchObject({ status: 'awaiting_work', revision: 2, feedback: 'Rejected at step 2 (review): spec is wrong' });
    expect(s.steps[1].history!.at(-1)).toMatchObject({ kind: 'reject', source: 'handoff' });
  });

  it('stops when the step it sent work back to changes no code', async () => {
    const root = workspace('once');
    let stalled = '';
    const outcome = await runExecLoop(root, 'R-1', {}, { onStalled: (e) => { stalled = e.reason; } });
    expect(outcome).toEqual({ kind: 'stalled' });
    expect(devCalls(root)).toBe(2);
    expect(stalled).toBe(
      'Revision 2 of "dev" changed no code — the working tree is what it was before it ran (its report aside). ' +
      'Sent back 1 time; stopping rather than have the same code reviewed again.',
    );
    const s = RunStateStore.load(root, 'R-1')!;
    expect(s.currentStepIdx).toBe(0);
    expect(s.steps[0]).toMatchObject({ status: 'awaiting_work', revision: 2 });
  });

  it('refuses a second loop on the same run, and takes over a dead one\'s lock', async () => {
    const root = workspace('grow');
    const held = acquireRunLock(root, 'R-1');
    expect('release' in held).toBe(true);
    let failed = '';
    expect(await runExecLoop(root, 'R-1', {}, { onRunFailed: (r) => { failed = r; } })).toEqual({ kind: 'error' });
    expect(failed).toBe(`Run "R-1" is already being executed (pid ${process.pid}). Stop that one first, or wait for it to finish.`);
    expect(fs.existsSync(path.join(root, '.aidlc', 'calls.log'))).toBe(false);
    if ('release' in held) { held.release(); }

    // A pid that cannot be running: left behind by a crash.
    fs.writeFileSync(runLockFile(root, 'R-1'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    expect(await runExecLoop(root, 'R-1', {}, {})).toEqual({ kind: 'rejected' });
    expect(fs.existsSync(runLockFile(root, 'R-1'))).toBe(false);
  });
});
