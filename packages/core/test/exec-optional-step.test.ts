/**
 * The autopilot loop and a rejection it is allowed to carry past.
 *
 * Two declarations say "this rejection is not the end of the run": a step's
 * `optional: true`, and a pipeline's `on_failure: continue` — which was in the
 * schema, printed by the dashboard, and read by nothing. Both are tested here
 * end to end, because the loop stopping at every rejection is exactly how a
 * run came to sit on a rejected side branch while its work had moved on.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { startRun, runExecLoop, RunStateStore, WorkspaceLoader } from '../src/index';

function tmpRoot(pipelines: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-optional-'));
  fs.mkdirSync(path.join(root, '.aidlc', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aidlc', 'skills', 'work.md'), 'Do the work.\n');
  // A runner that "produces" nothing: every step below declares no artifacts,
  // so the gate is satisfied and the step's fate is decided by auto-review.
  fs.writeFileSync(path.join(root, '.aidlc', 'ok.cjs'),
    'module.exports = { async run() { return { success: true, output: "ok" }; } };\n');
  fs.writeFileSync(path.join(root, '.aidlc', 'nope.mjs'),
    'export default async function () { return { decision: "reject", reason: "no answers recorded" }; }\n');
  fs.writeFileSync(path.join(root, '.aidlc', 'workspace.yaml'), `
version: "1.0"
name: optional
agents:
  - { id: a, name: A, skills: [work], runner: custom, runner_path: .aidlc/ok.cjs }
  - { id: b, name: B, skills: [work], runner: custom, runner_path: .aidlc/ok.cjs }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
${pipelines}
`);
  return root;
}

function seedRun(root: string, runId: string): void {
  const ws = WorkspaceLoader.load(root);
  RunStateStore.save(root, startRun({ runId, pipeline: ws.config.pipelines[0], context: {} }));
}

const OPTIONAL_FIRST = `  - id: p1
    steps:
      - { agent: a, name: lens, optional: true, auto_review: true, auto_review_runner: .aidlc/nope.mjs }
      - { agent: b, name: build }
`;

const CONTINUE_ON_FAILURE = `  - id: p2
    on_failure: continue
    steps:
      - { agent: a, name: lens, auto_review: true, auto_review_runner: .aidlc/nope.mjs }
      - { agent: b, name: build }
`;

const STOP_ON_FAILURE = `  - id: p3
    on_failure: stop
    steps:
      - { agent: a, name: lens, auto_review: true, auto_review_runner: .aidlc/nope.mjs }
      - { agent: b, name: build }
`;

describe('autopilot — a rejection the pipeline can live with', () => {
  it('runs the rest of the pipeline when an optional step is rejected', async () => {
    const root = tmpRoot(OPTIONAL_FIRST);
    seedRun(root, 'R-1');
    const ran: number[] = [];

    const outcome = await runExecLoop(root, 'R-1', {}, {
      onStepStart: (e) => { ran.push(e.stepIdx); },
    });

    expect(ran).toEqual([0, 1]);
    expect(outcome).toEqual({ kind: 'completed' });
    const final = RunStateStore.load(root, 'R-1')!;
    expect(final.steps[0].status).toBe('rejected');
    expect(final.steps[0].rejectReason).toBe('no answers recorded');
    expect(final.steps[1].status).toBe('approved');
    // The rejection is recorded, not fatal: the run is done and the cursor is
    // on the work that followed, not parked on step 0.
    expect(final.status).toBe('completed');
    expect(final.currentStepIdx).toBe(1);
  });

  it('carries past a rejection under on_failure: continue', async () => {
    const root = tmpRoot(CONTINUE_ON_FAILURE);
    seedRun(root, 'R-2');
    // The rejection lands before the loop starts — a human reject, or a run
    // from a build that had no idea `on_failure` meant anything.
    const seeded = RunStateStore.load(root, 'R-2')!;
    seeded.steps[0].status = 'rejected';
    seeded.steps[0].rejectReason = 'thin';
    seeded.steps[1].status = 'awaiting_work';
    RunStateStore.save(root, seeded);

    const skipped: number[] = [];
    const outcome = await runExecLoop(root, 'R-2', {}, {
      onStepSkipped: (e) => { skipped.push(e.stepIdx); },
    });

    expect(skipped).toEqual([0]);
    expect(outcome).toEqual({ kind: 'completed' });
    expect(RunStateStore.load(root, 'R-2')!.steps[1].status).toBe('approved');
  });

  it('still stops at a rejection under the default on_failure: stop', async () => {
    const root = tmpRoot(STOP_ON_FAILURE);
    seedRun(root, 'R-3');
    const rejected: string[] = [];

    const outcome = await runExecLoop(root, 'R-3', {}, {
      onRejected: (e) => { rejected.push(e.agent); },
    });

    expect(outcome).toEqual({ kind: 'rejected' });
    expect(rejected).toEqual(['a']);
    const final = RunStateStore.load(root, 'R-3')!;
    expect(final.steps[0].status).toBe('rejected');
    expect(final.steps[1].status).toBe('pending');
  });
});
