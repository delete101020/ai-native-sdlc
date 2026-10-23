/**
 * The autopilot loop and a cursor parked on a side branch the run left behind.
 *
 * CR-261023-02 (cr-squad): `cr-merge` waits only on `cr-solo-dev`, so the BA
 * and QC lenses are dead ends. They were opened with the dev lens and never
 * run; the cursor stayed on `cr-solo-ba` while dev, merge and build-spec were
 * approved. An autopilot started to run `cr-build` up to `cr-review` ran
 * `cr-solo-ba` instead.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  nextRunnableStep, startRun, runExecLoop, RunStateStore, WorkspaceLoader,
  type PipelineConfig, type RunState, type StepStatus,
} from '../src/index';

const STEPS = `
      - { agent: a, name: intake }
      - { agent: a, name: solo-ba, depends_on: [intake] }
      - { agent: a, name: solo-dev, depends_on: [intake] }
      - { agent: a, name: solo-qc, depends_on: [intake] }
      - { agent: a, name: merge, depends_on: [solo-dev] }
      - { agent: a, name: build-spec, depends_on: [merge] }
      - { agent: a, name: build, depends_on: [build-spec] }
      - { agent: a, name: review, depends_on: [build] }
      - { agent: a, name: close, depends_on: [review] }
`;

// Where CR-261023-02 stood when the autopilot was started.
const STUCK: StepStatus[] = [
  'approved', 'awaiting_work', 'approved', 'awaiting_work',
  'approved', 'approved', 'awaiting_work', 'pending', 'pending',
];
const BUILD = 6;
const REVIEW = 7;

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-dead-end-'));
  fs.mkdirSync(path.join(root, '.aidlc', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aidlc', 'skills', 'work.md'), 'Do the work.\n');
  fs.writeFileSync(path.join(root, '.aidlc', 'ok.cjs'),
    'module.exports = { async run() { return { success: true, output: "ok" }; } };\n');
  fs.writeFileSync(path.join(root, '.aidlc', 'workspace.yaml'), `
version: "1.0"
name: dead-end
agents:
  - { id: a, name: A, skills: [work], runner: custom, runner_path: .aidlc/ok.cjs }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - id: squad
    steps:${STEPS}`);
  return root;
}

function seedStuck(root: string, runId: string): RunState {
  const ws = WorkspaceLoader.load(root);
  const state = startRun({ runId, pipeline: ws.config.pipelines[0], context: {} });
  STUCK.forEach((status, i) => { state.steps[i].status = status; });
  state.currentStepIdx = 1;
  RunStateStore.save(root, state);
  return state;
}

function pipelineOf(root: string): PipelineConfig {
  return WorkspaceLoader.load(root).config.pipelines[0];
}

describe('nextRunnableStep', () => {
  it('skips an open dead-end lens whose peer is approved', () => {
    const root = tmpRoot();
    const state = seedStuck(root, 'R-1');
    expect(nextRunnableStep(state, pipelineOf(root))).toBe(BUILD);
    expect(nextRunnableStep(state, pipelineOf(root), REVIEW)).toBe(BUILD);
  });

  it('keeps a dead-end lens the --until target names', () => {
    const root = tmpRoot();
    const state = seedStuck(root, 'R-2');
    expect(nextRunnableStep(state, pipelineOf(root), 3)).toBe(3);
  });

  it('keeps the cursor while no peer of the lens is approved', () => {
    const root = tmpRoot();
    const state = seedStuck(root, 'R-3');
    state.steps[2].status = 'awaiting_work';
    state.steps[4].status = 'pending';
    state.steps[5].status = 'pending';
    state.steps[6].status = 'pending';
    expect(nextRunnableStep(state, pipelineOf(root))).toBe(1);
    // ...unless --until does not lead through it.
    expect(nextRunnableStep(state, pipelineOf(root), REVIEW)).toBe(2);
  });
});

describe('autopilot — cursor on a dead-end side branch', () => {
  it('runs build and review, not the abandoned lens', async () => {
    const root = tmpRoot();
    seedStuck(root, 'R-4');
    const ran: number[] = [];
    const bypassed: number[] = [];

    const outcome = await runExecLoop(root, 'R-4', { untilIdx: REVIEW }, {
      onStepStart: (e) => { ran.push(e.stepIdx); },
      onStepBypassed: (e) => { bypassed.push(e.stepIdx); },
    });

    expect(bypassed).toEqual([1]);
    expect(ran).toEqual([BUILD, REVIEW]);
    expect(outcome).toEqual({ kind: 'until' });
    const final = RunStateStore.load(root, 'R-4')!;
    expect(final.steps[1].status).toBe('awaiting_work');
    expect(final.steps[REVIEW].status).toBe('approved');
  });

  it('runs the pipeline out without touching the dead-end lenses', async () => {
    const root = tmpRoot();
    seedStuck(root, 'R-5');
    const ran: number[] = [];

    const outcome = await runExecLoop(root, 'R-5', {}, {
      onStepStart: (e) => { ran.push(e.stepIdx); },
    });

    expect(ran).toEqual([BUILD, REVIEW, 8]);
    expect(outcome).toEqual({ kind: 'completed' });
  });

  it('previews the step it would run without moving the cursor', async () => {
    const root = tmpRoot();
    seedStuck(root, 'R-6');
    const moved: number[] = [];

    const outcome = await runExecLoop(root, 'R-6', { dryRun: true, untilIdx: REVIEW }, {
      onStepBypassed: (e) => { moved.push(e.nextStepIdx); },
    });

    expect(outcome).toEqual({ kind: 'dry_run' });
    expect(moved).toEqual([BUILD]);
    expect(RunStateStore.load(root, 'R-6')!.currentStepIdx).toBe(1);
  });
});
