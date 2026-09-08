/**
 * Model defaults must not silently age out.
 *
 * This repo has already shipped the failure these tests guard: the v3.1.0
 * changelog announced a bump of the model defaults, but only the extension's
 * wizard picker was updated. `builtinWorkflows`, every agent template and
 * `aidlc agent add` kept their own pinned ids and drifted apart — three
 * sources of truth, three different values, for several releases.
 *
 * The fix is aliases (`opus` / `sonnet` / `haiku`), which Claude Code resolves
 * to the current generation, sourced from one module. These tests fail if a
 * pinned id creeps back in.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { BUILTIN_WORKFLOWS } from '../src/presets/builtinWorkflows';
import { PLANNING_MODEL, CODING_MODEL, FAST_MODEL } from '../src/presets/models';

const TEMPLATES_ROOT = path.join(__dirname, '..', 'templates');
const ALIASES = [PLANNING_MODEL, CODING_MODEL, FAST_MODEL];

/** Every `<templates>/<workflow>/agents/*.md`. */
function agentTemplates(): string[] {
  const out: string[] = [];
  for (const workflow of fs.readdirSync(TEMPLATES_ROOT)) {
    const agentsDir = path.join(TEMPLATES_ROOT, workflow, 'agents');
    if (!fs.existsSync(agentsDir)) { continue; }
    for (const f of fs.readdirSync(agentsDir)) {
      if (f.endsWith('.md')) { out.push(path.join(agentsDir, f)); }
    }
  }
  return out;
}

function frontmatterModel(file: string): string | undefined {
  return /^model:\s*(\S+)\s*$/m.exec(fs.readFileSync(file, 'utf8'))?.[1];
}

describe('model defaults', () => {
  it('exposes aliases, not pinned ids', () => {
    for (const alias of ALIASES) {
      expect(alias).not.toMatch(/^claude-/);
    }
  });

  it('every built-in phase asks for one of the shared aliases', () => {
    const phases = BUILTIN_WORKFLOWS.flatMap((w) => w.phases);
    expect(phases.length).toBeGreaterThan(0);
    for (const phase of phases) {
      if (phase.model === undefined) { continue; }
      expect(ALIASES, `phase ${phase.id} uses ${phase.model}`).toContain(phase.model);
    }
  });

  it('every agent template asks for one of the shared aliases', () => {
    const files = agentTemplates();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const model = frontmatterModel(file);
      if (model === undefined) { continue; }
      // The frontmatter is copied verbatim into ~/.claude/agents/, where
      // Claude Code honours it — a stale id here reaches the runtime.
      expect(ALIASES, `${path.basename(file)} uses ${model}`).toContain(model);
    }
  });
});
