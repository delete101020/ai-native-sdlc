/**
 * A rerun must not pass on the previous revision's artifact. Observed live on
 * Copilot CLI: `create` refused to overwrite spec.md, the model claimed the
 * spec was saved, and the step went to review with the old file.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  runExecLoop,
  RunStateStore,
  WorkspaceLoader,
  snapshotProduces,
  unchangedProduces,
} from '../src/index';

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-produces-'));
  fs.mkdirSync(path.join(root, '.aidlc', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aidlc', 'skills', 'work.md'), 'Do the work.\n');
  return root;
}

/** A custom runner that optionally writes `out/spec.md`, then reports success. */
function runnerModule(root: string, name: string, write: string | null): string {
  const rel = path.join('.aidlc', `${name}.cjs`);
  const body = write === null
    ? ''
    : `require('fs').mkdirSync(require('path').join(ctx.workspaceRoot, 'out'), { recursive: true });
       require('fs').writeFileSync(require('path').join(ctx.workspaceRoot, 'out', 'spec.md'), ${JSON.stringify(write)});`;
  fs.writeFileSync(path.join(root, rel),
    `module.exports = { async run(ctx) { ${body} return { success: true, output: 'saved' }; } };\n`);
  return rel;
}

function setup(root: string, runnerPath: string): void {
  fs.writeFileSync(path.join(root, '.aidlc', 'workspace.yaml'), `
version: "1.0"
name: produces
agents:
  - { id: po, name: PO, skills: [work], runner: custom, runner_path: ${runnerPath} }
skills:
  - { id: work, path: .aidlc/skills/work.md }
pipelines:
  - id: p1
    name: P1
    steps:
      - { agent: po, produces: [out/spec.md] }
`);
  const pipeline = WorkspaceLoader.load(root).config.pipelines[0];
  RunStateStore.save(root, startRun({ runId: 'R-1', pipeline, context: {} }));
}

describe('exec loop — unchanged artifacts', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('fails a step that reports success but leaves the existing artifact untouched', async () => {
    fs.mkdirSync(path.join(root, 'out'));
    fs.writeFileSync(path.join(root, 'out', 'spec.md'), 'previous revision\n');
    setup(root, runnerModule(root, 'lazy', null));

    const failures: string[] = [];
    await runExecLoop(root, 'R-1', {}, { onStepFailed: (e) => failures.push(e.message ?? '') });

    expect(failures.join('\n')).toContain('left its artifacts unchanged: out/spec.md');
    expect(RunStateStore.load(root, 'R-1')!.steps[0].status).toBe('awaiting_work');
  });

  it('passes a step that rewrites the existing artifact', async () => {
    fs.mkdirSync(path.join(root, 'out'));
    fs.writeFileSync(path.join(root, 'out', 'spec.md'), 'previous revision\n');
    setup(root, runnerModule(root, 'writer', 'new revision\n'));

    await runExecLoop(root, 'R-1', {});

    expect(RunStateStore.load(root, 'R-1')!.steps[0].status).not.toBe('awaiting_work');
  });

  it('passes a first run that creates the artifact', async () => {
    setup(root, runnerModule(root, 'writer', 'first revision\n'));

    await runExecLoop(root, 'R-1', {});

    expect(RunStateStore.load(root, 'R-1')!.steps[0].status).not.toBe('awaiting_work');
  });
});

describe('unchangedProduces', () => {
  const pipeline = {
    id: 'p', name: 'p',
    steps: [{ agent: 'a', produces: ['a.md', 'b.md'] }],
  } as never;
  const state = { context: {} } as never;

  it('is empty when at least one of several artifacts changed', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'a.md'), 'a');
    fs.writeFileSync(path.join(root, 'b.md'), 'b');
    const before = snapshotProduces({ state, pipeline, workspaceRoot: root, stepIdx: 0 });
    fs.writeFileSync(path.join(root, 'b.md'), 'b2');
    expect(unchangedProduces(before, root)).toEqual([]);
  });

  it('lists every artifact when none changed', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'a.md'), 'a');
    fs.writeFileSync(path.join(root, 'b.md'), 'b');
    const before = snapshotProduces({ state, pipeline, workspaceRoot: root, stepIdx: 0 });
    expect(unchangedProduces(before, root)).toEqual(['a.md', 'b.md']);
  });

  it('leaves a missing artifact to the produces check', () => {
    const root = tmpRoot();
    const before = snapshotProduces({ state, pipeline, workspaceRoot: root, stepIdx: 0 });
    expect(unchangedProduces(before, root)).toEqual([]);
  });
});
