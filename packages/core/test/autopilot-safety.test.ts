/**
 * What makes a run safe to leave alone, and how a step is stopped: runner
 * args from workspace.yaml (and the flags refused there), the autopilot
 * preflight (branch, clean tree, approval gate), `timeout_minutes`, and the
 * "stop now" signal. See AUTOPILOT_READINESS.md §G5 and §4 (R1).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  runExecLoop,
  assemblePipeline,
  validateWorkspace,
  unsafeRunnerArg,
  autopilotPreflight,
  findApprovalGate,
  stopOnAbort,
  processGroupSpawnOptions,
  RunStateStore,
  WorkspaceLoader,
} from '../src/index';
import type { WorkspaceConfig } from '../src/index';

// ── Runner args ─────────────────────────────────────────────────────────────

describe('providers.<runner>.args', () => {
  const ws = (args: string[]): unknown => ({
    version: '1.0', name: 't', providers: { default: { args } },
  });

  it('accepts flags that allow specific tools', () => {
    const cfg = validateWorkspace(ws(['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(npm test:*)']), 'w.yaml');
    expect(cfg.providers.default.args).toEqual(['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(npm test:*)']);
  });

  it.each([
    [['--dangerously-skip-permissions'], '--dangerously-skip-permissions'],
    [['--permission-mode', 'bypassPermissions'], '--permission-mode bypassPermissions'],
    [['--permission-mode=bypassPermissions'], '--permission-mode bypassPermissions'],
    [['--sandbox', 'danger-full-access'], '--sandbox danger-full-access'],
    [['--dangerously-bypass-approvals-and-sandbox'], '--dangerously-bypass-approvals-and-sandbox'],
    [['--yolo'], '--yolo'],
  ])('refuses %j', (args, named) => {
    expect(unsafeRunnerArg(args)).toBe(named);
    expect(() => validateWorkspace(ws(args), 'w.yaml')).toThrow(/switches the agent's permission checks off/);
  });
});

// ── Preflight ───────────────────────────────────────────────────────────────

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** A git checkout with an autopilot pipeline on `runner`, committed and clean, on `main`. */
function repo(runner: 'default' | 'custom' = 'default'): { root: string; config: WorkspaceConfig; userDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-autopilot-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  const aidlc = path.join(root, '.aidlc');
  fs.mkdirSync(path.join(aidlc, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(aidlc, 'skills', 'work.md'), 'Do the work.\n');
  fs.writeFileSync(path.join(aidlc, 'probe.cjs'), `
const fs = require('fs'); const path = require('path');
module.exports = { async run(o) {
  fs.writeFileSync(path.join(o.workspaceRoot, '.aidlc', 'ctx.json'),
    JSON.stringify({ autopilot: o.env.AIDLC_AUTOPILOT ?? null, extraArgs: o.extraArgs ?? null }));
  return { success: true, output: 'ok' };
} };
`);
  const agent = runner === 'custom'
    ? '{ id: dev, name: Dev, skills: [work], runner: custom, runner_path: .aidlc/probe.cjs }'
    : '{ id: dev, name: Dev, skills: [work] }';
  fs.writeFileSync(path.join(aidlc, 'workspace.yaml'), `
version: "1.0"
name: auto
providers:
  custom:
    args: [--allowedTools, Read]
agents:
  - ${agent}
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - id: p
    autopilot: true
    steps: [dev]
`);
  fs.writeFileSync(path.join(root, 'src.txt'), 'initial\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const config = WorkspaceLoader.load(root).config;
  RunStateStore.save(root, startRun({ runId: 'R-1', pipeline: config.pipelines[0], context: {} }));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-claude-home-'));
  return { root, config, userDir };
}

function installGate(root: string, file = 'settings.local.json', executable = true): void {
  const hooks = path.join(root, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const script = path.join(hooks, 'aidlc-approval-gate.py');
  fs.writeFileSync(script, '#!/usr/bin/env python3\n');
  fs.chmodSync(script, executable ? 0o755 : 0o644);
  fs.writeFileSync(path.join(root, '.claude', file), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit', hooks: [{ type: 'command', command: '.claude/hooks/aidlc-approval-gate.py' }] }] },
  }));
  // Committed, so the tree stays clean — only settings*.json is per clone in real life.
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'gate');
}

