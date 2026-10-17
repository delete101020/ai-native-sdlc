/**
 * The verdict validator (templates/ainative/validators/verdict.mjs).
 *
 * verify.md and review.md each end in a verdict, and until now nothing read
 * it: `native-lite` ran review with no human gate, so a `hold` went straight
 * to `completed`. The validator reads the `Verdict:` line and fails closed —
 * anything it cannot read is a reject. See AUTOPILOT_READINESS.md §G1.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  startRun,
  runExecLoop,
  RunStateStore,
  WorkspaceLoader,
  getBuiltinWorkflow,
  writeBuiltinAutoReviewValidators,
} from '../src/index';

const CORE_ROOT = path.join(__dirname, '..');
const VALIDATOR = path.join(CORE_ROOT, 'templates', 'ainative', 'validators', 'verdict.mjs');

type Verdict = { decision: 'pass' | 'reject'; reason: string };
let readVerdict: (text: string, file?: string) => Verdict;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let validate: (ctx: any) => Promise<Verdict>;

beforeAll(async () => {
  const mod = await import(pathToFileURL(VALIDATOR).href);
  readVerdict = mod.readVerdict;
  validate = mod.default;
});

describe('readVerdict', () => {
  it('lets ship and pass through', () => {
    expect(readVerdict('# Review\n\nVerdict: ship\n', 'review.md'))
      .toEqual({ decision: 'pass', reason: 'Verdict: ship' });
    expect(readVerdict('Verdict: pass', 'verify.md').decision).toBe('pass');
  });

  it('reads the line through markdown and a trailing comment', () => {
    for (const line of [
      '**Verdict:** ship',
      '**Verdict: ship**',
      '## Verdict: ship',
      '> Verdict: `ship`',
      'Verdict: ship — no blockers',
      'verdict: SHIP.',
    ]) {
      expect(readVerdict(line, 'review.md').decision, line).toBe('pass');
    }
  });

  it('rejects a hold and hands on the shortest path to ship', () => {
    const v = readVerdict([
      'Verdict: hold',
      '',
      '## 7. Shortest path to ship',
      '',
      '> *Only when the verdict is hold: the minimum set of changes that would flip it.*',
      '',
      '1. Escape the user name in `greet.ts:12`.',
      '2. Add the missing test for an empty list.',
      '',
      '## 8. Policy amendments',
      '',
      'none',
    ].join('\n'), 'review.md');
    expect(v).toEqual({
      decision: 'reject',
      reason: 'Verdict: hold. Changes needed:\n'
        + '1. Escape the user name in `greet.ts:12`.\n'
        + '2. Add the missing test for an empty list.',
    });
  });

  it('falls back to the lines under the verdict when there is no such section', () => {
    expect(readVerdict('Verdict: fail\n- AC02 untested\n\n## Findings\nx', 'verify.md')).toEqual({
      decision: 'reject',
      reason: 'Verdict: fail. Changes needed:\n- AC02 untested',
    });
  });

  it('still rejects a hold that lists no changes', () => {
    expect(readVerdict('Verdict: hold\n', 'review.md')).toEqual({
      decision: 'reject',
      reason: 'Verdict: hold. review.md lists no changes; read its findings.',
    });
  });

  it('fails closed when there is no verdict line', () => {
    expect(readVerdict('**Overall:** ship', 'review.md')).toEqual({
      decision: 'reject',
      reason: 'review.md has no verdict line. Add one: `Verdict: ship` or `Verdict: hold`.',
    });
    expect(readVerdict('', 'verify.md').reason).toContain('`Verdict: pass` or `Verdict: fail`');
  });

  it('fails closed on a word it does not know', () => {
    const v = readVerdict('Verdict: probably fine', 'review.md');
    expect(v.decision).toBe('reject');
    expect(v.reason).toBe(
      'review.md line 1: unreadable verdict "Verdict: probably fine". Expected `Verdict: ship` or `Verdict: hold`.',
    );
  });

  it('fails closed on the template placeholder left unfilled', () => {
    const tpl = fs.readFileSync(path.join(CORE_ROOT, 'templates', 'ainative', 'artifacts', 'review.md'), 'utf8');
    expect(tpl).toContain('Verdict: ship / hold');
    expect(readVerdict(tpl, 'review.md').decision).toBe('reject');
  });

  it('fails closed when two verdicts disagree, and accepts one repeated', () => {
    expect(readVerdict('Verdict: ship\n\nVerdict: hold', 'review.md')).toEqual({
      decision: 'reject',
      reason: 'review.md gives conflicting verdicts (ship, hold). Keep one.',
    });
    expect(readVerdict('Verdict: ship\n\n**Verdict:** ship', 'review.md').decision).toBe('pass');
  });

  it('ignores the Verdict column of the criteria table', () => {
    const report = '| Id | Criterion | Verdict | Evidence |\n|---|---|---|---|\n| AC01 | x | fail | y |\n\nVerdict: pass';
    // A report whose own rows fail but whose line says pass is the verifier's
    // contradiction to own — the validator reads the line, not the table.
    expect(readVerdict(report, 'verify.md').decision).toBe('pass');
  });
});

describe('verdict validator — as AutoReviewer calls it', () => {
  it('reads the step\'s .md artifact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-verdict-'));
    const file = path.join(dir, 'review.md');
    fs.writeFileSync(file, 'Verdict: hold\n- fix it\n');
    expect(await validate({ paths: { produces: [file], requires: [] } })).toEqual({
      decision: 'reject', reason: 'Verdict: hold. Changes needed:\n- fix it',
    });
  });

  it('rejects when there is nothing to read', async () => {
    expect((await validate({ paths: { produces: [], requires: [] } })).decision).toBe('reject');
    const missing = path.join(os.tmpdir(), 'aidlc-verdict-missing', 'review.md');
    const v = await validate({ paths: { produces: [missing], requires: [] } });
    expect(v.decision).toBe('reject');
    expect(v.reason).toMatch(/^Cannot read review\.md: /);
  });
});

describe('native-lite — review is read before the run completes', () => {
  const workflow = getBuiltinWorkflow('ai-native-pipeline')!;

  it('gates review on the verdict validator', () => {
    const lite = (workflow.recipes ?? []).find((r) => r.id === 'native-lite')!;
    expect(lite.gates!.review).toEqual({
      human_review: false,
      auto_review: true,
      auto_review_runner: '.aidlc/validators/verdict.mjs',
    });
  });

  it('scaffolds the validator a recipe gate names', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-verdict-scaffold-'));
    writeBuiltinAutoReviewValidators(CORE_ROOT, root, workflow);
    expect(fs.readFileSync(path.join(root, '.aidlc', 'validators', 'verdict.mjs'), 'utf8'))
      .toBe(fs.readFileSync(VALIDATOR, 'utf8'));
  });

  function tmpRoot(verdict: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-verdict-run-'));
    fs.mkdirSync(path.join(root, '.aidlc', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(root, '.aidlc', 'validators'), { recursive: true });
    fs.copyFileSync(VALIDATOR, path.join(root, '.aidlc', 'validators', 'verdict.mjs'));
    fs.writeFileSync(path.join(root, '.aidlc', 'skills', 'work.md'), 'Do the work.\n');
    fs.writeFileSync(path.join(root, '.aidlc', 'reviewer.cjs'), `
const fs = require('fs'); const path = require('path');
module.exports = { async run(o) {
  fs.writeFileSync(path.join(o.workspaceRoot, 'review.md'), ${JSON.stringify(verdict)});
  return { success: true, output: 'ok' };
} };
`);
    fs.writeFileSync(path.join(root, '.aidlc', 'workspace.yaml'), `
version: "1.0"
name: lite
agents:
  - { id: reviewer, name: Reviewer, skills: [work], runner: custom, runner_path: .aidlc/reviewer.cjs }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - id: p
    steps:
      - agent: reviewer
        produces: [review.md]
        human_review: false
        auto_review: true
        auto_review_runner: .aidlc/validators/verdict.mjs
`);
    RunStateStore.save(root, startRun({
      runId: 'R-1', pipeline: WorkspaceLoader.load(root).config.pipelines[0], context: {},
    }));
    return root;
  }

  it('stops the run on a hold instead of reporting completed', async () => {
    const root = tmpRoot('Verdict: hold\n- add the missing test\n');
    expect(await runExecLoop(root, 'R-1', {}, {})).toEqual({ kind: 'rejected' });
    const step = RunStateStore.load(root, 'R-1')!.steps[0];
    expect(step.status).toBe('rejected');
    expect(step.rejectReason).toBe('Verdict: hold. Changes needed:\n- add the missing test');
  });

  it('completes on a ship', async () => {
    const root = tmpRoot('Verdict: ship\n');
    expect(await runExecLoop(root, 'R-1', {}, {})).toEqual({ kind: 'completed' });
  });
});
