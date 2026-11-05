import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  commandBodyPredatesEpicRoot,
  epicRootSection,
  expandEpicRoot,
  localizeEpicRoot,
  resolveArtifactPath,
} from '../src/loader/epicRootText';
import { markStepDone, startRun } from '../src/runs/PipelineRunner';
import { composeAgentPrompt } from '../src/loader/promptComposer';
import { backboneCommandDoc, shortcutCommandDoc, CANONICAL_PHASES, writeTwoLayerCommands } from '../src/presets/commandModel';
import { BUILTIN_WORKFLOWS, builtinClaudeCommand, loadBuiltinPreset } from '../src/presets/builtinWorkflows';
import { refreshWorkspaceCommands } from '../src/presets/workflowProvisioning';

const harness = { persona: true, projectInstructions: true, instructionFile: 'CLAUDE.md' };
const templatesRoot = path.resolve(__dirname, '..');

describe('localizeEpicRoot', () => {
  it('rewrites the default root as a path prefix', () => {
    expect(localizeEpicRoot('Read `docs/epics/$0/PRD.md`', 'work/items')).toBe('Read `work/items/$0/PRD.md`');
  });

  it('leaves the text alone on the default root, however it is spelled', () => {
    for (const root of ['docs/epics', 'docs/epics/', './docs/epics', null, undefined, ' ']) {
      expect(localizeEpicRoot('`docs/epics/x`', root)).toBe('`docs/epics/x`');
    }
  });

  it('does not touch a longer path that merely contains the default root', () => {
    const text = 'see other/docs/epics/x and mydocs/epics/y';
    expect(localizeEpicRoot(text, 'work')).toBe(text);
  });

  it('does not read `$` in the root as a replacement pattern', () => {
    expect(localizeEpicRoot('docs/epics/x', 'a$&b')).toBe('a$&b/x');
  });
});

describe('commandBodyPredatesEpicRoot', () => {
  const phase = CANONICAL_PHASES[0];

  it('accepts a body generated for the same root', () => {
    expect(commandBodyPredatesEpicRoot(backboneCommandDoc('work'), 'work')).toBe(false);
    expect(commandBodyPredatesEpicRoot(shortcutCommandDoc(phase, 'work'), 'work')).toBe(false);
    expect(commandBodyPredatesEpicRoot(backboneCommandDoc('docs/epics'), 'docs/epics')).toBe(false);
  });

  it('flags a body generated for another root, in either direction', () => {
    expect(commandBodyPredatesEpicRoot(backboneCommandDoc('docs/epics'), 'work')).toBe(true);
    expect(commandBodyPredatesEpicRoot(backboneCommandDoc('work'), 'docs/epics')).toBe(true);
  });

  it('flags a body with the right root but written before the note existed', () => {
    const old = backboneCommandDoc('work').replace(`${epicRootSection('work')}\n\n`, '');
    expect(commandBodyPredatesEpicRoot(old, 'work')).toBe(true);
  });

  it('leaves a hand-written command alone', () => {
    expect(commandBodyPredatesEpicRoot('# my own command\n', 'work')).toBe(false);
  });
});

describe('composed slash commands', () => {
  const workflow = BUILTIN_WORKFLOWS.find((w) => w.id === 'aidlc-workflow') ?? BUILTIN_WORKFLOWS[0];
  const preset = loadBuiltinPreset(templatesRoot, workflow);
  const phase = workflow.phases[0];

  it('carry the project root in the persona and skill they inline', () => {
    const body = builtinClaudeCommand(phase, preset.skillContents[phase.id], 'work/items');
    expect(body).toContain('`work/items/');
    expect(body.replace(epicRootSection('work/items') ?? '', '')).not.toContain('docs/epics');
  });

  it('are unchanged on the default root', () => {
    const body = builtinClaudeCommand(phase, '`docs/epics/$0/x.md`', 'docs/epics');
    expect(body).toContain('`docs/epics/$0/x.md`');
    expect(body).not.toContain('## Epic folder');
  });
});

describe('composeAgentPrompt', () => {
  const persona = { content: 'Read `docs/epics/a`', path: 'p', source: 'project' } as never;
  const instructions = { relPath: 'CLAUDE.md', content: 'Ours: `docs/epics/keep`' } as never;

  it('hands the skills through untouched on the default root', () => {
    const out = composeAgentPrompt({ skills: '`docs/epics/x`', persona: null, instructions: null, harness, epicRoot: 'docs/epics', strictMode: true });
    expect(out.text).toBe('`docs/epics/x`');
  });

  it('rewrites persona and skill, and explains the persona a harness loads itself', () => {
    const out = composeAgentPrompt({
      skills: '`docs/epics/x`',
      persona,
      instructions: null,
      harness: { ...harness, persona: false },
      epicRoot: 'work',
      strictMode: true,
    });
    expect(out.text).toContain('`work/x`');
    expect(out.text).toContain('`work/a`');
    expect(out.text).toContain('## Epic folder');
  });

  it("leaves the project's own instructions as they were written", () => {
    const out = composeAgentPrompt({
      skills: 'S',
      persona: null,
      instructions,
      harness: { ...harness, projectInstructions: false },
      epicRoot: 'work',
      strictMode: true,
    });
    expect(out.text).toContain('Ours: `docs/epics/keep`');
  });
});

