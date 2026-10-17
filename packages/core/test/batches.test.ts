/**
 * A `batches: true` step runs as a series of fresh sessions, each ending its
 * report on `Status: continue` or `Status: done`. See AUTOPILOT_READINESS.md
 * §G7 (D7a–e).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  runExecLoop,
  assemblePipeline,
  normalizeStep,
  validateWorkspace,
  RunStateStore,
  WorkspaceLoader,
  DEFAULT_MAX_BATCHES,
} from '../src/index';
import type { WorkspaceConfig } from '../src/index';
import { readBatchStatus } from '../src/runs/batchStatus';

describe('readBatchStatus', () => {
  it('reads the last Status line, in the forms a report writes it', () => {
    expect(readBatchStatus('# R\n\nStatus: continue\n')).toEqual({ status: 'continue' });
    expect(readBatchStatus('**Status:** Draft\n\n**Status:** done\n')).toEqual({ status: 'done' });
    expect(readBatchStatus('## Status: **continue** — batch 3 next\n')).toEqual({ status: 'continue' });
    expect(readBatchStatus('> status: DONE.\n')).toEqual({ status: 'done' });
  });

  it('fails closed on a missing line, a placeholder, or the template header', () => {
    expect(readBatchStatus('# Report\n', 'implement.md')).toEqual({
      error: 'implement.md has no `Status: continue` or `Status: done` line.',
    });
    expect(readBatchStatus('Status: continue | done\n', 'implement.md')).toEqual({
      error: 'The last Status line in implement.md reads "continue | done", not `Status: continue` or `Status: done`.',
    });
    expect(readBatchStatus('Status: done\n**Status:** Draft\n')).toHaveProperty('error');
    expect(readBatchStatus('Status: continuing\n')).toHaveProperty('error');
  });
});

describe('batches in the schema', () => {
  it('normalizes the keys, with the default ceiling', () => {
    expect(normalizeStep({ agent: 'dev', batches: true }).batches).toEqual({ max: DEFAULT_MAX_BATCHES, pause: false });
    expect(normalizeStep({ agent: 'dev', batches: true, max_batches: 4, pause_between_batches: true }).batches)
      .toEqual({ max: 4, pause: true });
    expect(normalizeStep({ agent: 'dev', max_batches: 4 }).batches).toBeUndefined();
  });

  it('a recipe gate turns batches on for the step it names', () => {
    const config = validateWorkspace({
      version: '1.0',
      name: 'b',
      agents: [{ id: 'dev', name: 'Dev', skills: ['work'] }],
      skills: [{ id: 'work', path: 'w.md' }],
      pipelines: [{ id: 'base', steps: [{ name: 'plan', agent: 'dev' }, { name: 'implement', agent: 'dev' }] }],
      recipes: [{
        id: 'r', from: 'base', steps: ['plan', 'implement'],
        gates: { implement: { batches: true, max_batches: 6, timeout_minutes: 30 } },
      }],
    }) as WorkspaceConfig;
    const p = assemblePipeline(config, { recipeId: 'r' });
    expect(normalizeStep(p.steps[0]).batches).toBeUndefined();
    expect(normalizeStep(p.steps[1])).toMatchObject({ batches: { max: 6, pause: false }, timeout_minutes: 30 });
  });
});

// ── The loop, against a real git checkout ───────────────────────────────────

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

const REPORT = 'docs/epics/R-1/implement.md';

/**
 * A run whose `implement` is played by a script: session N writes the report
 * ending in `statuses[N-1]` (`null` = no Status line) and, unless `idle`,
 * changes the code. Each session's user message is kept for the asserts.
 */
function workspace(statuses: Array<string | null>, opts: { idle?: boolean; gate?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-batches-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'src.txt'), 'initial\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');

  const aidlc = path.join(root, '.aidlc');
  fs.mkdirSync(path.join(aidlc, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(aidlc, 'skills', 'work.md'), 'Do the work.\n');
  fs.writeFileSync(path.join(aidlc, 'dev.cjs'), `
const fs = require('fs'); const path = require('path');
const statuses = ${JSON.stringify(statuses)};
module.exports = { async run(o) {
  const log = path.join(o.workspaceRoot, '.aidlc', 'messages.json');
  const seen = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
  seen.push(o.args[0] || '');
  fs.writeFileSync(log, JSON.stringify(seen));
  const n = seen.length;
  const status = statuses[Math.min(n, statuses.length) - 1];
  const report = path.join(o.workspaceRoot, ${JSON.stringify(REPORT)});
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, '# Implement\\n\\n**Status:** Draft\\n\\n| Batch |\\n|---|\\n| ' + n + ' |\\n'
    + (status === null ? '' : '\\nStatus: ' + status + '\\n'));
  if (!${JSON.stringify(!!opts.idle)}) { fs.appendFileSync(path.join(o.workspaceRoot, 'src.txt'), 'batch ' + n + '\\n'); }
  return { success: true, output: 'ok', costUsd: 0.1 };
} };
`);
  fs.writeFileSync(path.join(aidlc, 'workspace.yaml'), `
version: "1.0"
name: batches
agents:
  - { id: dev, name: Dev, skills: [work], runner: custom, runner_path: .aidlc/dev.cjs }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - id: p
    steps:
      - name: implement
        agent: dev
        produces: [${REPORT}]
        batches: true
        ${opts.gate ?? ''}
`);
  RunStateStore.save(root, startRun({
    runId: 'R-1', pipeline: WorkspaceLoader.load(root).config.pipelines[0], context: {},
  }));
  return root;
}

