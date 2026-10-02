/**
 * An agent that offers several `models` runs the one picked for the step,
 * else its `model`. Covered through the pick to the unattended runner.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  runExecLoop,
  chooseStepModel,
  pickAgentModel,
  stepModelOptions,
  normalizeStep,
  markStepDone,
  rejectStep,
  RunStateStore,
  WorkspaceLoader,
  PipelineRunError,
} from '../src/index';
import type { PipelineConfig } from '../src/index';

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-model-choice-'));
  fs.mkdirSync(path.join(root, '.aidlc', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aidlc', 'skills', 'impl.md'), 'SKILL-IMPL\n');
  // Records the model it was handed.
  fs.writeFileSync(path.join(root, '.aidlc', 'spy.cjs'), `
const fs = require('fs'); const path = require('path');
module.exports = { async run(o) {
  fs.writeFileSync(path.join(o.workspaceRoot, 'model.log'), String(o.model));
  return { success: true, output: 'ok' };
} };
`);
  fs.writeFileSync(path.join(root, '.aidlc', 'workspace.yaml'), `
version: "1.0"
name: choice
agents:
  - { id: dev, name: Dev, skills: [impl], model: sonnet, models: [sonnet, opus], runner: custom, runner_path: .aidlc/spy.cjs }
skills:
  - { id: impl, path: .aidlc/skills/impl.md }
pipelines:
  - id: p
    steps: [dev]
`);
  return root;
}

describe('pickAgentModel', () => {
  const agent = { model: 'sonnet', models: ['sonnet', 'opus'] };
  it('takes the pick when offered', () => expect(pickAgentModel(agent, 'opus')).toBe('opus'));
  it('falls back to model for a stale pick', () => expect(pickAgentModel(agent, 'haiku')).toBe('sonnet'));
  it('falls back to the first offered with no model', () => expect(pickAgentModel({ models: ['opus'] })).toBe('opus'));
  it('ignores a pick on an agent with no models', () => expect(pickAgentModel({ model: 'sonnet' }, 'opus')).toBe('sonnet'));
});

describe('stepModelOptions', () => {
  const agent = { model: 'opus', models: ['opus', 'sonnet'] };
  it('makes the step model the default over the agent\'s', () => {
    expect(pickAgentModel(stepModelOptions(agent, 'sonnet'))).toBe('sonnet');
  });
  it('still lets a card pick win over the step default', () => {
    expect(pickAgentModel(stepModelOptions(agent, 'sonnet'), 'opus')).toBe('opus');
  });
  it('adds a step model the agent does not list as one more choice', () => {
    expect(stepModelOptions(agent, 'haiku').models).toEqual(['opus', 'sonnet', 'haiku']);
  });
  it('runs a step model on an agent with no models, with nothing to choose', () => {
    expect(stepModelOptions({ model: 'opus' }, 'sonnet')).toEqual({ model: 'sonnet' });
  });
});

describe('step model — schema + runner', () => {
  it('keeps `model` on a pipeline step and runs the step on it', async () => {
    const root = tmpRoot();
    const yamlPath = path.join(root, '.aidlc', 'workspace.yaml');
    fs.writeFileSync(yamlPath, fs.readFileSync(yamlPath, 'utf8')
      .replace('model: sonnet, models: [sonnet, opus]', 'model: opus')
      .replace('steps: [dev]', 'steps: [{ agent: dev, model: sonnet }]'));
    const ws = WorkspaceLoader.load(root);
    expect(normalizeStep(ws.config.pipelines[0].steps[0]).model).toBe('sonnet');
    RunStateStore.save(root, startRun({ runId: 'S', pipeline: ws.config.pipelines[0], context: {} }));
    await runExecLoop(root, 'S', {}, {});
    expect(fs.readFileSync(path.join(root, 'model.log'), 'utf8')).toBe('sonnet');
  });
});

describe('chooseStepModel', () => {
  const root = tmpRoot();
  const ws = WorkspaceLoader.load(root);
  const state = startRun({ runId: 'R', pipeline: ws.config.pipelines[0], context: {} });

  it('refuses a model the agent does not offer', () => {
    expect(() => chooseStepModel({ state, stepIdx: 0, models: ['sonnet', 'opus'], model: 'haiku' }))
      .toThrow(PipelineRunError);
  });

  it('runs the unattended step on the pick, and stamps it on approve', async () => {
    RunStateStore.save(root, chooseStepModel({ state, stepIdx: 0, models: ['sonnet', 'opus'], model: 'opus' }));
    await runExecLoop(root, 'R', {}, {});
    expect(fs.readFileSync(path.join(root, 'model.log'), 'utf8')).toBe('opus');
    expect(RunStateStore.load(root, 'R')!.steps[0].history?.at(-1)).toMatchObject({ kind: 'approve', model: 'opus' });
  });

  it('records the default when nothing was picked', async () => {
    const r = tmpRoot();
    const s = startRun({ runId: 'D', pipeline: WorkspaceLoader.load(r).config.pipelines[0], context: {} });
    RunStateStore.save(r, s);
    await runExecLoop(r, 'D', {}, {});
    expect(RunStateStore.load(r, 'D')!.steps[0].history?.at(-1)).toMatchObject({ kind: 'approve', model: 'sonnet' });
  });

  it('stamps it on reject', () => {
    const gated = { ...ws.config.pipelines[0], steps: [{ agent: 'dev', human_review: true }] } as PipelineConfig;
    const s = startRun({ runId: 'G', pipeline: gated, context: {} });
    const picked = chooseStepModel({ state: s, stepIdx: 0, models: ['sonnet', 'opus'], model: 'opus' });
    const done = markStepDone({ state: picked, pipeline: gated, workspaceRoot: root });
    const rejected = rejectStep({ state: done, pipeline: gated, reason: 'meh' });
    expect(rejected.steps[0].history?.at(-1)).toMatchObject({ kind: 'reject', model: 'opus' });
  });
});
