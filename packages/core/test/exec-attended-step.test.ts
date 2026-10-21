/**
 * A step marked `attended: true` is one only a person runs (a close-out that
 * asks questions). The loop stops before it as a clean stop — not by spawning
 * the agent and failing on the artifact it was never going to write.
 */

import { it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { startRun, runExecLoop, RunStateStore, WorkspaceLoader } from '../src/index';

it('stops cleanly before an attended step, leaving it for a person', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-attended-'));
  fs.mkdirSync(path.join(root, '.aidlc', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aidlc', 'skills', 'work.md'), 'Do the work.\n');
  fs.writeFileSync(path.join(root, '.aidlc', 'ok.cjs'),
    'module.exports = { async run() { return { success: true, output: "ok" }; } };\n');
  fs.writeFileSync(path.join(root, '.aidlc', 'workspace.yaml'), `
version: "1.0"
name: attended
agents:
  - { id: a, name: A, skills: [work], runner: custom, runner_path: .aidlc/ok.cjs }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - id: p
    steps:
      - { agent: a, name: build }
      - { agent: a, name: close, attended: true }
`);
  const ws = WorkspaceLoader.load(root);
  RunStateStore.save(root, startRun({ runId: 'R-1', pipeline: ws.config.pipelines[0], context: {} }));

  const ran: number[] = [];
  const stoppedAt: string[] = [];
  const outcome = await runExecLoop(root, 'R-1', {}, {
    onStepStart: (e) => { ran.push(e.stepIdx); },
    onAttendedStep: (e) => { stoppedAt.push(e.label); },
  });

  expect(outcome).toEqual({ kind: 'attended' });
  expect(ran).toEqual([0]);
  expect(stoppedAt).toEqual(['close · a']);
  const final = RunStateStore.load(root, 'R-1')!;
  expect(final.steps[0].status).toBe('approved');
  expect(final.steps[1].status).toBe('awaiting_work');
});
