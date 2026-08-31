/**
 * AI-Native SDLC workflow — the third built-in pipeline, following all six
 * stages of the AI-Native SDLC Playbook.
 *
 * These tests guard the two things that are easy to get silently wrong when a
 * workflow is added: the flat `~/.claude/{agents,skills}` filename namespace
 * shared by every workflow, and the shared `CANONICAL_PHASES` shortcut layer
 * where one phase id carries one description across all pipelines. The last
 * block covers the stage-5 approval gate, which is a hook rather than prose.
 */
import { spawnSync } from 'child_process';
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
  it('registers the six new phases', () => {
    for (const id of ['intent', 'spec', 'build-plan', 'verify', 'review', 'maintain']) {
      expect(CANONICAL_PHASE_IDS).toContain(id);
    }
  });

  it('uses playbook artifact names', () => {
    expect(getCanonicalPhase('intent')!.artifact).toBe('intent.md');
    expect(getCanonicalPhase('spec')!.artifact).toBe('spec.md');
    expect(getCanonicalPhase('build-plan')!.artifact).toBe('plan.md');
    expect(getCanonicalPhase('verify')!.artifact).toBe('verify.md');
    expect(getCanonicalPhase('review')!.artifact).toBe('review.md');
    expect(getCanonicalPhase('maintain')!.artifact).toBe('incident.md');
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

  it('runs the seven playbook phases in a linear DAG', () => {
    expect(workflow.phases.map((p) => p.id)).toEqual([
      'intent', 'spec', 'build-plan', 'implement', 'verify', 'review', 'maintain',
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

  it('gates the review phase on verify, behind a human', () => {
    const review = workflow.phases.find((p) => p.id === 'review')!;
    expect(review.dependsOn).toEqual(['verify']);
    expect(review.artifact).toBe('review.md');
    expect(review.humanReview).toBe(true);
    // `github` here is a declarative permission, inert until a github MCP
    // server is configured — the phase reads the diff locally (Q2, locked).
    expect(review.capabilities).toContain('github');
  });

  it('puts review after verify in the full recipe', () => {
    const full = (workflow.recipes ?? []).find((r) => r.id === 'native-full')!;
    expect(full.steps.indexOf('review')).toBe(full.steps.length - 1);
    expect(full.steps.indexOf('review')).toBeGreaterThan(full.steps.indexOf('verify'));
  });

  it('runs maintain unattended — a signal does not wait for office hours', () => {
    const maintain = workflow.phases.find((p) => p.id === 'maintain')!;
    expect(maintain.artifact).toBe('incident.md');
    expect(maintain.persona).toBe('native-operator');
    // The only phase without a human gate. The gate moved to stage 1 of the
    // epic this phase opens, where the emitted intent.md is reviewed.
    expect(maintain.humanReview).toBe(false);
    expect(maintain.autoReview).toBe(false);
  });

  it('lets a signal enter stage 6 on its own, not only after review', () => {
    const incident = (workflow.recipes ?? []).find((r) => r.id === 'native-incident')!;
    expect(incident.steps).toEqual(['maintain']);
    // …while the feature flow still ends at review: an epic that shipped is done.
    const full = (workflow.recipes ?? []).find((r) => r.id === 'native-full')!;
    expect(full.steps).not.toContain('maintain');
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

describe('approval-gate hook', () => {
  /**
   * W2.4 — stage 5 puts the gate in the tooling, not in a checklist. The hook
   * is a PreToolUse command: exit 0 allows, exit 2 blocks with the reason on
   * stderr. Registration lives in `.claude/settings.json`, which is gitignored,
   * so this test exercises the script directly.
   */
  const HOOK = path.join(CORE_ROOT, '..', '..', '.claude', 'hooks', 'aidlc-approval-gate.py');

  const run = (payload: unknown): { code: number; stderr: string } => {
    const r = spawnSync('python3', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { code: r.status ?? -1, stderr: r.stderr ?? '' };
  };

  const bash = (command: string): unknown => ({ tool_name: 'Bash', tool_input: { command } });
  const edit = (file_path: string): unknown => ({ tool_name: 'Edit', tool_input: { file_path } });

  it('exists and is executable', () => {
    expect(fs.existsSync(HOOK)).toBe(true);
  });

  it('blocks a force-push to a protected branch', () => {
    const r = run(bash('git push --force origin main'));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/force-push/);
  });

  it('blocks staging a credential-looking file', () => {
    expect(run(bash('git add .env')).code).toBe(2);
    expect(run(bash('git add secrets/server.pem')).code).toBe(2);
  });

  it('blocks hand-editing pipeline-owned run state', () => {
    const r = run(edit('docs/epics/AID-0001/state.json'));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Mark step done/);
  });

  it('allows ordinary work', () => {
    expect(run(bash('git push origin feat/thing')).code).toBe(0);
    expect(run(bash('git push --follow-tags origin main')).code).toBe(0);
    expect(run(bash('git add src/index.ts')).code).toBe(0);
    expect(run(edit('docs/epics/AID-0001/artifacts/review.md')).code).toBe(0);
  });

  it('fails open on input it cannot parse', () => {
    const r = spawnSync('python3', [HOOK], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});
