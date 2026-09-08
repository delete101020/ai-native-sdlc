/**
 * End-to-end cost accounting through the autopilot loop (§P3's "Done when":
 * a mixed-provider run reports a non-zero, roughly correct total).
 *
 * The providers themselves are fakes — `runner: custom` pointing at a `.cjs`
 * module — because the point under test is AIDLC's arithmetic and honesty, not
 * a vendor CLI's flags. One fake reports dollars the way Claude Code does, the
 * other reports only tokens the way `codex exec` does, and a third reports
 * neither. The run must end up with all three kinds distinguishable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  runExecLoop,
  RunStateStore,
  renderRunReport,
  WorkspaceLoader,
} from '../src/index';

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-p3-'));
  fs.mkdirSync(path.join(root, '.aidlc', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aidlc', 'skills', 'work.md'), 'Do the work.\n');
  return root;
}

/** A custom runner module that resolves with whatever result we bake in. */
function fakeRunner(root: string, name: string, result: Record<string, unknown>): string {
  const rel = path.join('.aidlc', `${name}.cjs`);
  fs.writeFileSync(path.join(root, rel),
    `module.exports = { async run() { return ${JSON.stringify(result)}; } };\n`);
  return rel;
}

function writeWorkspace(root: string, yaml: string): void {
  fs.writeFileSync(path.join(root, '.aidlc', 'workspace.yaml'), yaml);
}

describe('cost accounting across a mixed-provider run', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('measures, estimates, and reports blind steps distinctly', async () => {
    const paid = fakeRunner(root, 'paid', { success: true, output: 'ok', costUsd: 0.25 });
    const tokens = fakeRunner(root, 'tokens', {
      success: true, output: 'ok',
      usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
    });
    const silent = fakeRunner(root, 'silent', { success: true, output: 'ok' });

    writeWorkspace(root, `
version: "1.0"
name: p3
providers:
  custom:
    rates:
      "*": { input_per_mtok: 1.25, output_per_mtok: 10.0 }
agents:
  - { id: a, name: A, skills: [work], runner: custom, runner_path: ${paid} }
  - { id: b, name: B, skills: [work], runner: custom, runner_path: ${tokens} }
  - { id: c, name: C, skills: [work], runner: custom, runner_path: ${silent} }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - { id: p1, name: P1, steps: [a, b, c] }
`);

    const ws = WorkspaceLoader.load(root);
    const pipeline = ws.config.pipelines[0];
    const state = startRun({ runId: 'R-1', pipeline, context: {} });
    RunStateStore.save(root, state);

    await runExecLoop(root, 'R-1', {});

    const final = RunStateStore.load(root, 'R-1')!;

    // Step 0 — the CLI reported dollars. Taken as fact, not re-derived.
    expect(final.steps[0].costUsd).toBe(0.25);
    expect(final.steps[0].costEstimated).toBeUndefined();

    // Step 1 — tokens × the user's declared rate. 1M in @ $1.25 + 100k out @ $10.
    expect(final.steps[1].costUsd).toBeCloseTo(1.25 + 1.0, 6);
    expect(final.steps[1].costEstimated).toBe(true);
    expect(final.steps[1].usage).toEqual({ inputTokens: 1_000_000, outputTokens: 100_000 });

    // Step 2 — reported nothing. It must stay absent rather than become 0:
    // a 0 is indistinguishable from a free step once it is in the total.
    expect(final.steps[2].costUsd).toBeUndefined();

    const md = renderRunReport({ state: final, pipeline });
    expect(md).toContain('≥ ~$2.5000');
    expect(md).toContain('includes estimates from declared rates');
    expect(md).toContain('1 step reported no cost');
  });

  it('leaves cost blind when the provider declared no rates', async () => {
    const tokens = fakeRunner(root, 'tokens', {
      success: true, output: 'ok', usage: { inputTokens: 500_000 },
    });
    writeWorkspace(root, `
version: "1.0"
name: p3
agents:
  - { id: a, name: A, skills: [work], runner: custom, runner_path: ${tokens} }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - { id: p1, name: P1, steps: [a] }
`);
    const ws = WorkspaceLoader.load(root);
    const state = startRun({ runId: 'R-2', pipeline: ws.config.pipelines[0], context: {} });
    RunStateStore.save(root, state);

    await runExecLoop(root, 'R-2', {});

    const final = RunStateStore.load(root, 'R-2')!;
    // Usage is still recorded — it is a fact the CLI reported. What we refuse
    // to do is price it with a rate nobody gave us.
    expect(final.steps[0].usage).toEqual({ inputTokens: 500_000 });
    expect(final.steps[0].costUsd).toBeUndefined();
  });

  it('stops the run when the estimated total crosses the ceiling', async () => {
    const tokens = fakeRunner(root, 'tokens', {
      success: true, output: 'ok', usage: { inputTokens: 10_000_000 },
    });
    writeWorkspace(root, `
version: "1.0"
name: p3
providers:
  custom:
    rates:
      "*": { input_per_mtok: 1.0, output_per_mtok: 1.0 }
agents:
  - { id: a, name: A, skills: [work], runner: custom, runner_path: ${tokens} }
  - { id: b, name: B, skills: [work], runner: custom, runner_path: ${tokens} }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - id: p1
    name: P1
    steps: [a, b]
    budget: { max_usd: 5.0, on_exceed: pause }
`);
    const ws = WorkspaceLoader.load(root);
    const state = startRun({ runId: 'R-3', pipeline: ws.config.pipelines[0], context: {} });
    RunStateStore.save(root, state);

    const budgetEvents: Array<{ ok: boolean; spent: number; estimated?: number }> = [];
    const outcome = await runExecLoop(root, 'R-3', {}, {
      onBudget: (e) => budgetEvents.push({ ok: e.ok, spent: e.spent, estimated: e.estimated }),
    });

    // $10 estimated on the first step alone, against a $5 ceiling. An estimate
    // the user's own rates produced is worth acting on — the alternative is a
    // provider with no ceiling at all.
    expect(outcome.kind).toBe('budget_pause');
    const last = budgetEvents[budgetEvents.length - 1];
    expect(last.ok).toBe(false);
    expect(last.spent).toBeCloseTo(10, 6);
    expect(last.estimated).toBeCloseTo(10, 6);
  });
});
