/**
 * AI-Native SDLC workflow — the third built-in pipeline, following stages 1-4
 * of the AI-Native SDLC Playbook.
 *
 * These tests guard the two things that are easy to get silently wrong when a
 * workflow is added: the flat `~/.claude/{agents,skills}` filename namespace
 * shared by every workflow, and the shared `CANONICAL_PHASES` shortcut layer
 * where one phase id carries one description across all pipelines.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import {
  BUILTIN_WORKFLOWS,
  getBuiltinWorkflow,
  loadBuiltinPreset,
  getBuiltinArtifactTemplates,
} from '../src/presets/builtinWorkflows';
import { CANONICAL_PHASES, CANONICAL_PHASE_IDS, getCanonicalPhase } from '../src/presets/commandModel';

const CORE_ROOT = path.join(__dirname, '..');

describe('AI-Native SDLC — canonical phases', () => {
  it('registers the four new phases', () => {
    for (const id of ['intent', 'spec', 'build-plan', 'verify']) {
      expect(CANONICAL_PHASE_IDS).toContain(id);
    }
  });

  it('uses playbook artifact names', () => {
    expect(getCanonicalPhase('intent')!.artifact).toBe('intent.md');
    expect(getCanonicalPhase('spec')!.artifact).toBe('spec.md');
    expect(getCanonicalPhase('build-plan')!.artifact).toBe('plan.md');
    expect(getCanonicalPhase('verify')!.artifact).toBe('verify.md');
  });

  it('does not collide with the AIDLC `plan` phase', () => {
    // `plan` keeps its AIDLC meaning (scaffold the epic + write the PRD); the
    // playbook's implementation plan is a separate id so the shared shortcut
    // description stays correct for both pipelines.
    expect(getCanonicalPhase('plan')!.artifact).toBe('PRD.md');
    expect(getCanonicalPhase('build-plan')!.artifact).toBe('plan.md');
  });

  it('every phase id is unique', () => {
    expect(new Set(CANONICAL_PHASE_IDS).size).toBe(CANONICAL_PHASE_IDS.length);
  });
});

describe('AI-Native SDLC — workflow registration', () => {
  const workflow = getBuiltinWorkflow('ai-native-pipeline')!;

  it('is registered alongside the existing workflows, not in place of them', () => {
    expect(workflow).toBeDefined();
    const ids = BUILTIN_WORKFLOWS.map((w) => w.id);
    expect(ids).toContain('aidlc-workflow');
    expect(ids).toContain('speckit-pipeline');
    expect(ids).toContain('ai-native-pipeline');
  });

  it('runs the five stage 1-4 phases in a linear DAG', () => {
    expect(workflow.phases.map((p) => p.id)).toEqual([
      'intent', 'spec', 'build-plan', 'implement', 'verify',
    ]);
    const declared = new Set(workflow.phases.map((p) => p.id));
    for (const phase of workflow.phases) {
      for (const dep of phase.dependsOn ?? []) {
        expect(declared.has(dep)).toBe(true);
      }
    }
    expect(workflow.phases[0].dependsOn ?? []).toEqual([]);
  });

  it('every phase artifact matches its canonical phase', () => {
    for (const phase of workflow.phases) {
      const canonical = getCanonicalPhase(phase.id);
      expect(canonical, `phase \`${phase.id}\` is not canonical`).toBeDefined();
    }
    expect(workflow.phases.find((p) => p.id === 'build-plan')!.artifact).toBe('plan.md');
  });

  it('every recipe step is a declared phase', () => {
    const declared = new Set(workflow.phases.map((p) => p.id));
    for (const recipe of workflow.recipes ?? []) {
      for (const step of recipe.steps) {
        expect(declared.has(step), `recipe ${recipe.id} references unknown step ${step}`).toBe(true);
      }
    }
  });
});

describe('AI-Native SDLC — template files', () => {
  const workflow = getBuiltinWorkflow('ai-native-pipeline')!;
  const dir = path.join(CORE_ROOT, 'templates', workflow.templatesDir);

  it('ships every persona and skill file the phases reference', () => {
    for (const phase of workflow.phases) {
      expect(fs.existsSync(path.join(dir, 'agents', `${phase.persona}.md`)),
        `missing agents/${phase.persona}.md`).toBe(true);
      for (const file of phase.skillFiles) {
        expect(fs.existsSync(path.join(dir, 'skills', `${file}.md`)),
          `missing skills/${file}.md`).toBe(true);
      }
    }
  });

  it('ships an artifact template for every phase', () => {
    const templates = getBuiltinArtifactTemplates(CORE_ROOT, workflow);
    for (const phase of workflow.phases) {
      expect(templates[phase.artifact]).toBeDefined();
      expect(templates[phase.artifact]).not.toContain('template missing');
    }
  });

  it('composes a self-contained skill body per phase', () => {
    const preset = loadBuiltinPreset(CORE_ROOT, workflow);
    for (const phase of workflow.phases) {
      const body = preset.skillContents[phase.id];
      expect(body, `no composed skill for ${phase.id}`).toBeDefined();
      expect(body).not.toContain('persona file missing');
      expect(body).not.toContain('skill file missing');
    }
  });
});

describe('flat ~/.claude namespace', () => {
  /**
   * globalDefaultsInstaller writes every workflow's `agents/<f>.md` and
   * `skills/<f>.md` to `~/.claude/{agents,skills}/aidlc-<f>.md` — a single
   * namespace shared by all workflows. Two workflows shipping the same
   * filename silently overwrite each other on install.
   */
  for (const kind of ['agents', 'skills'] as const) {
    it(`no two workflows ship the same ${kind} filename`, () => {
      const owners = new Map<string, string>();
      const clashes: string[] = [];
      for (const workflow of BUILTIN_WORKFLOWS) {
        const dir = path.join(CORE_ROOT, 'templates', workflow.templatesDir, kind);
        if (!fs.existsSync(dir)) { continue; }
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.md')) { continue; }
          const prev = owners.get(file);
          if (prev && prev !== workflow.templatesDir) {
            clashes.push(`${kind}/${file}: ${prev} vs ${workflow.templatesDir}`);
          }
          owners.set(file, workflow.templatesDir);
        }
      }
      expect(clashes).toEqual([]);
    });
  }
});
