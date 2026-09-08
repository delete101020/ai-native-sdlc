/**
 * Cancelling the autopilot loop.
 *
 * The extension's "Run to completion" hands the loop a cancellation token, so
 * the contract it depends on is tested here: a cancel is honoured at the next
 * step boundary and never mid-step, and the run is left in a state the user
 * can pick up by hand — the step that ran is properly transitioned, the one
 * after it untouched.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { startRun, runExecLoop, RunStateStore, WorkspaceLoader } from '../src/index';

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-cancel-'));
  fs.mkdirSync(path.join(root, '.aidlc', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aidlc', 'skills', 'work.md'), 'Do the work.\n');
  fs.writeFileSync(path.join(root, '.aidlc', 'ok.cjs'),
    'module.exports = { async run() { return { success: true, output: "ok" }; } };\n');
  fs.writeFileSync(path.join(root, '.aidlc', 'workspace.yaml'), `
version: "1.0"
name: cancel
agents:
  - { id: a, name: A, skills: [work], runner: custom, runner_path: .aidlc/ok.cjs }
  - { id: b, name: B, skills: [work], runner: custom, runner_path: .aidlc/ok.cjs }
  - { id: c, name: C, skills: [work], runner: custom, runner_path: .aidlc/ok.cjs }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - { id: p1, name: P1, steps: [a, b, c] }
`);
  return root;
}

function seedRun(root: string, runId: string): void {
  const ws = WorkspaceLoader.load(root);
  RunStateStore.save(root, startRun({ runId, pipeline: ws.config.pipelines[0], context: {} }));
}

describe('cancelling an exec loop', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('stops at the next boundary, leaving the finished step transitioned', async () => {
    seedRun(root, 'R-1');
    let cancel = false;
    const ran: number[] = [];

    const outcome = await runExecLoop(
      root, 'R-1',
      { shouldCancel: () => cancel },
      {
        onStepStart: (e) => { ran.push(e.stepIdx); },
        // Cancel the moment the first step lands, mid-run.
        onStepResult: () => { cancel = true; },
      },
    );

    expect(outcome).toEqual({ kind: 'cancelled' });
    // The step in flight was never abandoned — it ran to its own end.
    expect(ran).toEqual([0]);

    const final = RunStateStore.load(root, 'R-1')!;
    expect(final.steps[0].status).toBe('approved');
    expect(final.steps[1].status).toBe('awaiting_work');
    expect(final.status).not.toBe('completed');
  });

  it('spawns nothing when the cancel is already set', async () => {
    seedRun(root, 'R-2');
    const ran: number[] = [];

    const outcome = await runExecLoop(
      root, 'R-2',
      { shouldCancel: () => true },
      { onStepStart: (e) => { ran.push(e.stepIdx); } },
    );

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(ran).toEqual([]);
    expect(RunStateStore.load(root, 'R-2')!.steps[0].status).toBe('awaiting_work');
  });

  it('runs to completion when shouldCancel is never given', async () => {
    seedRun(root, 'R-3');
    const outcome = await runExecLoop(root, 'R-3', {});
    expect(outcome).toEqual({ kind: 'completed' });
    expect(RunStateStore.load(root, 'R-3')!.status).toBe('completed');
  });
});
