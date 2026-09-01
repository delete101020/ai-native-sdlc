/**
 * Resolves the repository's *project instruction* file — the standing rules a
 * harness is expected to read before it touches the code.
 *
 * Background (gap G3 in MULTI_PROVIDER_ALIGNMENT.md): the skill bodies say
 * *"Read `CLAUDE.md`"*. Claude Code loads that file itself, so the sentence is
 * satisfied for free. No other CLI does: Codex reads `AGENTS.md`, Gemini CLI
 * reads `GEMINI.md`, and a phase pointed at `CLAUDE.md` on either would run
 * without the project's conventions.
 *
 * The fix is to *read* whichever file the repository already has and inline its
 * text into the prompt for harnesses that do not load one natively. AIDLC never
 * **writes** `AGENTS.md` or `GEMINI.md` into a user's repository (P0, D-locked):
 * creating a file the user did not ask for, in a repository we do not own, is
 * not part of changing provider.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Candidate filenames, in the order they are searched. `CLAUDE.md` leads
 * because it is the file this repository's own workflows are written against;
 * the vendor-specific names follow so a repo that already keeps one is honoured.
 * `.claude/CLAUDE.md` is included because Claude Code accepts it there too.
 */
export const PROJECT_INSTRUCTION_FILES: readonly string[] = [
  'CLAUDE.md',
  path.join('.claude', 'CLAUDE.md'),
  'AGENTS.md',
  'GEMINI.md',
];

export interface ProjectInstructions {
  /** Absolute path of the file that supplied the text. */
  filePath: string;
  /** Path relative to the workspace root — what the prompt cites. */
  relPath: string;
  /** File contents, trimmed. */
  content: string;
}

/**
 * Find the project instruction file under `workspaceRoot`.
 *
 * `prefer` moves one filename to the front of the search — pass the provider's
 * own convention (`AGENTS.md` for Codex, `GEMINI.md` for Gemini) so a repo that
 * maintains both files gives each harness the one written for it. When `prefer`
 * is absent or missing on disk, the standard order applies.
 *
 * Returns `null` when the repository has none — a repository with no written
 * conventions is normal, not an error.
 */
export function findProjectInstructions(
  workspaceRoot: string,
  prefer?: string,
): ProjectInstructions | null {
  const order = prefer
    ? [prefer, ...PROJECT_INSTRUCTION_FILES.filter((f) => f !== prefer)]
    : [...PROJECT_INSTRUCTION_FILES];

  for (const rel of order) {
    const filePath = path.join(workspaceRoot, rel);
    let content: string;
    try {
      if (!fs.statSync(filePath).isFile()) { continue; }
      content = fs.readFileSync(filePath, 'utf8').trim();
    } catch {
      continue;
    }
    if (!content) { continue; }
    return { filePath, relPath: rel, content };
  }

  return null;
}
