/**
 * A step whose `skills` are alternatives — `default_skill` set — runs exactly
 * one of them: the one picked for it, else the default. Covered here from the
 * schema through the pick to the unattended runner, because the runner used to
 * load the *agent's* skills and ignore the step's altogether, which for two
 * interchangeable review skills means the model runs both procedures at once.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  runExecLoop,
  chooseStepSkill,
  markStepDone,
  approveStep,
  rejectStep,
  resolveStepSkills,
  stepSkillAlternatives,
  normalizeStep,
  validateWorkspace,
  assemblePipeline,
  RunStateStore,
  WorkspaceLoader,
  PipelineRunError,
  resolveComposition,
  renderRunReport,
} from '../src/index';
import type { PipelineConfig, RunState } from '../src/index';
import { renameSkillRefs } from '../src/loader/renameRefs';

const REVIEW_STEP = { agent: 'rev', name: 'review', skills: ['ponytail', 'ocr'], default_skill: 'ponytail' };

function tmpRoot(step: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-skill-choice-'));
  const skills = path.join(root, '.aidlc', 'skills');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, 'ponytail.md'), 'SKILL-PONYTAIL\n');
  fs.writeFileSync(path.join(skills, 'ocr.md'), 'SKILL-OCR\n');
  fs.writeFileSync(path.join(skills, 'notes.md'), 'SKILL-NOTES\n');
  // Records the skill text it was handed, so the test can see what was loaded.
  fs.writeFileSync(path.join(root, '.aidlc', 'spy.cjs'), `
const fs = require('fs'); const path = require('path');
module.exports = { async run(o) {
  fs.appendFileSync(path.join(o.workspaceRoot, 'prompts.log'), o.skill + '\\n=====\\n');
  return { success: true, output: 'ok' };
} };
`);
  fs.writeFileSync(path.join(root, '.aidlc', 'workspace.yaml'), `
version: "1.0"
name: choice
agents:
  - { id: rev, name: Rev, skills: [ponytail, ocr, notes], runner: custom, runner_path: .aidlc/spy.cjs }
skills:
  - { id: ponytail, path: .aidlc/skills/ponytail.md }
  - { id: ocr, path: .aidlc/skills/ocr.md }
  - { id: notes, path: .aidlc/skills/notes.md }
pipelines:
  - id: p
    steps:
      - ${step}
`);
  return root;
}

function seed(root: string, runId: string): RunState {
  const ws = WorkspaceLoader.load(root);
  const state = startRun({ runId, pipeline: ws.config.pipelines[0], context: {} });
  RunStateStore.save(root, state);
  return state;
}

function prompts(root: string): string {
  return fs.readFileSync(path.join(root, 'prompts.log'), 'utf8');
}

const pipeline: PipelineConfig = { id: 'p', steps: [REVIEW_STEP], on_failure: 'stop' } as PipelineConfig;

describe('default_skill — schema', () => {
  const base = {
    version: '1.0',
    name: 'x',
    agents: [{ id: 'rev', name: 'Rev', skills: ['ponytail', 'ocr'] }],
    skills: [{ id: 'ponytail', path: 'a.md' }, { id: 'ocr', path: 'b.md' }],
  };

  it('accepts a default that is one of the step\'s skills', () => {
    expect(() => validateWorkspace({ ...base, pipelines: [{ id: 'p', steps: [REVIEW_STEP] }] })).not.toThrow();
  });

  it('rejects a default the step does not list', () => {
    expect(() => validateWorkspace({
      ...base,
      pipelines: [{ id: 'p', steps: [{ ...REVIEW_STEP, default_skill: 'other' }] }],
    })).toThrow(/default_skill/);
  });
});

describe('resolveStepSkills', () => {
  const agentSkills = ['ponytail', 'ocr', 'notes'];

  it('runs only the default when nothing was picked', () => {
    expect(resolveStepSkills(normalizeStep(REVIEW_STEP), agentSkills)).toEqual(['ponytail']);
  });

  it('runs the pick when it is still among the alternatives', () => {
    expect(resolveStepSkills(normalizeStep(REVIEW_STEP), agentSkills, 'ocr')).toEqual(['ocr']);
  });

  it('falls back to the default when the pick is no longer offered', () => {
    expect(resolveStepSkills(normalizeStep(REVIEW_STEP), agentSkills, 'gone')).toEqual(['ponytail']);
  });

  it('keeps every skill of a step without a default — they all apply', () => {
    const norm = normalizeStep({ agent: 'rev', skills: ['ponytail', 'notes'] });
    expect(stepSkillAlternatives(norm)).toBeUndefined();
    expect(resolveStepSkills(norm, agentSkills, 'ocr')).toEqual(['ponytail', 'notes']);
  });

  it('falls back to the agent\'s skills when the step names none', () => {
    expect(resolveStepSkills(normalizeStep({ agent: 'rev' }), agentSkills)).toEqual(agentSkills);
  });
});

describe('chooseStepSkill', () => {
  const state = startRun({ runId: 'R', pipeline, context: {} });

  it('records the pick without touching status or history', () => {
    const next = chooseStepSkill({ state, pipeline, stepIdx: 0, skill: 'ocr' });
    expect(next.steps[0].skill).toBe('ocr');
    expect(next.steps[0].status).toBe(state.steps[0].status);
    expect(next.steps[0].history).toEqual(state.steps[0].history);
    expect(state.steps[0].skill).toBeUndefined();
  });

  it('refuses a skill that is not an alternative', () => {
    expect(() => chooseStepSkill({ state, pipeline, stepIdx: 0, skill: 'notes' })).toThrow(PipelineRunError);
  });

  it('refuses a step that offers no alternatives', () => {
    const plain = { ...pipeline, steps: [{ agent: 'rev', skills: ['ponytail', 'ocr'] }] } as PipelineConfig;
    const s = startRun({ runId: 'R', pipeline: plain, context: {} });
    expect(() => chooseStepSkill({ state: s, pipeline: plain, stepIdx: 0, skill: 'ocr' })).toThrow(/no alternative/);
  });

  const humanPipeline = { ...pipeline, steps: [{ ...REVIEW_STEP, human_review: true }] } as PipelineConfig;

  it('stamps the judged revision\'s skill on reject history', () => {
    let s = startRun({ runId: 'R', pipeline: humanPipeline, context: {} });
    s = chooseStepSkill({ state: s, pipeline: humanPipeline, stepIdx: 0, skill: 'ocr' });
    s = markStepDone({ state: s, pipeline: humanPipeline, workspaceRoot: os.tmpdir() });
    s = rejectStep({ state: s, pipeline: humanPipeline, reason: 'meh' });
    expect(s.steps[0].history?.at(-1)).toMatchObject({ kind: 'reject', skill: 'ocr' });
  });

  it('stamps it on approve too', () => {
    let s = startRun({ runId: 'R', pipeline: humanPipeline, context: {} });
    s = chooseStepSkill({ state: s, pipeline: humanPipeline, stepIdx: 0, skill: 'ocr' });
    s = markStepDone({ state: s, pipeline: humanPipeline, workspaceRoot: os.tmpdir() });
    s = approveStep({ state: s, pipeline: humanPipeline });
    expect(s.steps[0].history?.at(-1)).toMatchObject({ kind: 'approve', skill: 'ocr' });
  });
});

describe('autopilot — which skill is loaded', () => {
  it('loads only the default when nothing was picked, and records it', async () => {
    const root = tmpRoot('{ agent: rev, name: review, skills: [ponytail, ocr], default_skill: ponytail }');
    seed(root, 'R-1');
    await runExecLoop(root, 'R-1', {}, {});
    expect(prompts(root)).toContain('SKILL-PONYTAIL');
    expect(prompts(root)).not.toContain('SKILL-OCR');
    expect(RunStateStore.load(root, 'R-1')!.steps[0].skill).toBe('ponytail');
  });

  it('loads the skill picked on the step', async () => {
    const root = tmpRoot('{ agent: rev, name: review, skills: [ponytail, ocr], default_skill: ponytail }');
    const state = seed(root, 'R-2');
    const ws = WorkspaceLoader.load(root);
    RunStateStore.save(root, chooseStepSkill({ state, pipeline: ws.config.pipelines[0], stepIdx: 0, skill: 'ocr' }));
    await runExecLoop(root, 'R-2', {}, {});
    expect(prompts(root)).toContain('SKILL-OCR');
    expect(prompts(root)).not.toContain('SKILL-PONYTAIL');
  });

  it('lets --skill override the pick', async () => {
    const root = tmpRoot('{ agent: rev, name: review, skills: [ponytail, ocr], default_skill: ponytail }');
    seed(root, 'R-3');
    await runExecLoop(root, 'R-3', { skill: 'ocr' }, {});
    expect(prompts(root)).toContain('SKILL-OCR');
    expect(prompts(root)).not.toContain('SKILL-PONYTAIL');
  });

  it('ignores a --skill the step does not offer, keeping its own pick', async () => {
    const root = tmpRoot('{ agent: rev, name: review, skills: [ponytail, ocr], default_skill: ponytail }');
    const state = seed(root, 'R-5');
    const ws = WorkspaceLoader.load(root);
    RunStateStore.save(root, chooseStepSkill({ state, pipeline: ws.config.pipelines[0], stepIdx: 0, skill: 'ocr' }));
    await runExecLoop(root, 'R-5', { skill: 'notes' }, {});
    expect(prompts(root)).toContain('SKILL-OCR');
    expect(prompts(root)).not.toContain('SKILL-PONYTAIL');
  });

  it('narrows to the step\'s skills instead of loading all of the agent\'s', async () => {
    const root = tmpRoot('{ agent: rev, name: review, skills: [notes] }');
    seed(root, 'R-4');
    await runExecLoop(root, 'R-4', {}, {});
    expect(prompts(root)).toContain('SKILL-NOTES');
    expect(prompts(root)).not.toContain('SKILL-PONYTAIL');
    expect(RunStateStore.load(root, 'R-4')!.steps[0].skill).toBeUndefined();
  });
});

describe('default_skill travels with the step', () => {
  it('follows a skill rename', () => {
    const doc = { pipelines: [{ id: 'p', steps: [{ ...REVIEW_STEP }] }] };
    renameSkillRefs(doc, 'ponytail', 'ponytail-v2');
    expect(doc.pipelines[0].steps[0]).toMatchObject({ skills: ['ponytail-v2', 'ocr'], default_skill: 'ponytail-v2' });
  });

  it('survives recipe assembly', () => {
    const config = validateWorkspace({
      version: '1.0',
      name: 'x',
      agents: [{ id: 'rev', name: 'Rev', skills: ['ponytail', 'ocr'] }],
      skills: [{ id: 'ponytail', path: 'a.md' }, { id: 'ocr', path: 'b.md' }],
      pipelines: [{ id: 'p', steps: [REVIEW_STEP] }],
      recipes: [{ id: 'r', from: 'p', steps: ['review'] }],
    });
    const assembled = assemblePipeline(config, { recipeId: 'r' });
    expect(normalizeStep(assembled.steps[0]).default_skill).toBe('ponytail');
  });
});

describe('surfaces outside the runner', () => {
  const config = validateWorkspace({
    version: '1.0',
    name: 'x',
    agents: [{ id: 'rev', name: 'Rev', skills: ['ponytail', 'ocr'] }],
    skills: [{ id: 'ponytail', path: 'a.md' }, { id: 'ocr', path: 'b.md' }],
    pipelines: [{ id: 'p', steps: [REVIEW_STEP] }],
  });

  it('the /aidlc dispatcher composes one alternative, not all', () => {
    expect(resolveComposition(config, 'p', 'review')).toMatchObject({ found: true, skills: ['ponytail'] });
    expect(resolveComposition(config, 'p', 'review', 'ocr')).toMatchObject({ skills: ['ocr'] });
  });

  it('the run report names the skill each verdict judged', () => {
    const human = { ...pipeline, steps: [{ ...REVIEW_STEP, human_review: true }] } as PipelineConfig;
    let s = startRun({ runId: 'R', pipeline: human, context: {} });
    s = chooseStepSkill({ state: s, pipeline: human, stepIdx: 0, skill: 'ocr' });
    s = markStepDone({ state: s, pipeline: human, workspaceRoot: os.tmpdir() });
    s = approveStep({ state: s, pipeline: human });
    expect(renderRunReport({ state: s, pipeline: human })).toContain('approved (rev 1, ocr)');
  });
});
