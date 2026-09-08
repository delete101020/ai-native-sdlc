/**
 * Loads an agent's *persona* markdown — the "who you are" half of the prompt
 * that used to reach the model only by filesystem path.
 *
 * Background (gap G2 in MULTI_PROVIDER_ALIGNMENT.md): `execEngine` composed the
 * system prompt from the agent's *skills* alone. The persona was delivered by a
 * line inside each skill body — *"Load your full persona from
 * `.claude/agents/aidlc-native-originator.md`"* — which only works for a harness
 * that (a) has a file-read tool and (b) looks in Claude's directory layout. Any
 * other CLI runs the phase with no persona at all, and even Claude pays a tool
 * round-trip for something we already know.
 *
 * Personas resolve exactly like the assets in `AssetDiscovery` — project, then
 * `.aidlc`, then global — and by the *agent id*, because `loadBuiltinPreset`
 * names every agent `aidlc-<persona>` after the persona file it installs.
 *
 * Loaded personas are cached per loader instance; call `clear()` to invalidate.
 */

import * as fs from 'fs';
import * as os from 'os';

import { scopePaths, targetPath, type AssetScope } from './AssetDiscovery';

/** Scope order — first match wins. Mirrors AssetDiscovery's precedence. */
const SCOPE_PRECEDENCE: AssetScope[] = ['project', 'aidlc', 'global'];

export interface LoadedPersona {
  /** Agent id the persona was resolved for. */
  id: string;
  /** Absolute path of the file that supplied it. */
  filePath: string;
  /** Scope the file came from. */
  scope: AssetScope;
  /** Persona body, frontmatter and install marker stripped. */
  content: string;
}

/**
 * Strip the YAML frontmatter block and the `<!-- AIDLC extension built-in … -->`
 * install marker. Both are machine metadata: the frontmatter is how Claude Code
 * picks a subagent's model and tools, and neither says anything to a model that
 * is being handed the text as a system prompt.
 */
export function stripPersonaMetadata(raw: string): string {
  let body = raw.replace(/^﻿/, '');
  body = body.replace(/^\s*<!--\s*AIDLC extension built-in[^>]*-->\s*\r?\n/, '');
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
  body = body.replace(fm, '');
  return body.trim();
}

export class PersonaLoader {
  private cache = new Map<string, LoadedPersona | null>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly homeDir: string = os.homedir(),
  ) {}

  /**
   * Resolve + read the persona for an agent id. Returns `null` when no scope
   * holds a matching file — an agent may legitimately have no persona (a custom
   * agent, or a workflow whose opinion layer is `none`), so this is not an error.
   */
  load(agentId: string): LoadedPersona | null {
    const cached = this.cache.get(agentId);
    if (cached !== undefined) {
      return cached;
    }

    let found: LoadedPersona | null = null;
    for (const scope of SCOPE_PRECEDENCE) {
      const filePath = targetPath(this.workspaceRoot, scope, 'agent', agentId, this.homeDir);
      if (!fs.existsSync(filePath)) { continue; }
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      const content = stripPersonaMetadata(raw);
      if (!content) { continue; }
      found = { id: agentId, filePath, scope, content };
      break;
    }

    this.cache.set(agentId, found);
    return found;
  }

  /** The directories this loader searches, in precedence order. */
  searchPaths(): string[] {
    return SCOPE_PRECEDENCE.map((s) => scopePaths(this.workspaceRoot, s, this.homeDir).agents);
  }

  /** Drop cached persona content. Call after a persona `.md` changes on disk. */
  clear(agentId?: string): void {
    if (agentId) {
      this.cache.delete(agentId);
    } else {
      this.cache.clear();
    }
  }
}
