import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  scaffoldEpic,
  recipePipelineId,
  slugEpicId,
  RunStateStore,
  type PipelineConfig,
} from '../src';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-scaffold-'));
}

const PIPELINE: PipelineConfig = {
  id: 'sdlc-parallel-full',
  on_failure: 'stop',
  steps: [
    { agent: 'po', name: 'plan', requires: [], produces: ['PRD.md'], depends_on: [], human_review: true, auto_review: false, enabled: true },
    { agent: 'developer', name: 'implement', requires: ['PRD.md'], produces: ['CODE.md'], depends_on: ['plan'], human_review: true, auto_review: false, enabled: true },
  ],
};

describe('recipePipelineId — shared CLI/extension naming', () => {
  it('names after the epic when given one', () => {
    expect(recipePipelineId({ recipeId: 'small-feature', epicId: 'CPD-1', taken: new Set() }))
      .toBe('CPD-1');
  });
  it('falls back to <epic>-<recipe> then -N when taken', () => {
    expect(recipePipelineId({ recipeId: 'small-feature', epicId: 'CPD-1', taken: new Set(['CPD-1']) }))
      .toBe('CPD-1-small-feature');
    expect(recipePipelineId({ recipeId: 'small-feature', epicId: 'CPD-1', taken: new Set(['CPD-1', 'CPD-1-small-feature']) }))
      .toBe('CPD-1-small-feature-2');
  });
  it('names after the recipe when no epic is given (CLI generate)', () => {
    expect(recipePipelineId({ recipeId: 'bugfix', taken: new Set() })).toBe('bugfix');
    expect(recipePipelineId({ recipeId: 'bugfix', taken: new Set(['bugfix']) })).toBe('bugfix-2');
  });
});

describe('slugEpicId', () => {
  it('uppercases, dashes, caps length, requires a leading letter', () => {
    expect(slugEpicId('Accept the EULA gate!')).toBe('ACCEPT-THE-EULA-GATE');
    expect(slugEpicId('  spaces  ')).toBe('SPACES');
    expect(slugEpicId('123-only-digits-lead')).toBe('');
    expect(slugEpicId('a'.repeat(40))).toHaveLength(24);
  });
});

