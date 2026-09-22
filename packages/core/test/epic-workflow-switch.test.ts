import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

import {
  planEpicWorkflowSwitch,
  stageEpicWorkflowSwitch,
  applyEpicWorkflowSwitch,
  epicWorkflowLock,
  canSwitchEpicWorkflow,
  EpicWorkflowSwitchError,
  scaffoldEpic,
  assemblePipeline,
  stageEpicPipeline,
  mergeEpicPipelines,
  splitEpicPipelines,
  writeEpicPipelines,
  validateWorkspace,
  RunStateStore,
  type WorkspaceConfig,
} from '../src';

/** The raw document both front doors hand this module. */
function doc(): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'test',
    state: { entity: 'epic', root: 'docs/epics' },
    agents: [
      { id: 'po', name: 'PO', skills: ['prd'] },
      { id: 'tech-lead', name: 'Tech Lead', skills: ['tech-design'] },
      { id: 'developer', name: 'Dev', skills: ['implement'] },
      { id: 'qa', name: 'QA', skills: ['test-report'] },
    ],
    skills: [
      { id: 'prd', builtin: true },
      { id: 'tech-design', builtin: true },
      { id: 'implement', builtin: true },
      { id: 'test-report', builtin: true },
    ],
    pipelines: [
      {
        id: 'sdlc-full',
        on_failure: 'stop',
        steps: [
          { name: 'plan', agent: 'po', skills: ['prd'] },
          { name: 'design', agent: 'tech-lead', skills: ['tech-design'], depends_on: ['plan'] },
          { name: 'implement', agent: 'developer', skills: ['implement'], depends_on: ['design'] },
          { name: 'test-report', agent: 'qa', skills: ['test-report'], depends_on: ['implement'] },
        ],
      },
    ],
    recipes: [
      { id: 'bugfix', steps: ['implement', 'test-report'] },
      { id: 'large-feature', steps: ['plan', 'design', 'implement', 'test-report'] },
    ],
  };
}

function config(d: Record<string, unknown>): WorkspaceConfig {
  return validateWorkspace(d, 'test.yaml');
}

let root: string;

/**
 * A started epic, exactly as `epic start` leaves one: the pipeline assembled
 * from `recipeId`, written to the epic's own file, and a fresh run laid out.
 */
function startEpic(d: Record<string, unknown>, epicId: string, recipeId: string): void {
  const pipeline = assemblePipeline(config(d), { recipeId, pipelineId: epicId });
  (d.pipelines as unknown[]).push(pipeline);
  stageEpicPipeline(d, pipeline.id, epicId);
  writeWorkspace(d);
  scaffoldEpic({
    workspaceRoot: root,
    doc: d,
    epicId,
    title: 'Checkout',
    description: 'one-liner',
    target: { kind: 'pipeline', id: pipeline.id },
    agents: pipeline.steps.map((s) => (s as { agent: string }).agent),
    inputs: { repo: 'acme/web' },
    pipeline,
  });
}

