/**
 * Where Claude Code keeps its per-account state.
 *
 * By default that is `~/.claude` (agents, skills, tools, settings.json,
 * projects) plus `~/.claude.json` as a *sibling* holding the OAuth account.
 * Setting `CLAUDE_CONFIG_DIR` moves the whole thing: the directory becomes the
 * `.claude` equivalent AND `.claude.json` moves *inside* it — verified against
 * the CLI, not assumed.
 *
 * That distinction is why this module exists. A user with several Claude
 * accounts (personal / work) separates them by config dir, and every path AIDLC
 * touches under `~/.claude` has to follow, or `globals install` writes skills
 * one account can see and the running session cannot. Paths under the
 * *workspace* `.claude/` are project data and must NOT follow — they belong to
 * the repo, not the account.
 *
 * The active dir is resolved from, in order:
 *   1. an explicit `configDir` argument,
 *   2. the process-wide override set by `setClaudeConfigDir` (the extension
 *      installs the `aidlc.claude.configDir` setting there at activation),
 *   3. `$CLAUDE_CONFIG_DIR` (what the CLI itself reads — a user who already
 *      exports it per shell gets the right answer with no configuration),
 *   4. `<home>/.claude`.
 */
import * as os from 'os';
import * as path from 'path';

export interface ClaudeHomeOptions {
  /** Explicit config dir; wins over the override and the environment. */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** Process-wide override, installed from a setting. `undefined` = not configured. */
let configured: string | undefined;

function expandTilde(p: string, homeDir: string): string {
  return p.startsWith('~/') ? path.join(homeDir, p.slice(2)) : p;
}

/**
 * Install (or clear) the process-wide config-dir override. The extension calls
 * this at activation and again whenever the setting changes; the CLI does not
 * call it at all, so `$CLAUDE_CONFIG_DIR` from the user's shell decides there.
 */
export function setClaudeConfigDir(dir: string | undefined): void {
  const trimmed = dir?.trim();
  configured = trimmed ? path.resolve(expandTilde(trimmed, os.homedir())) : undefined;
}

/** The current override, for diagnostics. */
export function getClaudeConfigDirOverride(): string | undefined {
  return configured;
}

/** `<home>/.claude` — the layout when nothing is configured. */
export function defaultClaudeConfigDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude');
}

/** Resolve the active config dir. See the module comment for precedence. */
export function resolveClaudeConfigDir(opts: ClaudeHomeOptions = {}): string {
  const homeDir = opts.homeDir ?? os.homedir();
  const env = opts.env ?? process.env;
  const raw = opts.configDir?.trim() || configured || env.CLAUDE_CONFIG_DIR?.trim();
  return raw ? path.resolve(expandTilde(raw, homeDir)) : defaultClaudeConfigDir(homeDir);
}

/** Shorthand for the ambient config dir — the common call. */
export function claudeConfigDir(opts: ClaudeHomeOptions = {}): string {
  return resolveClaudeConfigDir(opts);
}

/** True when the active dir is the plain `<home>/.claude`. */
export function isDefaultClaudeConfigDir(opts: ClaudeHomeOptions = {}): boolean {
  const homeDir = opts.homeDir ?? os.homedir();
  return resolveClaudeConfigDir(opts) === defaultClaudeConfigDir(homeDir);
}

/**
 * Path to `.claude.json` (the file carrying `oauthAccount`). It is a sibling of
 * the default `~/.claude`, but lives *inside* a custom `CLAUDE_CONFIG_DIR`.
 */
export function claudeJsonPath(opts: ClaudeHomeOptions = {}): string {
  const homeDir = opts.homeDir ?? os.homedir();
  const dir = resolveClaudeConfigDir(opts);
  return dir === defaultClaudeConfigDir(homeDir)
    ? path.join(homeDir, '.claude.json')
    : path.join(dir, '.claude.json');
}

/**
 * Environment additions that point a spawned `claude` (or a terminal) at the
 * active config dir. Empty when the dir is the default, so nothing is injected
 * into the environment of a user who has not configured anything.
 */
export function claudeConfigEnv(opts: ClaudeHomeOptions = {}): Record<string, string> {
  return isDefaultClaudeConfigDir(opts)
    ? {}
    : { CLAUDE_CONFIG_DIR: resolveClaudeConfigDir(opts) };
}

/**
 * Remap a declared `~/.claude` / `~/.claude/<rest>` path onto the active config
 * dir. Returns `null` for anything else, so callers can fall back to a plain
 * home expansion. workspace.yaml keeps writing `~/.claude/skills/<f>.md` — the
 * portable form — and this is what makes that form resolve per account.
 */
export function remapClaudePath(p: string, opts: ClaudeHomeOptions = {}): string | null {
  if (p !== '~/.claude' && !p.startsWith('~/.claude/')) { return null; }
  const dir = resolveClaudeConfigDir(opts);
  const rest = p.slice('~/.claude'.length).replace(/^\//, '');
  return rest ? path.join(dir, rest) : dir;
}
