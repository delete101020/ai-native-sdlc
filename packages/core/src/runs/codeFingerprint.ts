/**
 * Did a step change the code?
 *
 * When the autopilot loop sends work back to `implement` and the agent comes
 * back having changed nothing, the next verify/review will say what the last
 * one said, and so will every round after it. Comparing the reasons the
 * reviewers wrote cannot catch that — two LLM-written paragraphs about the
 * same fault are rarely the same string — but comparing the code can.
 *
 * The fingerprint is a git tree of the working tree as it stands, tracked and
 * untracked files alike (ignored ones excepted), written through a scratch
 * index so the real index, HEAD and checkout are never touched. Being a tree
 * of contents, it does not care whether the agent committed: a commit with
 * changes and the same changes left unstaged fingerprint the same, and a
 * commit of nothing new does not count as progress. The epic's own artifacts
 * and `.aidlc/` are left out — the agent rewriting its report is not a change
 * to the code.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Tree id of the working tree under `root`, minus `exclude` (paths relative
 * to `root`). Null when there is nothing to fingerprint with — not a git
 * checkout, or git missing — in which case the caller skips the check.
 */
export function codeFingerprint(root: string, exclude: readonly string[]): string | null {
  const git = (args: string[], env?: NodeJS.ProcessEnv): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();

  let realIndex: string;
  try {
    realIndex = path.resolve(root, git(['rev-parse', '--git-path', 'index']));
  } catch {
    return null;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-fp-'));
  const index = path.join(dir, 'index');
  try {
    // Seeded from the real index so git can trust its stat cache instead of
    // hashing every file in the repo again.
    if (fs.existsSync(realIndex)) { fs.copyFileSync(realIndex, index); }
    const env = { GIT_INDEX_FILE: index };
    git(['add', '-A', '--', '.'], env);
    const skip = exclude.filter((p) => p && !p.startsWith('..'));
    if (skip.length > 0) {
      git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...skip], env);
    }
    return git(['write-tree'], env);
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