/** What the extension/CLI write path does: epic files first, then the yaml. */
function writeWorkspace(d: Record<string, unknown>): void {
  const split = splitEpicPipelines(root, d as { pipelines: Array<Record<string, unknown>> });
  writeEpicPipelines(split.external);
  fs.mkdirSync(path.join(root, '.aidlc'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.aidlc', 'workspace.yaml'),
    yaml.dump({ ...d, pipelines: split.inline }),
    'utf8',
  );
}

/** Re-read the workspace the way a later command would, epic files merged in. */
function reload(): Record<string, unknown> {
  const d = yaml.load(
    fs.readFileSync(path.join(root, '.aidlc', 'workspace.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  mergeEpicPipelines(root, d as { pipelines: Array<Record<string, unknown>> });
  return d;
}

function epicState(epicId: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(root, 'docs', 'epics', epicId, 'state.json'), 'utf8'),
  );
}

/** Plan → stage → write → apply, the whole operation as a caller runs it. */
function switchTo(epicId: string, target: { kind: 'recipe' | 'pipeline'; id: string }) {
  const d = reload();
  const plan = planEpicWorkflowSwitch({
    workspaceRoot: root, doc: d as never, config: config(d), epicId, target,
  });
  stageEpicWorkflowSwitch(d as never, plan);
  writeWorkspace(d);
  return applyEpicWorkflowSwitch(root, d as never, plan);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-switch-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('epicWorkflowLock', () => {
  it('leaves the window open on a run that has only just been laid out', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');
    expect(epicWorkflowLock(RunStateStore.load(root, 'CR-1'))).toBeNull();
    expect(canSwitchEpicWorkflow(root, 'CR-1')).toBe(true);
  });

  it('closes it as soon as a step has been worked on', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');
    const run = RunStateStore.load(root, 'CR-1')!;
    run.steps[0].status = 'awaiting_review';
    RunStateStore.save(root, run);

    expect(epicWorkflowLock(RunStateStore.load(root, 'CR-1')))
      .toBe('step "implement" is awaiting_review');
    expect(canSwitchEpicWorkflow(root, 'CR-1')).toBe(false);
  });

  it('closes it on history, a rerun, produced artifacts or a finished run', () => {
    const base = () => RunStateStore.load(root, 'CR-1')!;
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');

    const withHistory = base();
    withHistory.steps[1].history = [
      { kind: 'approve', at: 'now', revision: 1 } as never,
    ];
    expect(epicWorkflowLock(withHistory)).toBe('step "test-report" already has history');

    const rerun = base();
    rerun.steps[0].revision = 2;
    expect(epicWorkflowLock(rerun)).toBe('step "implement" has already been rerun');

    const produced = base();
    produced.steps[0].artifactsProduced = ['docs/epics/CR-1/artifacts/impl.md'];
    expect(epicWorkflowLock(produced)).toBe('step "implement" has produced artifacts');

    const done = base();
    done.status = 'completed';
    expect(epicWorkflowLock(done)).toBe('the run is already completed');
  });

  it('is not a lock when there is no run at all', () => {
    // A single-agent epic never started one, and a deleted run file has no
    // records to protect — pointing either at a pipeline is the repair.
    expect(epicWorkflowLock(null)).toBeNull();
  });
});

describe('switching to another recipe', () => {
  it('re-derives the steps, the run and state.json', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');
    expect(epicState('CR-1').agents).toEqual(['developer', 'qa']);

    const result = switchTo('CR-1', { kind: 'recipe', id: 'large-feature' });

    expect(result.pipelineId).toBe('CR-1');
    expect(result.agents).toEqual(['po', 'tech-lead', 'developer', 'qa']);

    const state = epicState('CR-1');
    expect(state.pipeline).toBe('CR-1');
    expect(state.agents).toEqual(['po', 'tech-lead', 'developer', 'qa']);
    expect((state.stepStates as unknown[]).length).toBe(4);
    expect(state.currentStep).toBe(0);
    // Same status a freshly started epic carries: the run exists and its root
    // step is open for work.
    expect(state.status).toBe('in_progress');

    const run = RunStateStore.load(root, 'CR-1')!;
    expect(run.steps.map((s) => s.name)).toEqual(['plan', 'design', 'implement', 'test-report']);
    // Only the DAG roots are open, same as a fresh start.
    expect(run.steps[0].status).toBe('awaiting_work');
    expect(run.steps[1].status).toBe('pending');
  });

  it('rewrites the epic\'s own pipeline.yaml in place, and nothing else', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');
    switchTo('CR-1', { kind: 'recipe', id: 'large-feature' });

    const own = yaml.load(
      fs.readFileSync(path.join(root, 'docs', 'epics', 'CR-1', 'pipeline.yaml'), 'utf8'),
    ) as { id: string; steps: Array<{ name: string }> };
    expect(own.id).toBe('CR-1');
    expect(own.steps.map((s) => s.name)).toEqual(['plan', 'design', 'implement', 'test-report']);

    // The shared file keeps only the shared pipeline — the epic's copy never
    // leaks back into it.
    const shared = yaml.load(
      fs.readFileSync(path.join(root, '.aidlc', 'workspace.yaml'), 'utf8'),
    ) as { pipelines: Array<{ id: string }> };
    expect(shared.pipelines.map((p) => p.id)).toEqual(['sdlc-full']);
  });

  it('carries the capability inputs over instead of asking again', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');
    switchTo('CR-1', { kind: 'recipe', id: 'large-feature' });
    expect(RunStateStore.load(root, 'CR-1')!.context).toEqual({ repo: 'acme/web', epic: 'CR-1' });
  });
});