const preflight = (r: ReturnType<typeof repo>): string[] => autopilotPreflight({
  root: r.root, state: RunStateStore.load(r.root, 'R-1')!, pipeline: r.config.pipelines[0], config: r.config,
  userConfigDir: r.userDir,
});

describe('autopilot preflight', () => {
  it('passes on a clean feature branch with the gate registered', () => {
    const r = repo();
    installGate(r.root);
    git(r.root, 'switch', '-q', '-c', 'feat/x');
    expect(preflight(r)).toEqual([]);
  });

  it('refuses main, and a detached HEAD', () => {
    const r = repo();
    installGate(r.root);
    expect(preflight(r)).toEqual([
      'You are on "main". Autopilot does not commit to it — switch to a branch for this epic (git switch -c <branch>).',
    ]);
    git(r.root, 'checkout', '-q', '--detach');
    expect(preflight(r)[0]).toMatch(/^HEAD is detached/);
  });

  it('refuses uncommitted changes, but not the epic\'s own artifacts or .aidlc/', () => {
    const r = repo();
    installGate(r.root);
    git(r.root, 'switch', '-q', '-c', 'feat/x');
    fs.mkdirSync(path.join(r.root, 'docs', 'epics', 'R-1', 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(r.root, 'docs', 'epics', 'R-1', 'artifacts', 'plan.md'), '# plan\n');
    fs.writeFileSync(path.join(r.root, '.aidlc', 'runs', 'R-1.lock'), '{}');
    expect(preflight(r)).toEqual([]);

    fs.writeFileSync(path.join(r.root, 'src.txt'), 'edited by hand\n');
    fs.writeFileSync(path.join(r.root, 'notes.txt'), 'new\n');
    expect(preflight(r)).toEqual([
      'The working tree has uncommitted changes (src.txt, notes.txt). Commit or stash them first: the agent would ' +
      'build on them, and its own changes would be mixed in with them.',
    ]);
  });

  it('refuses a Claude step without the approval gate, and says where to look', () => {
    const r = repo();
    git(r.root, 'switch', '-q', '-c', 'feat/x');
    const problems = preflight(r);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^The approval gate is not on: no PreToolUse hook running .*ONBOARDING\.md/);
  });

  it('does not count a gate whose script is missing or not executable', () => {
    const r = repo();
    installGate(r.root, 'settings.json', false);
    expect(findApprovalGate(r.root, { userConfigDir: r.userDir })).toEqual({
      found: false,
      reason: '.claude/hooks/aidlc-approval-gate.py is registered in .claude/settings.json but is not executable (chmod +x it).',
    });
    fs.rmSync(path.join(r.root, '.claude', 'hooks'), { recursive: true });
    expect(findApprovalGate(r.root, { userConfigDir: r.userDir })).toMatchObject({ found: false, reason: expect.stringMatching(/does not exist/) });
  });

  it('accepts a gate run through an interpreter from the user settings', () => {
    const r = repo();
    const script = path.join(r.root, 'gate', 'aidlc-approval-gate.py');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '');
    fs.writeFileSync(path.join(r.userDir, 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `python3 "$CLAUDE_PROJECT_DIR"/gate/aidlc-approval-gate.py` }] }] },
    }));
    expect(findApprovalGate(r.root, { userConfigDir: r.userDir })).toMatchObject({ found: true, script });
  });

  it('a hook that never sees Bash is not the gate', () => {
    const r = repo();
    installGate(r.root);
    const file = path.join(r.root, '.claude', 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    settings.hooks.PreToolUse[0].matcher = 'Write|Edit';
    fs.writeFileSync(file, JSON.stringify(settings));
    expect(findApprovalGate(r.root, { userConfigDir: r.userDir }).found).toBe(false);
  });

  it('refuses a CI validator with nothing in CHECKS, counting commented-out examples as nothing', () => {
    const r = repo('custom');
    git(r.root, 'switch', '-q', '-c', 'feat/x');
    const ci = path.join(r.root, '.aidlc', 'validators', 'ci.mjs');
    fs.mkdirSync(path.dirname(ci), { recursive: true });
    fs.writeFileSync(ci, "const CHECKS = [\n  // { name: 'test', cmd: 'npm test' },\n];\nexport default async () => ({});\n");
    const pipeline = {
      ...r.config.pipelines[0],
      steps: [{ agent: 'dev', auto_review: true, auto_review_runner: '.aidlc/validators/ci.mjs' }],
    };
    const check = (): string[] => autopilotPreflight({
      root: r.root, state: RunStateStore.load(r.root, 'R-1')!, pipeline, config: r.config, userConfigDir: r.userDir,
    });
    expect(check()).toEqual([
      '.aidlc/validators/ci.mjs has no commands in CHECKS, so it passes whatever "dev" builds. Add your lint, ' +
      'typecheck and test commands to it before leaving a run alone.',
    ]);
    fs.writeFileSync(ci, "const CHECKS = [{ name: 'test', cmd: 'npm test' }];\nexport default async () => ({});\n");
    expect(check()).toEqual([]);
  });

  it('the loop refuses to start, and spawns nothing', async () => {
    const r = repo('custom');
    let failed = '';
    const outcome = await runExecLoop(r.root, 'R-1', {}, { onRunFailed: (m) => { failed = m; } });
    expect(outcome).toEqual({ kind: 'error' });
    expect(failed).toBe(
      'Pipeline "p" is an autopilot pipeline, and it is not safe to leave this run alone yet:\n' +
      '  - You are on "main". Autopilot does not commit to it — switch to a branch for this epic (git switch -c <branch>).',
    );
    expect(fs.existsSync(path.join(r.root, '.aidlc', 'ctx.json'))).toBe(false);
    // A preview spawns nothing, so it is not refused.
    expect(await runExecLoop(r.root, 'R-1', { dryRun: true })).toEqual({ kind: 'dry_run' });
  });

  it('once it starts, the agent sees AIDLC_AUTOPILOT=1 and the runner\'s args', async () => {
    const r = repo('custom');
    git(r.root, 'switch', '-q', '-c', 'feat/x');
    expect(await runExecLoop(r.root, 'R-1', {})).toEqual({ kind: 'completed' });
    expect(JSON.parse(fs.readFileSync(path.join(r.root, '.aidlc', 'ctx.json'), 'utf8'))).toEqual({
      autopilot: '1', extraArgs: ['--allowedTools', 'Read'],
    });
  });
});

