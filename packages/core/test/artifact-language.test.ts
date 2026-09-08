/**
 * `artifact_language` decides what language a phase writes its artifact in.
 *
 * The bug it closes is drift, not translation: with nothing declared, a
 * Vietnamese epic brief could yield a Vietnamese intent and then an English
 * spec, because each phase inferred the language on its own. Phase N+1 reads
 * phase N, so a language that changes mid-pipeline is a correctness problem.
 *
 * Two things are load-bearing here and get their own assertions:
 *  - unset must leave the prompt byte-identical to what it was before;
 *  - the rule must fence off the document skeleton, because `IncidentLoop`
 *    generates literal English headings and auto-review rules match them.
 */
import { describe, expect, it } from 'vitest';

import {
  artifactLanguageSection,
  backboneCommandDoc,
  builtinClaudeCommand,
  BUILTIN_WORKFLOWS,
  CANONICAL_PHASES,
  composeAgentPrompt,
  resolveArtifactLanguage,
  shortcutCommandDoc,
  validateWorkspace,
} from '../src/index';
import { NO_HARNESS_CAPABILITIES } from '../src/runner/types';

const SKILLS = '# Intent Skill\n\n1. Interview the originator.\n';
const persona = {
  id: 'a', filePath: '/x/a.md', scope: 'global' as const,
  content: '# Originator Agent\n\nYou hold the problem.',
};

describe('resolveArtifactLanguage', () => {
  it('reads the declared value, trimmed', () => {
    expect(resolveArtifactLanguage({ artifact_language: '  Vietnamese ' })).toBe('Vietnamese');
  });

  it('is null when unset, blank, or not a string', () => {
    expect(resolveArtifactLanguage(null)).toBeNull();
    expect(resolveArtifactLanguage({})).toBeNull();
    expect(resolveArtifactLanguage({ artifact_language: '   ' })).toBeNull();
    expect(resolveArtifactLanguage({ artifact_language: 42 as unknown as string })).toBeNull();
  });
});

describe('workspace schema', () => {
  const base = { version: '1', name: 'w' };

  it('accepts a declared artifact language', () => {
    const cfg = validateWorkspace({ ...base, artifact_language: 'vi' }, 'w.yaml');
    expect(cfg.artifact_language).toBe('vi');
  });

  it('leaves it undefined when the workspace says nothing', () => {
    expect(validateWorkspace(base, 'w.yaml').artifact_language).toBeUndefined();
  });

  it('rejects an empty string rather than composing a prompt about ""', () => {
    expect(() => validateWorkspace({ ...base, artifact_language: '' }, 'w.yaml')).toThrow();
  });
});

describe('the rule text', () => {
  it('names the language when one is resolved', () => {
    const s = artifactLanguageSection('Vietnamese');
    expect(s).toContain('**Vietnamese**');
    expect(s).toContain('artifact_language: Vietnamese');
  });

  it('defers to workspace.yaml when none is resolved', () => {
    const s = artifactLanguageSection(null);
    expect(s).toContain('`artifact_language`');
    expect(s).toContain('.aidlc/workspace.yaml');
    // A command file is written once and read for months; it must not claim a
    // language that the workspace has since changed.
    expect(s).not.toContain('**Vietnamese**');
  });

  it('fences off the document skeleton in both forms', () => {
    for (const s of [artifactLanguageSection('vi'), artifactLanguageSection(null)]) {
      // The exact string IncidentLoop writes and auto-review rules match.
      expect(s).toContain('## 1. Problem');
      expect(s).toContain('in English');
      expect(s).toContain('**Epic ID:**');
    }
  });
});

describe('composeAgentPrompt', () => {
  it('adds nothing when the workspace declares no language', () => {
    const out = composeAgentPrompt({
      skills: SKILLS, persona: null, instructions: null,
      harness: NO_HARNESS_CAPABILITIES,
    });
    expect(out.text).toBe(SKILLS);
    expect(out.included.language).toBe(false);
  });

  it('treats a blank declaration as no declaration', () => {
    const out = composeAgentPrompt({
      skills: SKILLS, persona: null, instructions: null,
      harness: NO_HARNESS_CAPABILITIES, artifactLanguage: '   ',
    });
    expect(out.text).toBe(SKILLS);
    expect(out.included.language).toBe(false);
  });

  it('inlines the resolved language, so no tool round-trip is needed', () => {
    const out = composeAgentPrompt({
      skills: SKILLS, persona: null, instructions: null,
      harness: NO_HARNESS_CAPABILITIES, artifactLanguage: 'Vietnamese',
    });
    expect(out.included.language).toBe(true);
    expect(out.text).toContain('## Output language');
    expect(out.text).toContain('**Vietnamese**');
    // Inlined, not delegated: the composer had the config in hand.
    expect(out.text).not.toContain('If it is absent, ignore this section');
  });

  it('keeps the skill layer alongside it', () => {
    const out = composeAgentPrompt({
      skills: SKILLS, persona, instructions: null,
      harness: NO_HARNESS_CAPABILITIES, artifactLanguage: 'vi',
    });
    expect(out.text).toContain('## Persona');
    expect(out.text).toContain('## Output language');
    expect(out.text).toContain('## Phase Behavior');
    expect(out.text).toContain('1. Interview the originator.');
  });
});

describe('slash-command bodies', () => {
  // Every path that starts a phase has to carry the rule; a phase entered from
  // the panel and the same phase run headless must not disagree.
  it('the backbone dispatcher carries it', () => {
    expect(backboneCommandDoc()).toContain('## Output language');
  });

  it('every phase shortcut carries it', () => {
    for (const phase of CANONICAL_PHASES) {
      expect(shortcutCommandDoc(phase), phase.id).toContain('## Output language');
    }
  });

  it('every namespaced built-in command carries it', () => {
    const workflow = BUILTIN_WORKFLOWS.find((w) => w.id === 'ai-native-pipeline')!;
    for (const phase of workflow.phases) {
      const body = builtinClaudeCommand(phase, '# skill\n', 'docs/epics');
      expect(body, phase.id).toContain('## Output language');
    }
  });
});
