// Path helpers shared by every layer that resolves a workspace.yaml path.
//
// Built-in presets write skill paths as `~/.claude/skills/<file>.md` so that
// workspace.yaml stays portable across machines while still pointing at the
// globally installed defaults. `path.resolve` does NOT understand `~` — it
// treats it as an ordinary directory name and yields `<root>/~/.claude/...`,
// a path that never exists. Every caller that resolves a declared path must
// expand the home prefix first, so the check they perform matches the path
// the loader will actually read.

import * as os from 'os';
import * as path from 'path';

import { remapClaudePath } from './claudeHome';

/**
 * Expand a leading `~/` to the user's home directory. Anything else — a
 * relative path, an absolute path, a bare `~` with no separator — is returned
 * unchanged.
 *
 * `~/.claude/...` is special-cased onto the *active Claude config dir*, which
 * is `<home>/.claude` unless the user separates accounts with
 * `CLAUDE_CONFIG_DIR` / `aidlc.claude.configDir`. Declared paths stay portable
 * in the YAML and still land in the account actually in use.
 */
export function expandHome(p: string, homeDir: string = os.homedir()): string {
  if (!p.startsWith('~/')) { return p; }
  return remapClaudePath(p, { homeDir }) ?? path.join(homeDir, p.slice(2));
}

/**
 * Resolve a path declared in workspace.yaml against the workspace root,
 * expanding `~/` first. This is the one function that turns a declared path
 * into a path on disk; use it instead of a bare `path.resolve(root, declared)`.
 */
export function resolveDeclaredPath(
  root: string,
  declared: string,
  homeDir: string = os.homedir(),
): string {
  return path.resolve(root, expandHome(declared, homeDir));
}