describe('scaffoldEpic — on-disk layout', () => {
  it('creates folder + artifacts + state.json + inputs.json + run state', () => {
    const root = tmpRoot();
    // Seed an artifact template the scaffold should copy.
    const tplDir = path.join(root, '.aidlc', 'aidlc-templates', PIPELINE.id);
    fs.mkdirSync(tplDir, { recursive: true });
    fs.writeFileSync(path.join(tplDir, 'PRD.md'), '# template');

    const result = scaffoldEpic({
      workspaceRoot: root,
      doc: { state: { root: 'docs/epics' } },
      epicId: 'CPD-1',
      title: 'My epic',
      description: 'do the thing',
      target: { kind: 'pipeline', id: PIPELINE.id },
      agents: ['po', 'developer'],
      inputs: { jira: 'CPD-1' },
      pipeline: PIPELINE,
    });

    const epicDir = path.join(root, 'docs/epics', 'CPD-1');
    expect(result.epicDir).toBe(epicDir);
    // artifact template copied in
    expect(fs.existsSync(path.join(epicDir, 'artifacts', 'PRD.md'))).toBe(true);
    // inputs.json captured
    expect(JSON.parse(fs.readFileSync(path.join(epicDir, 'inputs.json'), 'utf8'))).toEqual({ jira: 'CPD-1' });

    // run state machine started + persisted
    const run = RunStateStore.load(root, 'CPD-1');
    expect(run?.pipelineId).toBe(PIPELINE.id);
    expect(result.runState?.runId).toBe('CPD-1');

    // state.json mirrored from the run (root step open → in_progress)
    const state = JSON.parse(fs.readFileSync(path.join(epicDir, 'state.json'), 'utf8'));
    expect(state.id).toBe('CPD-1');
    expect(state.title).toBe('My epic');
    expect(state.pipeline).toBe(PIPELINE.id);
    expect(state.status).toBe('in_progress');
    expect(state.stepStates.map((s: { agent: string }) => s.agent)).toEqual(['po', 'developer']);
  });

  // The epic doc is the only file a phase-1 skill reads for the user's own
  // words — the AI-Native intent skill opens `docs/epics/$0/$0.md` by name.
  it('writes <epicId>.md carrying the title and description', () => {
    const root = tmpRoot();
    scaffoldEpic({
      workspaceRoot: root,
      doc: null,
      epicId: 'CPD-2',
      title: 'My epic',
      description: 'do the thing',
      target: { kind: 'pipeline', id: PIPELINE.id },
      agents: ['po', 'developer'],
      inputs: {},
      pipeline: PIPELINE,
    });

    const doc = fs.readFileSync(
      path.join(root, 'docs/epics', 'CPD-2', 'CPD-2.md'), 'utf8');
    expect(doc).toContain('# CPD-2');
    expect(doc).toContain('My epic');
    expect(doc).toContain('do the thing');
  });

  it('writes a heading-only epic doc when there is no description', () => {
    const root = tmpRoot();
    scaffoldEpic({
      workspaceRoot: root,
      doc: null,
      epicId: 'CPD-3',
      title: '',
      description: '',
      target: { kind: 'pipeline', id: PIPELINE.id },
      agents: ['po', 'developer'],
      inputs: {},
      pipeline: PIPELINE,
    });

    const doc = fs.readFileSync(
      path.join(root, 'docs/epics', 'CPD-3', 'CPD-3.md'), 'utf8');
    expect(doc).toBe('# CPD-3\n');
  });

  // A recipe-assembled pipeline is named after its epic, so its templates can
  // only be found through `derived_from`. Keying on the pipeline id alone left
  // artifacts/ empty for every epic started from a recipe.
  it('seeds artifact templates from derived_from, not the pipeline id', () => {
    const root = tmpRoot();
    const tplDir = path.join(root, '.aidlc', 'aidlc-templates', PIPELINE.id);
    fs.mkdirSync(tplDir, { recursive: true });
    fs.writeFileSync(path.join(tplDir, 'PRD.md'), '# template');

    const assembled: PipelineConfig = {
      ...PIPELINE,
      id: 'CPD-4',
      derived_from: PIPELINE.id,
    };
    scaffoldEpic({
      workspaceRoot: root,
      doc: null,
      epicId: 'CPD-4',
      title: '',
      description: '',
      target: { kind: 'pipeline', id: assembled.id },
      agents: ['po', 'developer'],
      inputs: {},
      pipeline: assembled,
    });

    expect(fs.existsSync(
      path.join(root, 'docs/epics', 'CPD-4', 'artifacts', 'PRD.md'))).toBe(true);
  });
  // GH-67-UT01: extraProjects written to inputs.json
  it('persists extraProjects in inputs.json when provided', () => {
    const root = tmpRoot();
    const extras = [
      { type: 'local' as const, ref: '/home/user/frontend', label: 'frontend', mode: 'workspace' },
      { type: 'github' as const, ref: 'acme/backend-api', label: 'backend-api', mode: 'reference' },
    ];
    scaffoldEpic({
      workspaceRoot: root,
      doc: null,
      epicId: 'GH-67-A',
      title: 'Multi-project',
      description: 'test',
      target: { kind: 'pipeline', id: PIPELINE.id },
      agents: ['po', 'developer'],
      inputs: { jira: 'GH-67' },
      extraProjects: extras,
      pipeline: PIPELINE,
    });
    const inputsPath = path.join(root, 'docs/epics', 'GH-67-A', 'inputs.json');
    const inputs = JSON.parse(fs.readFileSync(inputsPath, 'utf8'));
    expect(inputs.jira).toBe('GH-67');
    expect(inputs.extra_projects).toEqual(extras);
  });

  // GH-67-UT02: no extraProjects → no extra_projects key
  it('omits extra_projects from inputs.json when not provided', () => {
    const root = tmpRoot();
    scaffoldEpic({
      workspaceRoot: root,
      doc: null,
      epicId: 'GH-67-B',
      title: '',
      description: '',
      target: { kind: 'pipeline', id: PIPELINE.id },
      agents: ['po'],
      inputs: { jira: 'GH-67' },
      pipeline: PIPELINE,
    });
    const inputsPath = path.join(root, 'docs/epics', 'GH-67-B', 'inputs.json');
    const inputs = JSON.parse(fs.readFileSync(inputsPath, 'utf8'));
    expect(inputs.jira).toBe('GH-67');
    expect(inputs.extra_projects).toBeUndefined();
  });

  // GH-67-UT03: empty extraProjects array → no extra_projects key
  it('omits extra_projects from inputs.json when array is empty', () => {
    const root = tmpRoot();
    scaffoldEpic({
      workspaceRoot: root,
      doc: null,
      epicId: 'GH-67-C',
      title: '',
      description: '',
      target: { kind: 'pipeline', id: PIPELINE.id },
      agents: ['po'],
      inputs: {},
      extraProjects: [],
      pipeline: PIPELINE,
    });
    const inputsPath = path.join(root, 'docs/epics', 'GH-67-C', 'inputs.json');
    const inputs = JSON.parse(fs.readFileSync(inputsPath, 'utf8'));
    expect(inputs.extra_projects).toBeUndefined();
  });

  it('throws when the epic dir already exists', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'docs/epics', 'CPD-2'), { recursive: true });
    expect(() => scaffoldEpic({
      workspaceRoot: root,
      doc: null,
      epicId: 'CPD-2',
      title: '',
      description: '',
      target: { kind: 'pipeline', id: PIPELINE.id },
      agents: ['po'],
      inputs: {},
      pipeline: PIPELINE,
    })).toThrow(/already exists/);
  });
});
