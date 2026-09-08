/**
 * `.aidlc/user.yaml` — the settings that belong to one checkout, not to the
 * repository.
 *
 * `.aidlc/workspace.yaml` is committed: it is the team's description of the
 * agents, skills and pipelines everyone shares, and sharing it is the point.
 * A few settings are the opposite. `epic_id_prefix` names *the person at this
 * keyboard*, so putting it in the shared file means the second developer to
 * pull inherits the first one's initials — see {@link resolveEpicIdPrefixChain}
 * for why that is worse than the problem the prefix was added to solve.
 *
 * The split already existed for VS Code's side of the configuration; the
 * `.gitignore` this feature writes even says so in the line above the one it
 * adds. This module gives the same split a home the CLI can read too, because
 * `aidlc epic next-id` and the Start Epic modal must agree on the id or the
 * two front doors hand out different ones.
 *
 * The file is optional at every level: no file, no key, or an unreadable file
 * all mean "nothing set here", never an error. It holds preferences, and a
 * preference that can break a command is not worth having.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/** Where the file lives, relative to the workspace root. */
export const USER_CONFIG_RELPATH = path.join('.aidlc', 'user.yaml');

/** The `.gitignore` entry that keeps it out of commits. */
export const USER_CONFIG_IGNORE_LINE = '.aidlc/user.yaml';

/** Absolute path to this workspace's user config. */
export function userConfigPath(root: string): string {
  return path.join(root, USER_CONFIG_RELPATH);
}

/**
 * The parsed file, or `null` when there is nothing usable to read.
 *
 * Malformed YAML degrades to `null` rather than throwing: this file is
 * hand-editable and unversioned, so a stray tab in it must not be able to stop
 * someone from starting an epic.
 */
export function readUserConfig(root: string): Record<string, unknown> | null {
  const file = userConfigPath(root);
  try {
    if (!fs.existsSync(file)) { return null; }
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The header re-written on every save, since `js-yaml` does not keep comments. */
const HEADER = [
  '# Settings for this checkout only — NOT committed (see .gitignore).',
  '# epic_id_prefix is your own two letters, so the epics you open are filed',
  '# under you and never collide with a colleague\'s numbering.',
  '',
].join('\n');

/**
 * Set or clear `epic_id_prefix`, leaving any other key in the file alone.
 *
 * @param prefix Two letters, or `null` to go back to the unprefixed scheme.
 */
export function writeUserEpicIdPrefix(root: string, prefix: string | null): void {
  const doc = readUserConfig(root) ?? {};
  if (prefix) { doc.epic_id_prefix = prefix.toUpperCase(); }
  else { delete doc.epic_id_prefix; }

  const file = userConfigPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // An empty document would leave a file saying nothing; deleting it says the
  // same thing and leaves no puzzle behind for the next person to open .aidlc/.
  if (Object.keys(doc).length === 0) {
    if (fs.existsSync(file)) { fs.rmSync(file); }
    return;
  }
  fs.writeFileSync(file, HEADER + yaml.dump(doc), 'utf8');
}

/**
 * `git config user.name` for this checkout, or `null`.
 *
 * Used only to *suggest* a prefix. Every failure mode — no git on PATH, not a
 * repository, no identity configured — is the same answer: no suggestion, and
 * the user types their own two letters.
 */
export function readGitUserName(root: string): string | null {
  try {
    const out = execFileSync('git', ['config', 'user.name'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Make sure `.gitignore` excludes the user config; returns true if it changed.
 *
 * Called when the file is first written rather than at `init`, so workspaces
 * that already exist are covered too — the whole point is that this file must
 * never reach a commit, and the workspaces that need the fix most are the ones
 * scaffolded before it existed.
 */
export function ensureUserConfigIgnored(root: string): boolean {
  const file = path.join(root, '.gitignore');
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const listed = existing
      .split(/\r?\n/)
      .some((line) => line.trim() === USER_CONFIG_IGNORE_LINE);
    if (listed) { return false; }
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(
      file,
      `${existing}${sep}\n# Per-checkout AIDLC settings (epic_id_prefix) — never shared\n${USER_CONFIG_IGNORE_LINE}\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}