const messages = (root: string): string[] =>
  JSON.parse(fs.readFileSync(path.join(root, '.aidlc', 'messages.json'), 'utf8'));

describe('a batched step in the exec loop', () => {
  it('starts a fresh session on continue, and finishes the step on done', async () => {
    const root = workspace(['continue', 'continue', 'done']);
    const batches: number[] = [];
    const outcome = await runExecLoop(root, 'R-1', {}, { onBatchDone: (e) => { batches.push(e.batch); } });
    expect(outcome).toEqual({ kind: 'completed' });
    expect(batches).toEqual([1, 2]);

    const m = messages(root);
    expect(m).toHaveLength(3);
    expect(m[0]).toContain('this is batch 1 of revision 1, in a fresh session. Start with the first batch in the plan.');
    expect(m[1]).toContain(`this is batch 2 of revision 1, in a fresh session. ${REPORT} records what earlier batches did.`);
    expect(m[2]).toContain('this is batch 3 of revision 1');
    expect(m[2]).toContain('`Status: continue` if any of the step\'s work is left, or `Status: done`');

    const step = RunStateStore.load(root, 'R-1')!.steps[0];
    expect(step.status).toBe('approved');
    expect(step.costUsd).toBeCloseTo(0.3);
    expect(step.history!.filter((h) => h.kind === 'batch'))
      .toMatchObject([{ batch: 1, revision: 1, costUsd: 0.1 }, { batch: 2, revision: 1, costUsd: 0.1 }]);
  });

  it('fails closed when the report does not say', async () => {
    const root = workspace([null]);
    let failed = '';
    expect(await runExecLoop(root, 'R-1', {}, { onStepFailed: (e) => { failed = e.message ?? ''; } }))
      .toEqual({ kind: 'error' });
    // The template's `**Status:** Draft` header is the last Status line left.
    expect(failed).toBe(
      'Step "dev" runs in batches and its report cannot say whether it is done: The last Status line in ' +
      `${REPORT} reads "draft", not \`Status: continue\` or \`Status: done\`. Add the line, then run exec again.`,
    );
    expect(RunStateStore.load(root, 'R-1')!.steps[0].status).toBe('awaiting_work');
  });

  it('stops at max_batches, and a second exec allows as many more', async () => {
    const root = workspace(['continue'], { gate: 'max_batches: 2' });
    let stalled = '';
    expect(await runExecLoop(root, 'R-1', {}, { onStalled: (e) => { stalled = e.reason; } }))
      .toEqual({ kind: 'stalled' });
    expect(messages(root)).toHaveLength(2);
    expect(stalled).toBe(
      '"dev" ran 2 batches (`max_batches: 2`) and still says `Status: continue`. Read its progress before ' +
      'letting it carry on: running exec again allows 2 more.',
    );

    expect(await runExecLoop(root, 'R-1', {}, {})).toEqual({ kind: 'stalled' });
    const m = messages(root);
    expect(m).toHaveLength(4);
    // The count of batches on the revision carries on; only the ceiling resets.
    expect(m[3]).toContain('this is batch 4 of revision 1');
  });

  it('stops when a batch asks for more without changing any code', async () => {
    const root = workspace(['continue'], { idle: true });
    let stalled = '';
    expect(await runExecLoop(root, 'R-1', {}, { onStalled: (e) => { stalled = e.reason; } }))
      .toEqual({ kind: 'stalled' });
    expect(messages(root)).toHaveLength(1);
    expect(stalled).toBe(
      'Batch 1 of "dev" asked for another session but changed no code — the working tree is what it was ' +
      'before it ran (its report aside). Stopping rather than start the same batch again.',
    );
    expect(RunStateStore.load(root, 'R-1')!.steps[0].history ?? []).toEqual([]);
  });

  it('pause_between_batches stops after each continue, for a person to look', async () => {
    const root = workspace(['continue', 'done'], { gate: 'pause_between_batches: true' });
    let paused: { batch: number; report: string } | null = null;
    expect(await runExecLoop(root, 'R-1', {}, { onBatchPause: (e) => { paused = e; } }))
      .toEqual({ kind: 'batch_pause' });
    expect(paused).toMatchObject({ batch: 1, report: REPORT });
    expect(messages(root)).toHaveLength(1);

    expect(await runExecLoop(root, 'R-1', {}, {})).toEqual({ kind: 'completed' });
    expect(messages(root)[1]).toContain('this is batch 2 of revision 1');
  });

  it('a later revision starts with a batch of fixes, keeping the progress so far', async () => {
    const root = workspace(['done']);
    const s = RunStateStore.load(root, 'R-1')!;
    s.steps[0].revision = 2;
    RunStateStore.save(root, s);
    let preview = '';
    expect(await runExecLoop(root, 'R-1', { dryRun: true }, { onDryRunPreview: (e) => { preview = e.userMessage; } }))
      .toEqual({ kind: 'dry_run' });
    expect(preview).toContain('this is batch 1 of revision 2, in a fresh session. Make this batch the fixes the ' +
      `feedback above asks for. Keep the progress table ${REPORT} already has`);
  });
});
