/**
 * Put the approval gate in place for a project, so an autopilot pipeline can
 * start without the person first reading ONBOARDING.md.
 *
 * Two halves, because they live in different places:
 *
 * - **The script**, `.claude/hooks/aidlc-approval-gate.py`, copied from the
 *   bundled `templates/hooks/`. It is meant to be committed, like the
 *   validators under `.aidlc/validators/`.
 * - **The registration**, a PreToolUse hook in `.claude/settings.local.json`.
 *   That file is per clone: the command names this machine's Python, which
 *   on Windows is `py -3` — `python3` there is usually the Microsoft Store
 *   stub, which exits without running anything, and a hook that does not run
 *   is one Claude Code treats as allowing.
 *
 * Idempotent: an existing script is never overwritten, and nothing is
 * registered when {@link findApprovalGate} already finds a gate in the
 * project's or the user's settings.
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { findApprovalGate } from './autopilotPreflight';

const GATE_FILE = 'aidlc-approval-gate.py';
const SETTINGS_FILE = path.join('.claude', 'settings.local.json');

export interface ApprovalGateInstall {
  /** Absolute path of the script, when this call wrote it. */
  script?: string;
  /** Absolute path of the settings file, when this call registered the hook. */
  registered?: string;
}

/**
 * Copy the gate script and register it, whichever of the two is missing.
 * `templatesRoot` is the folder holding `templates/` (the extension path, or
 * the CLI's dist).
 */
export function installApprovalGate(
  templatesRoot: string,
  root: string,
  opts: { userConfigDir?: string; python?: string } = {},
): ApprovalGateInstall {
  const result: ApprovalGateInstall = {};

  const script = path.join(root, '.claude', 'hooks', GATE_FILE);
  if (!fs.existsSync(script)) {
    const tpl = path.join(templatesRoot, 'templates', 'hooks', GATE_FILE);
    if (!fs.existsSync(tpl)) { return result; }
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(tpl, script);
    try { fs.chmodSync(script, 0o755); } catch { /* not supported on this fs */ }
    result.script = script;
  }

  if (findApprovalGate(root, { userConfigDir: opts.userConfigDir }).found) { return result; }

  const settingsFile = path.join(root, SETTINGS_FILE);
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      // Not ours to repair: a file Claude Code cannot parse either.
      return result;
    }
  }
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const preToolUse = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : (hooks.PreToolUse = [])) as unknown[];
  const python = opts.python ?? pythonCommand();
  preToolUse.push({
    matcher: 'Bash|Write|Edit',
    hooks: [{ type: 'command', command: `${python} "$CLAUDE_PROJECT_DIR/.claude/hooks/${GATE_FILE}"` }],
  });
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  ignoreLocally(root, SETTINGS_FILE.split(path.sep).join('/'));
  result.registered = settingsFile;
  return result;
}

/** The command that runs a Python 3 script on this machine. */
function pythonCommand(): string {
  const candidates = process.platform === 'win32' ? ['py -3', 'python', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    const [cmd, ...args] = c.split(' ');
    const probe = spawnSync(cmd, [...args, '--version'], { encoding: 'utf8' });
    if (probe.status === 0 && /^Python 3/.test(probe.stdout || probe.stderr || '')) { return c; }
  }
  return candidates[0];
}

/**
 * Keep the per-clone settings file out of commits. Uses `.git/info/exclude`
 * rather than `.gitignore`, which is the project's and would show up as a
 * change of its own.
 */
function ignoreLocally(root: string, rel: string): void {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  // check-ignore exits 1 (thrown, so null) when the path is not ignored.
  if (git(['check-ignore', '-q', rel]) !== null) { return; }
  const exclude = git(['rev-parse', '--git-path', 'info/exclude'])?.trim();
  if (!exclude) { return; }
  const file = path.resolve(root, exclude);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${rel}\n`);
}
