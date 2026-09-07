/**
 * The bug these cover: a workspace could declare `/ai-native-full-intent` in
 * `slash_commands` with no file behind it, because the only writer for the
 * namespaced command set lived in the extension. Launching it printed
 * "Unknown command" and the step could not be started at all.
 *
 * So the assertions are about the *pairing* — a declared command name has a
 * file, a declared pipeline has templates — not about file contents.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_LANGUAGE_HEADING,
  BUILTIN_WORKFLOWS,
  builtinTemplatesRoot,
  loadBuiltinPreset,
  pipelineCommandId,
  provisionDeclaredWorkflows,
  provisionWorkflowFiles,
  relativeEpicRoot,
  writeWorkflowCommands,
} from '../src/index';

const NATIVE = BUILTIN_WORKFLOWS.find((w) => w.id === 'ai-native-pipeline')!;

let root: string;
let templatesRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-provision-'));
  templatesRoot = builtinTemplatesRoot();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const commandsDir = (): string => path.join(root, '.claude', 'commands');
const templatesDir = (pipelineId: string): string =>
  path.join(root, '.aidlc', 'aidlc-templates', pipelineId);

describe('workflow command provisioning', () => {
  it('writes a file for every slash command the workflow declares', () => {
    const preset = loadBuiltinPreset(templatesRoot, NATIVE);
    writeWorkflowCommands(root, NATIVE, preset);

    // This is the pairing that broke: the panel sends the namespaced name, so
    // a phase without its namespaced file is a step that cannot be started.
    for (const phase of NATIVE.phases) {
      const file = path.join(commandsDir(), `${pipelineCommandId(NATIVE.pipelineId, phase.id)}.md`);
      expect(fs.existsSync(file), file).toBe(true);
    }
  });

  it('writes the two-layer set alongside, so /intent works too', () => {
    writeWorkflowCommands(root, NATIVE, loadBuiltinPreset(templatesRoot, NATIVE));
    expect(fs.existsSync(path.join(commandsDir(), 'aidlc.md'))).toBe(true);
    expect(fs.existsSync(path.join(commandsDir(), 'intent.md'))).toBe(true);
  });

  it('leaves a hand-edited command file alone', () => {
    const preset = loadBuiltinPreset(templatesRoot, NATIVE);
    writeWorkflowCommands(root, NATIVE, preset);
    const file = path.join(commandsDir(), 'intent.md');
    // The section has to survive the edit for the file to read as current —
    // a body without it is taken for one an older build wrote.
    const mine = `mine\n\n${ARTIFACT_LANGUAGE_HEADING}\n`;
    fs.writeFileSync(file, mine, 'utf8');

    writeWorkflowCommands(root, NATIVE, preset);
    expect(fs.readFileSync(file, 'utf8')).toBe(mine);

    writeWorkflowCommands(root, NATIVE, preset, { overwrite: true });
    expect(fs.readFileSync(file, 'utf8')).not.toBe(mine);
  });

  it('refreshes a command body written before artifact_language existed', () => {
    // The setting is read by the *command body*, not by the runner, so a body
    // from an older build ignores it forever and the user sees a Vietnamese
    // intent followed by an English spec with nothing to point at.
    const preset = loadBuiltinPreset(templatesRoot, NATIVE);
    writeWorkflowCommands(root, NATIVE, preset);
    const file = path.join(commandsDir(), 'intent.md');
    fs.writeFileSync(file, 'stale body, no language section\n', 'utf8');

    writeWorkflowCommands(root, NATIVE, preset);
    expect(fs.readFileSync(file, 'utf8')).toContain(ARTIFACT_LANGUAGE_HEADING);
  });

  it('bakes the workspace epic root into the command body', () => {
    writeWorkflowCommands(root, NATIVE, loadBuiltinPreset(templatesRoot, NATIVE), {
      epicRoot: 'work/epics',
    });
    const body = fs.readFileSync(path.join(commandsDir(), 'intent.md'), 'utf8');
    expect(body).toContain('work/epics/<epic>/state.json');
  });

  it('tells the agent to resolve a skill path from workspace.yaml', () => {
    // The skills in a preset-applied workspace live at `~/.claude/skills/…`,
    // declared per-entry as `path:`. The dispatcher used to name
    // `.claude/skills/<skill>.md` as the only location.
    writeWorkflowCommands(root, NATIVE, loadBuiltinPreset(templatesRoot, NATIVE));
    const body = fs.readFileSync(path.join(commandsDir(), 'intent.md'), 'utf8');
    expect(body).toContain('workspace.yaml');
    expect(body).toContain('~/.claude/...');
  });
});

describe('workflow artifact templates', () => {
  it('seeds the template dir the epic scaffold reads from', () => {
    provisionWorkflowFiles(templatesRoot, root, NATIVE, loadBuiltinPreset(templatesRoot, NATIVE));
    const files = fs.readdirSync(templatesDir(NATIVE.pipelineId));
    expect(files.length).toBe(NATIVE.phases.length);
  });
});

describe('provisionDeclaredWorkflows', () => {
  it('provisions the built-in pipelines a workspace declares', () => {
    provisionDeclaredWorkflows(templatesRoot, root, [NATIVE.pipelineId]);
    expect(fs.existsSync(
      path.join(commandsDir(), `${pipelineCommandId(NATIVE.pipelineId, 'intent')}.md`),
    )).toBe(true);
    expect(fs.existsSync(templatesDir(NATIVE.pipelineId))).toBe(true);
  });

  it('skips an id that matches no built-in workflow', () => {
    // A recipe-assembled pipeline is named after its epic. There is no
    // `EPIC-001` template bundle and never will be — it must not throw.
    provisionDeclaredWorkflows(templatesRoot, root, ['EPIC-001']);
    expect(fs.existsSync(templatesDir('EPIC-001'))).toBe(false);
  });

  it('provisions each workflow once even when listed twice', () => {
    const result = provisionDeclaredWorkflows(
      templatesRoot, root, [NATIVE.pipelineId, NATIVE.pipelineId],
    );
    const seen = new Set(result.commands);
    expect(seen.size).toBe(result.commands.length);
  });

  it('reports nothing written on a second run', () => {
    provisionDeclaredWorkflows(templatesRoot, root, [NATIVE.pipelineId]);
    const again = provisionDeclaredWorkflows(templatesRoot, root, [NATIVE.pipelineId]);
    expect(again.commands).toEqual([]);
    expect(again.templates).toEqual([]);
  });
});

describe('relativeEpicRoot', () => {
  it('defaults to docs/epics', () => {
    expect(relativeEpicRoot(null)).toBe('docs/epics');
    expect(relativeEpicRoot({})).toBe('docs/epics');
    expect(relativeEpicRoot({ state: { root: '   ' } })).toBe('docs/epics');
  });

  it('honours state.root', () => {
    expect(relativeEpicRoot({ state: { root: 'work/epics' } })).toBe('work/epics');
  });
});
