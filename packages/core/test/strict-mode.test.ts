/**
 * `strict_mode` — the per-epic depth setting.
 *
 * The behaviour worth pinning is the asymmetry: strict is the prompt as it has
 * always been (nothing added, byte-identical), non-strict is the only case that
 * changes anything, and anything unreadable falls back to strict.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  STRICT_MODE_HEADING,
  commandBodyPredatesStrictMode,
  composeAgentPrompt,
  epicStrictMode,
  resolveEpicStrictMode,
  strictModeSection,
} from '../src/index';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-strict-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeEpic(id: string, state: Record<string, unknown>): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

describe('epicStrictMode', () => {
  it('treats an absent setting as strict', () => {
    expect(epicStrictMode({})).toBe(true);
    expect(epicStrictMode(null)).toBe(true);
    expect(epicStrictMode(undefined)).toBe(true);
  });

  it('relaxes only on a literal false', () => {
    expect(epicStrictMode({ strict_mode: false })).toBe(false);
    expect(epicStrictMode({ strict_mode: true })).toBe(true);
    // A hand-edited string is a value we do not understand, and the safe
    // reading of one is the depth the epic had before anyone edited it.
    expect(epicStrictMode({ strict_mode: 'no' as unknown as boolean })).toBe(true);
    expect(epicStrictMode({ strict_mode: 0 as unknown as boolean })).toBe(true);
  });
});

describe('resolveEpicStrictMode', () => {
  it('reads the setting off the epic on disk', () => {
    writeEpic('EPIC-001', { id: 'EPIC-001', strict_mode: false });
    expect(resolveEpicStrictMode(root, 'EPIC-001')).toBe(false);
  });

  it('falls back to strict for an epic it cannot read', () => {
    writeEpic('EPIC-002', { id: 'EPIC-002', strict_mode: true });
    fs.writeFileSync(path.join(root, 'EPIC-002', 'state.json'), '{ not json', 'utf8');
    expect(resolveEpicStrictMode(root, 'EPIC-002')).toBe(true);
    expect(resolveEpicStrictMode(root, 'EPIC-404')).toBe(true);
    expect(resolveEpicStrictMode(root, '')).toBe(true);
  });
});

describe('strictModeSection', () => {
  it('says nothing at all for a strict epic', () => {
    expect(strictModeSection(true)).toBeNull();
  });

  it('states the rule outright when the caller resolved it', () => {
    const s = strictModeSection(false)!;
    expect(s).toContain(STRICT_MODE_HEADING);
    expect(s).toContain('strict_mode: false');
    // The one thing a shortened artifact must not do is drop a heading the
    // auto-reviewer and the traceability validator assert on.
    expect(s).toContain('Keep every heading the template has');
  });

  it('defers to state.json when the caller could not resolve it', () => {
    const s = strictModeSection(null)!;
    expect(s).toContain(STRICT_MODE_HEADING);
    expect(s).toContain('state.json');
    expect(s).toContain('ignore this section');
  });
});

describe('commandBodyPredatesStrictMode', () => {
  it('is exactly "the body has no depth section"', () => {
    expect(commandBodyPredatesStrictMode('old body\n')).toBe(true);
    expect(commandBodyPredatesStrictMode(`x\n\n${STRICT_MODE_HEADING}\n`)).toBe(false);
  });
});

describe('composeAgentPrompt with a depth setting', () => {
  const base = {
    skills: 'SKILL BODY',
    persona: null,
    instructions: null,
    harness: { persona: true, projectInstructions: true, skills: false },
  };

  it('adds nothing for a strict epic — the prompt is what it always was', () => {
    const out = composeAgentPrompt({ ...base, strictMode: true });
    expect(out.text).toBe('SKILL BODY');
    expect(out.included.depth).toBe(false);
  });

  it('is identical when the caller says nothing about depth', () => {
    expect(composeAgentPrompt(base).text).toBe('SKILL BODY');
  });

  it('inlines the rule for an epic that opted out of full depth', () => {
    const out = composeAgentPrompt({ ...base, strictMode: false });
    expect(out.included.depth).toBe(true);
    expect(out.text).toContain(STRICT_MODE_HEADING);
    // Depth constrains how the phase writes; the phase itself still follows.
    expect(out.text).toContain('## Phase Behavior');
    expect(out.text.indexOf(STRICT_MODE_HEADING)).toBeLessThan(out.text.indexOf('## Phase Behavior'));
  });
});
