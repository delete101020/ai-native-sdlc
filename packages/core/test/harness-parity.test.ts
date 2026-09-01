/**
 * Harness parity (MULTI_PROVIDER_ALIGNMENT.md §4c, workstream P1a).
 *
 * The property under test is not "the prompt looks nice" — it is that the
 * *information* reaching the model is the same regardless of which harness runs
 * the step, while the *text* differs by exactly what that harness already
 * supplies. A Claude run must not receive `CLAUDE.md` twice; a runner that
 * declares nothing must receive everything.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { PersonaLoader, stripPersonaMetadata } from '../src/loader/PersonaLoader';
import { findProjectInstructions } from '../src/loader/projectInstructions';
import { composeAgentPrompt, stripPersonaDirectives } from '../src/loader/promptComposer';
import { DefaultRunner } from '../src/runner/DefaultRunner';
import { harnessCapabilities, NO_HARNESS_CAPABILITIES, type AidlcRunner, type HarnessCapabilities } from '../src/runner/types';

const PERSONA_FILE = [
  '<!-- AIDLC extension built-in — workflow: ainative, kind: agent, id: native-originator -->',
  '---',
  'name: Originator',
  'description: The person with the idea.',
  'model: opus',
  '---',
  '',
  '# Originator Agent',
  '',
  'You hold one thing sacred: the problem.',
  '',
].join('\n');

const SKILL_TEXT = [
  '# Intent for Epic $0',
  '',
  'You are the **Originator** agent.',
  'Load your full persona from `.claude/agents/aidlc-native-originator.md` before starting.',
  '',
  '## Steps',
  '',
  '1. Interview the originator.',
].join('\n');

let root: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-parity-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-home-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function writeAgent(dir: string, id: string, body = PERSONA_FILE): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), body);
}

// ── PersonaLoader ────────────────────────────────────────────────────────────

describe('PersonaLoader', () => {
  it('resolves a persona from the global scope and strips frontmatter + marker', () => {
    writeAgent(path.join(home, '.claude', 'agents'), 'aidlc-native-originator');

    const loaded = new PersonaLoader(root, home).load('aidlc-native-originator');

    expect(loaded).not.toBeNull();
    expect(loaded!.scope).toBe('global');
    expect(loaded!.content.startsWith('# Originator Agent')).toBe(true);
    expect(loaded!.content).not.toContain('AIDLC extension built-in');
    expect(loaded!.content).not.toContain('model: opus');
  });

  it('prefers the project scope over .aidlc and global', () => {
    writeAgent(path.join(home, '.claude', 'agents'), 'a', '# Global\n');
    writeAgent(path.join(root, '.aidlc', 'agents'), 'a', '# Aidlc\n');
    writeAgent(path.join(root, '.claude', 'agents'), 'a', '# Project\n');

    const loaded = new PersonaLoader(root, home).load('a');

    expect(loaded!.scope).toBe('project');
    expect(loaded!.content).toBe('# Project');
  });

  it('returns null for an agent with no persona file — not an error', () => {
    expect(new PersonaLoader(root, home).load('nobody')).toBeNull();
  });

  it('ignores a persona file that is nothing but frontmatter', () => {
    writeAgent(path.join(root, '.claude', 'agents'), 'empty', '---\nname: X\n---\n');
    expect(new PersonaLoader(root, home).load('empty')).toBeNull();
  });

  it('caches per id until cleared', () => {
    const dir = path.join(root, '.claude', 'agents');
    writeAgent(dir, 'a', '# One\n');
    const loader = new PersonaLoader(root, home);
    expect(loader.load('a')!.content).toBe('# One');

    fs.writeFileSync(path.join(dir, 'a.md'), '# Two\n');
    expect(loader.load('a')!.content).toBe('# One');

    loader.clear('a');
    expect(loader.load('a')!.content).toBe('# Two');
  });
});

describe('stripPersonaMetadata', () => {
  it('leaves a body with no frontmatter untouched', () => {
    expect(stripPersonaMetadata('# Plain\n\nbody\n')).toBe('# Plain\n\nbody');
  });

  it('does not eat a horizontal rule further down the file', () => {
    const out = stripPersonaMetadata('---\nname: X\n---\n\n# Title\n\n---\n\nmore\n');
    expect(out).toBe('# Title\n\n---\n\nmore');
  });
});

// ── Project instructions ─────────────────────────────────────────────────────

describe('findProjectInstructions', () => {
  it('finds CLAUDE.md at the repository root', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Conventions\n');
    expect(findProjectInstructions(root)!.relPath).toBe('CLAUDE.md');
  });

  it('honours a provider preference when that file exists', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n');

    expect(findProjectInstructions(root, 'AGENTS.md')!.content).toBe('# Agents');
    expect(findProjectInstructions(root)!.content).toBe('# Claude');
  });

  it('falls back to the standard order when the preferred file is absent', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
    expect(findProjectInstructions(root, 'GEMINI.md')!.relPath).toBe('CLAUDE.md');
  });

  it('skips an empty file rather than inlining nothing', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '   \n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n');
    expect(findProjectInstructions(root)!.relPath).toBe('AGENTS.md');
  });

  it('returns null for a repository with no instruction file', () => {
    expect(findProjectInstructions(root)).toBeNull();
  });
});

// ── Prompt composition ───────────────────────────────────────────────────────

const persona = { id: 'a', filePath: '/x/a.md', scope: 'global' as const, content: '# Originator Agent\n\nYou hold the problem.' };
const instructions = { filePath: '/x/CLAUDE.md', relPath: 'CLAUDE.md', content: '# Conventions\n\nUse pnpm.' };

describe('composeAgentPrompt', () => {
  it('inlines the persona but not CLAUDE.md for a Claude harness', () => {
    const out = composeAgentPrompt({
      skills: SKILL_TEXT, persona, instructions,
      harness: new DefaultRunner().capabilities,
    });

    expect(out.included).toEqual({ persona: true, instructions: false });
    expect(out.text).toContain('## Persona');
    expect(out.text).toContain('You hold the problem.');
    expect(out.text).not.toContain('Use pnpm.');
  });

  it('inlines every layer for a harness that declares nothing', () => {
    const out = composeAgentPrompt({
      skills: SKILL_TEXT, persona, instructions,
      harness: NO_HARNESS_CAPABILITIES,
    });

    expect(out.included).toEqual({ persona: true, instructions: true });
    expect(out.text).toContain('You hold the problem.');
    expect(out.text).toContain('Use pnpm.');
    expect(out.text).toContain('`CLAUDE.md`');
  });

  it('drops the "load your persona from <path>" directive once the persona is inlined', () => {
    const out = composeAgentPrompt({
      skills: SKILL_TEXT, persona, instructions: null,
      harness: NO_HARNESS_CAPABILITIES,
    });

    expect(out.text).not.toContain('.claude/agents/');
    expect(out.text).toContain('1. Interview the originator.');
  });

  it('keeps the directive when the harness loads the persona itself', () => {
    const harness: HarnessCapabilities = { persona: true, projectInstructions: false, astGraph: false };
    const out = composeAgentPrompt({ skills: SKILL_TEXT, persona, instructions, harness });

    expect(out.included.persona).toBe(false);
    expect(out.text).toContain('.claude/agents/aidlc-native-originator.md');
  });

  it('passes the skills through byte-for-byte when there is nothing to add', () => {
    const out = composeAgentPrompt({
      skills: SKILL_TEXT, persona: null, instructions: null,
      harness: NO_HARNESS_CAPABILITIES,
    });

    expect(out.text).toBe(SKILL_TEXT);
    expect(out.included).toEqual({ persona: false, instructions: false });
  });

  it('carries the same persona text to every harness that has to be told', () => {
    const codexish: HarnessCapabilities = { persona: false, projectInstructions: false, astGraph: false };
    const claude = composeAgentPrompt({ skills: SKILL_TEXT, persona, instructions, harness: new DefaultRunner().capabilities });
    const codex = composeAgentPrompt({ skills: SKILL_TEXT, persona, instructions, harness: codexish });

    // Same persona, same phase behaviour; the only difference is the layer
    // Claude Code supplies on its own.
    expect(codex.text).toContain(persona.content);
    expect(claude.text).toContain(persona.content);
    expect(codex.text.replace(/## Project instructions[\s\S]*?\n---\n\n/, '')).toBe(claude.text);
  });
});

describe('stripPersonaDirectives', () => {
  it('removes only the directive line', () => {
    const out = stripPersonaDirectives(SKILL_TEXT);
    expect(out).toContain('You are the **Originator** agent.');
    expect(out).not.toContain('Load your full persona');
  });
});

// ── Runner capability defaults ───────────────────────────────────────────────

describe('harnessCapabilities', () => {
  it('treats a runner that declares nothing as supplying nothing', () => {
    const bare: AidlcRunner = { run: async () => ({ success: true, output: '' }) };
    expect(harnessCapabilities(bare)).toEqual(NO_HARNESS_CAPABILITIES);
  });

  it('reports Claude Code as loading CLAUDE.md but not the persona', () => {
    const caps = harnessCapabilities(new DefaultRunner());
    expect(caps.projectInstructions).toBe(true);
    expect(caps.astGraph).toBe(true);
    expect(caps.persona).toBe(false);
  });
});
