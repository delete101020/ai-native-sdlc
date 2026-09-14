/**
 * Follow-up hooks — the workspace's command, run when work is handed forward
 * and when a piece of it is finished.
 *
 * What must hold: a misspelt hook is an error, not silence; the hook comes from
 * the pipeline a person edits, not the copy an epic was assembled into; a
 * failing hook is recorded, not thrown; and a child's done hook runs once.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  collectFollowUpHookIssues,
  validateWorkspace,
  WorkspaceValidationError,
  resolveFollowUpHooks,
  fillFollowUpHookCommand,
  runFollowUpHook,
  readFollowUpHookLedger,
  writeFollowUpHookLedger,
  trackFollowUpChildren,
  applyFollowUpHookRun,
  pendingFollowUpDone,
  followUpHookFailures,
  type FollowUpHookPayload,
  type FollowUpHookRun,
} from '../src';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-followup-hooks-'));
}

const HANDOFF_STEP = {
  agent: 'writer',
  name: 'snp-handoff',
  produces: ['docs/epics/{epic}/followups.json'],
  on_followups_opened: 'node sync.mjs {epic}',
  on_followup_done: 'node sync.mjs {epic} --done {child}',
};

function workspace(step: Record<string, unknown>) {
  return {
    version: '1.0',
    name: 'Hooks',
    skills: [{ id: 'write', builtin: true }],
    agents: [{ id: 'writer', name: 'Writer', runner: 'default', skills: ['write'] }],
    pipelines: [{ id: 'snp', steps: [{ agent: 'writer', name: 'draft', produces: ['a.md'] }, step] }],
  };
}

describe('collectFollowUpHookIssues', () => {
  it('accepts hooks on the step that produces followups.json', () => {
    expect(collectFollowUpHookIssues(workspace(HANDOFF_STEP))).toEqual([]);
  });

  it('names a misspelt hook key instead of dropping it', () => {
    const { on_followups_opened: _o, ...rest } = HANDOFF_STEP;
    const issues = collectFollowUpHookIssues(workspace({ ...rest, on_followup_opened: 'x' }));
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('pipelines.snp.steps.snp-handoff.on_followup_opened');
    expect(issues[0].message).toContain('unknown hook');
  });

  it('rejects a hook away from the manifest step, an empty command, and an unavailable placeholder', () => {
    const messages = collectFollowUpHookIssues(workspace({
      agent: 'writer',
      name: 'elsewhere',
      produces: ['x.md'],
      on_followups_opened: 'node sync.mjs {child}',
      on_followup_done: '  ',
    })).map((i) => i.message).join('\n');
    expect(messages).toContain('belongs on the step that produces followups.json');
    expect(messages).toContain('`{child}` is not available in `on_followups_opened`');
    expect(messages).toContain('`on_followup_done` must be a non-empty command');
  });

  it('fails validateWorkspace, which is what reading workspace.yaml goes through', () => {
    expect(() => validateWorkspace(workspace({ ...HANDOFF_STEP, on_done: 'x' }), 'memory:test'))
      .toThrow(WorkspaceValidationError);
    expect(() => validateWorkspace(workspace({ ...HANDOFF_STEP, on_done: 'x' }), 'memory:test'))
      .toThrow(/on_done/);
    expect(() => validateWorkspace(workspace(HANDOFF_STEP), 'memory:test')).not.toThrow();
  });
});

describe('resolveFollowUpHooks', () => {
  function seedEpic(root: string, epicId: string, pipeline: string) {
    const dir = path.join(root, 'docs', 'epics', epicId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ pipeline }));
  }

  it('reads hooks from the pipeline an assembled epic was derived from', () => {
    const root = tmpRoot();
    seedEpic(root, 'SNP-001', 'SNP-001');
    const doc = {
      pipelines: [
        workspace(HANDOFF_STEP).pipelines[0],
        // The assembler copies only runner fields — no hooks on the epic's copy.
        { id: 'SNP-001', derived_from: 'snp', steps: [{ agent: 'writer', name: 'snp-handoff', produces: ['docs/epics/{epic}/followups.json'] }] },
      ],
    };
    expect(resolveFollowUpHooks(root, doc, 'SNP-001')).toEqual({
      stepName: 'snp-handoff',
      on_followups_opened: 'node sync.mjs {epic}',
      on_followup_done: 'node sync.mjs {epic} --done {child}',
    });
  });

  it('ignores a source step the recipe left out, and an epic with no pipeline', () => {
    const root = tmpRoot();
    seedEpic(root, 'SNP-002', 'SNP-002');
    const doc = {
      pipelines: [
        workspace(HANDOFF_STEP).pipelines[0],
        { id: 'SNP-002', derived_from: 'snp', steps: [{ agent: 'writer', name: 'draft' }] },
      ],
    };
    expect(resolveFollowUpHooks(root, doc, 'SNP-002')).toBeNull();
    expect(resolveFollowUpHooks(root, doc, 'NOPE')).toBeNull();
  });
});

describe('runFollowUpHook', () => {
  const payload: FollowUpHookPayload = {
    event: 'done',
    parent_epic: 'P',
    children: [{ epic: 'P-E-A', follow_up_key: 'E-A', recipe: 'native-full', status: 'done' }],
    child: { epic: 'P-E-A', follow_up_key: 'E-A', recipe: 'native-full', status: 'done' },
  };

  it('fills placeholders', () => {
    expect(fillFollowUpHookCommand('x {epic} --done {child} {key} {other}', payload)).toBe('x P --done P-E-A E-A {other}');
  });

  it('runs in the workspace root with the parent, child and payload file', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'hook.js'), `
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync(process.env.AIDLC_FOLLOWUPS_PAYLOAD, 'utf8'));
      fs.writeFileSync('out.json', JSON.stringify({
        argv: process.argv.slice(2), cwd: process.cwd(),
        parent: process.env.AIDLC_PARENT_EPIC, child: process.env.AIDLC_CHILD_EPIC,
        key: process.env.AIDLC_FOLLOW_UP_KEY, event: process.env.AIDLC_HOOK_EVENT, payload: p,
      }));
    `);
    const run = await runFollowUpHook({
      workspaceRoot: root,
      hook: 'on_followup_done',
      command: `"${process.execPath}" hook.js {epic} --done {child}`,
      payload,
    });
    expect(run.ok).toBe(true);
    const out = JSON.parse(fs.readFileSync(path.join(root, 'out.json'), 'utf8'));
    expect(out.argv).toEqual(['P', '--done', 'P-E-A']);
    expect(fs.realpathSync(out.cwd)).toBe(fs.realpathSync(root));
    expect(out).toMatchObject({ parent: 'P', child: 'P-E-A', key: 'E-A', event: 'done' });
    expect(out.payload.children[0].recipe).toBe('native-full');
  });

  it('reports a non-zero exit with its stderr rather than throwing', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'fail.js'), `console.error('handoff table is locked'); process.exit(3);`);
    const run = await runFollowUpHook({
      workspaceRoot: root, hook: 'on_followups_opened', command: `"${process.execPath}" fail.js`, payload,
    });
    expect(run.ok).toBe(false);
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain('handoff table is locked');
  });
});

describe('ledger', () => {
  const at = '2026-09-14T10:00:00.000Z';
  const run = (over: Partial<FollowUpHookRun>): FollowUpHookRun => ({
    hook: 'on_followup_done', event: 'done', command: 'x', at, ok: true, exitCode: 0,
    stderr: '', stdout: 'noise', durationMs: 1, children: [], ...over,
  });

  it('runs the done hook only for tracked children without a record', () => {
    const ledger = trackFollowUpChildren(readFollowUpHookLedger(tmpRoot(), null, 'P'), [
      { epic: 'P-E-A', follow_up_key: 'E-A', recipe: 'r' },
      { epic: 'P-E-B', follow_up_key: 'E-B', recipe: 'r' },
    ]);
    const child = { epic: 'P-E-A', follow_up_key: 'E-A', recipe: 'r' };
    applyFollowUpHookRun(ledger, run({ children: ['P-E-A'] }), { event: 'done', parent_epic: 'P', children: [child], child });
    expect(pendingFollowUpDone(ledger, ['P-E-A', 'P-E-B', 'UNTRACKED'])).toEqual(['P-E-B']);
  });

  it('shows failures until a successful sync covers them, and persists without stdout', () => {
    const root = tmpRoot();
    const a = { epic: 'P-E-A', follow_up_key: 'E-A', recipe: 'r', status: 'done' };
    const b = { epic: 'P-E-B', follow_up_key: 'E-B', recipe: 'r', status: 'done' };
    const ledger = readFollowUpHookLedger(root, null, 'P');
    applyFollowUpHookRun(ledger, run({ event: 'opened', hook: 'on_followups_opened', ok: false, exitCode: 1, stderr: 'boom' }), { event: 'opened', parent_epic: 'P', children: [a, b] });
    applyFollowUpHookRun(ledger, run({ ok: false, exitCode: 2, stderr: 'late' }), { event: 'done', parent_epic: 'P', children: [a], child: a });
    expect(followUpHookFailures(ledger).map((f) => f.stderr).sort()).toEqual(['boom', 'late']);

    applyFollowUpHookRun(ledger, run({ event: 'sync', hook: 'on_followups_opened', at: '2026-09-14T11:00:00.000Z' }), { event: 'sync', parent_epic: 'P', children: [a, b] });
    expect(followUpHookFailures(ledger)).toEqual([]);
    expect(pendingFollowUpDone(ledger, ['P-E-A', 'P-E-B'])).toEqual([]);

    writeFollowUpHookLedger(root, null, 'P', ledger);
    const back = readFollowUpHookLedger(root, null, 'P');
    expect(back.done['P-E-B']).toEqual({ via: 'sync', at: '2026-09-14T11:00:00.000Z' });
    expect(JSON.stringify(back)).not.toContain('noise');
  });
});