describe('moving state.root', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-root-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const read = (id: string) => fs.readFileSync(path.join(root, '.claude/commands', `${id}.md`), 'utf8');

  it('rewrites generated commands, there and back, and keeps hand-written ones', () => {
    const workflow = BUILTIN_WORKFLOWS.find((w) => w.id === 'aidlc-workflow') ?? BUILTIN_WORKFLOWS[0];
    const pipelines = [{ id: workflow.pipelineId }];
    const namespaced = `${workflow.pipelineId}-${workflow.phases[0].id}`;

    refreshWorkspaceCommands(templatesRoot, root, { pipelines });
    expect(read('aidlc')).not.toContain('## Epic folder');
    fs.writeFileSync(path.join(root, '.claude/commands/mine.md'), '# mine\n');

    refreshWorkspaceCommands(templatesRoot, root, { state: { root: 'work' }, pipelines });
    expect(read('aidlc')).toContain('`work/<epic>/state.json`');
    expect(read('aidlc')).toContain('## Epic folder');
    expect(read(namespaced)).toContain('`work/$ARGUMENTS/state.json`');
    expect(read('mine')).toBe('# mine\n');

    refreshWorkspaceCommands(templatesRoot, root, { pipelines });
    expect(read('aidlc')).toContain('`docs/epics/<epic>/state.json`');
    expect(read('aidlc')).not.toContain('## Epic folder');
  });

  it('does not rewrite a command that is already current', () => {
    writeTwoLayerCommands(root, { epicRoot: 'work' });
    expect(writeTwoLayerCommands(root, { epicRoot: 'work' }).written).toEqual([]);
  });
});

describe('artifact paths', () => {
  it('fills {epic_root} and {epic}', () => {
    expect(resolveArtifactPath('{epic_root}/{epic}/artifacts/PRD.md', { epic: 'E-1' }, 'work/items/'))
      .toBe('work/items/E-1/artifacts/PRD.md');
  });

  it('moves the spelling older pipelines installed', () => {
    expect(expandEpicRoot('docs/epics/{epic}/artifacts/PRD.md', 'work')).toBe('work/{epic}/artifacts/PRD.md');
  });

  it('leaves every other path as written', () => {
    for (const p of ['docs/cr/{epic}/x.md', 'docs/epics/shared.md', 'vendor/docs/epics/{epic}/x.md']) {
      expect(expandEpicRoot(p, 'work')).toBe(p);
    }
  });

  it('built-in pipelines declare artifacts through {epic_root}', () => {
    const workflow = BUILTIN_WORKFLOWS.find((w) => w.id === 'aidlc-workflow') ?? BUILTIN_WORKFLOWS[0];
    const text = JSON.stringify(loadBuiltinPreset(templatesRoot, workflow).workspace ?? loadBuiltinPreset(templatesRoot, workflow));
    expect(text).toContain('{epic_root}/{epic}/artifacts/');
    expect(text).not.toContain('docs/epics/{epic}/artifacts/');
  });
});

describe('the gate on a moved state.root', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-root-gate-'));
    fs.mkdirSync(path.join(root, '.aidlc'));
    fs.writeFileSync(path.join(root, '.aidlc/workspace.yaml'), 'state:\n  root: work/items\n');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  for (const declared of ['{epic_root}/{epic}/artifacts/PRD.md', 'docs/epics/{epic}/artifacts/PRD.md']) {
    it(`finds the artifact declared as ${declared}`, () => {
      const pipeline = {
        id: 'p', on_failure: 'stop',
        steps: [{ agent: 'a', produces: [declared], human_review: true }],
      } as never;
      const state = startRun({ pipeline, runId: 'E-1', context: { epic: 'E-1' } });
      expect(() => markStepDone({ state, pipeline, workspaceRoot: root })).toThrow(/not produced/);

      fs.mkdirSync(path.join(root, 'work/items/E-1/artifacts'), { recursive: true });
      fs.writeFileSync(path.join(root, 'work/items/E-1/artifacts/PRD.md'), '# PRD\n');
      const next = markStepDone({ state, pipeline, workspaceRoot: root });
      expect(next.steps[0].artifactsProduced).toEqual(['work/items/E-1/artifacts/PRD.md']);
    });
  }
});