describe('switching to a shared pipeline', () => {
  it('drops the epic\'s own definition and points state.json at the shared one', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');

    const result = switchTo('CR-1', { kind: 'pipeline', id: 'sdlc-full' });

    expect(result.pipelineId).toBe('sdlc-full');
    expect(result.removedPipelineFile).toContain('pipeline.yaml');
    expect(fs.existsSync(path.join(root, 'docs', 'epics', 'CR-1', 'pipeline.yaml'))).toBe(false);
    expect(epicState('CR-1').pipeline).toBe('sdlc-full');
    expect(RunStateStore.load(root, 'CR-1')!.pipelineId).toBe('sdlc-full');

    // And the shared pipeline is still exactly one pipeline, unowned.
    const shared = yaml.load(
      fs.readFileSync(path.join(root, '.aidlc', 'workspace.yaml'), 'utf8'),
    ) as { pipelines: Array<{ id: string }> };
    expect(shared.pipelines.map((p) => p.id)).toEqual(['sdlc-full']);
  });

  it('refuses a pipeline another epic owns', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');
    startEpic(reload(), 'CR-2', 'large-feature');

    const merged = reload();
    expect(() => planEpicWorkflowSwitch({
      workspaceRoot: root, doc: merged as never, config: config(merged),
      epicId: 'CR-1', target: { kind: 'pipeline', id: 'CR-2' },
    })).toThrow(/belongs to epic "CR-2"/);
  });

  it('refuses a pipeline that does not exist, and the one it already runs', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');
    const merged = reload();
    const plan = (id: string) => planEpicWorkflowSwitch({
      workspaceRoot: root, doc: merged as never, config: config(merged),
      epicId: 'CR-1', target: { kind: 'pipeline', id },
    });
    expect(() => plan('ghost')).toThrow(/not defined/);
    expect(() => plan('CR-1')).toThrow(/already runs pipeline "CR-1"/);
  });
});

describe('refusals', () => {
  it('refuses once a step has moved, and says which one', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');
    const run = RunStateStore.load(root, 'CR-1')!;
    run.steps[0].status = 'approved';
    RunStateStore.save(root, run);

    const merged = reload();
    expect(() => planEpicWorkflowSwitch({
      workspaceRoot: root, doc: merged as never, config: config(merged),
      epicId: 'CR-1', target: { kind: 'recipe', id: 'large-feature' },
    })).toThrow(/step "implement" is approved/);
  });

  it('leaves everything untouched when it refuses', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');
    const run = RunStateStore.load(root, 'CR-1')!;
    run.steps[0].status = 'approved';
    RunStateStore.save(root, run);
    const before = epicState('CR-1');

    try { switchTo('CR-1', { kind: 'recipe', id: 'large-feature' }); } catch { /* expected */ }

    expect(epicState('CR-1')).toEqual(before);
    expect(RunStateStore.load(root, 'CR-1')!.steps[0].status).toBe('approved');
  });

  it('refuses an epic with no state.json', () => {
    const d = doc();
    writeWorkspace(d);
    const merged = reload();
    expect(() => planEpicWorkflowSwitch({
      workspaceRoot: root, doc: merged as never, config: config(merged),
      epicId: 'NOPE', target: { kind: 'recipe', id: 'bugfix' },
    })).toThrow(EpicWorkflowSwitchError);
  });

  it('refuses a recipe that is not defined', () => {
    const d = doc();
    startEpic(d, 'CR-1', 'bugfix');
    const merged = reload();
    expect(() => planEpicWorkflowSwitch({
      workspaceRoot: root, doc: merged as never, config: config(merged),
      epicId: 'CR-1', target: { kind: 'recipe', id: 'ghost' },
    })).toThrow(/Recipe "ghost" not found/);
  });
});