describe('recipes carry autopilot settings', () => {
  it('copies autopilot, max_send_backs and a gate\'s timeout_minutes onto the pipeline', () => {
    const config = validateWorkspace({
      version: '1.0', name: 't',
      agents: [{ id: 'dev', name: 'Dev', skills: ['work'] }, { id: 'rev', name: 'Rev', skills: ['work'] }],
      skills: [{ id: 'work', path: 'work.md' }],
      pipelines: [{ id: 'src', max_send_backs: 5, steps: [{ name: 'implement', agent: 'dev', timeout_minutes: 45 }, 'rev'] }],
      recipes: [{
        id: 'auto', from: 'src', steps: ['implement', 'rev'], autopilot: true, max_send_backs: 2,
        gates: { implement: { timeout_minutes: 30 }, rev: { timeout_minutes: 20 } },
      }, { id: 'plain', from: 'src', steps: ['implement', 'rev'] }],
    }, 'w.yaml');
    const p = assemblePipeline(config, { recipeId: 'auto' });
    expect(p).toMatchObject({ autopilot: true, max_send_backs: 2 });
    expect(p.steps.map((s) => (s as { timeout_minutes?: number }).timeout_minutes)).toEqual([30, 20]);
    const plain = assemblePipeline(config, { recipeId: 'plain' });
    expect(plain.autopilot).toBeUndefined();
    expect(plain.max_send_backs).toBe(5);
    expect((plain.steps[0] as { timeout_minutes?: number }).timeout_minutes).toBe(45);
  });
});

// ── Stopping a step ─────────────────────────────────────────────────────────

/** A workspace whose one step waits until its signal aborts (or 30s). */
function waitingWorkspace(timeoutMinutes?: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-stop-'));
  const aidlc = path.join(root, '.aidlc');
  fs.mkdirSync(path.join(aidlc, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(aidlc, 'skills', 'work.md'), 'Do the work.\n');
  fs.writeFileSync(path.join(aidlc, 'wait.cjs'), `
module.exports = { async run(o) {
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 30000);
    o.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); });
  });
  return { success: false, output: '' };
} };
`);
  fs.writeFileSync(path.join(aidlc, 'workspace.yaml'), `
version: "1.0"
name: stop
agents:
  - { id: dev, name: Dev, skills: [work], runner: custom, runner_path: .aidlc/wait.cjs }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - id: p
    steps:
      - { name: implement, agent: dev${timeoutMinutes ? `, timeout_minutes: ${timeoutMinutes}` : ''} }
`);
  RunStateStore.save(root, startRun({ runId: 'R-1', pipeline: WorkspaceLoader.load(root).config.pipelines[0], context: {} }));
  return root;
}

describe('stopping a running step', () => {
  it('timeout_minutes stops the agent and fails the run, leaving the step awaiting work', async () => {
    const root = waitingWorkspace(0.005); // 0.3s
    let message = '';
    const started = Date.now();
    const outcome = await runExecLoop(root, 'R-1', {}, { onStepFailed: (e) => { message = e.message ?? ''; } });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome).toEqual({ kind: 'error' });
    expect(message).toMatch(/^Step "dev" ran past its 0\.005-minute limit \(`timeout_minutes`\) and was stopped\./);
    const step = RunStateStore.load(root, 'R-1')!.steps[0];
    expect(step).toMatchObject({ status: 'awaiting_work', revision: 1 });
    expect(step.history).toEqual([expect.objectContaining({ kind: 'interrupted', why: 'timeout', minutes: 0.005, revision: 1 })]);
  });

  it('the stop-now signal ends the step and the loop with cancelled', async () => {
    const root = waitingWorkspace();
    const stop = new AbortController();
    let stopped = false;
    const outcome = await runExecLoop(root, 'R-1', { signal: stop.signal }, {
      onStepStart: () => { setTimeout(() => stop.abort(), 100); },
      onStepStopped: () => { stopped = true; },
    });
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(stopped).toBe(true);
    const step = RunStateStore.load(root, 'R-1')!.steps[0];
    expect(step.status).toBe('awaiting_work');
    expect(step.history).toEqual([expect.objectContaining({ kind: 'interrupted', why: 'stopped' })]);
  });
});

describe.skipIf(process.platform === 'win32')('stopOnAbort', () => {
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  it('kills the whole process tree, escalating to SIGKILL for what ignores SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-tree-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    // The parent starts a grandchild that ignores SIGTERM, as a test runner
    // or dev server an agent started might, then waits forever itself.
    const script = `
const { spawn } = require('child_process');
const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
setInterval(() => {}, 1000);
`;
    const proc = spawn(process.execPath, ['-e', script], { stdio: 'ignore', ...processGroupSpawnOptions() });
    const ac = new AbortController();
    const closed = new Promise<void>((resolve) => proc.on('close', () => resolve()));
    const detach = stopOnAbort(proc, ac.signal, 300);

    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) { await new Promise((r) => setTimeout(r, 50)); }
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);

    ac.abort();
    await closed;
    detach();
    for (let i = 0; i < 40 && alive(grandchild); i++) { await new Promise((r) => setTimeout(r, 50)); }
    expect(alive(grandchild)).toBe(false);
  });
});
