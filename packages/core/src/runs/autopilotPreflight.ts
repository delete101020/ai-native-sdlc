/**
 * Is it safe to leave this run alone?
 *
 * A pipeline marked `autopilot: true` is one nobody is expected to watch: the
 * loop sends work back to `implement` on its own and runs it again. Before it
 * starts, three things have to hold, and the loop refuses to start otherwise
 * rather than warn into a terminal nobody is reading:
 *
 * 1. **A branch of its own.** Not `main` / `master` / the remote's default,
 *    and not a detached HEAD, where the agent's commits belong to no branch.
 * 2. **A clean working tree** — leaving out the epic's own folder and
 *    `.aidlc/`. Work left uncommitted would be built on, reviewed and
 *    committed as if the agent had written it, and a run that stops halfway
 *    would leave it mixed in with the agent's. Two exceptions: exactly the
 *    tree a step of this run left when it stopped short (its recorded
 *    `leftover` — say the account ran out of usage and the run is picked up
 *    on another), and `--allow-dirty`, where the person says it is theirs to
 *    vouch for.
 * 3. **The approval gate**, for steps Claude runs: the
 *    `.claude/hooks/aidlc-approval-gate.py` PreToolUse hook, registered and
 *    present. It is what stops a force-push to main or a staged `.env` when
 *    no one is there to say no. It lives in `.claude/settings*.json`, which
 *    is not committed, so a fresh clone does not have it.
 * 4. **CI that checks something.** A CI validator whose `CHECKS` list is
 *    empty (the shipped `ci.mjs` until someone fills it in) passes whatever
 *    `implement` builds — harmless while a person reads each step, and no
 *    gate at all when nobody does.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { claudeConfigDir } from '../util/claudeHome';
import { codeFingerprint, uncommittedPaths } from './codeFingerprint';
import { epicsRoot } from './EpicScaffold';
import type { RunState, StepRecord } from './RunState';
import { normalizeStep } from '../schema/WorkspaceSchema';
import type { PipelineConfig, WorkspaceConfig } from '../schema/WorkspaceSchema';

/** What the hook command has to mention to count as the approval gate. */
export const APPROVAL_GATE_SCRIPT = 'aidlc-approval-gate';

/** Environment variable the loop sets for an autopilot run's agents (and so their hooks). */
export const AUTOPILOT_ENV = 'AIDLC_AUTOPILOT';

const PROTECTED_BRANCHES = ['main', 'master'];

export type ApprovalGate =
  | { found: true; settingsFile: string; script: string }
  | { found: false; reason: string };

interface HookEntry { type?: string; command?: string }
interface HookGroup { matcher?: string; hooks?: HookEntry[] }

/**
 * Find the approval-gate hook where Claude Code would load it for `root`:
 * the project's `.claude/settings.json` and `.claude/settings.local.json`,
 * then the user's own settings. It counts only if it runs before `Bash`
 * (the matcher covers it) and its script exists — a hook command whose file
 * is gone fails, and Claude Code carries on as though it allowed.
 */
export function findApprovalGate(root: string, opts: { userConfigDir?: string } = {}): ApprovalGate {
  const files = [
    path.join(root, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.local.json'),
    path.join(opts.userConfigDir ?? claudeConfigDir(), 'settings.json'),
  ];
  let brokenReason: string | null = null;
  for (const file of files) {
    let settings: { hooks?: { PreToolUse?: unknown } } | null = null;
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const groups = settings?.hooks?.PreToolUse;
    if (!Array.isArray(groups)) { continue; }
    for (const g of groups as HookGroup[]) {
      if (!Array.isArray(g?.hooks) || !matcherCoversBash(g.matcher)) { continue; }
      for (const h of g.hooks) {
        if (typeof h?.command !== 'string' || !h.command.includes(APPROVAL_GATE_SCRIPT)) { continue; }
        const script = hookScriptPath(h.command, root);
        if (!script) { continue; }
        if (!fs.existsSync(script)) {
          brokenReason = `${rel(root, file)} runs ${script}, which does not exist.`;
          continue;
        }
        if (runsScriptDirectly(h.command) && process.platform !== 'win32' && !isExecutable(script)) {
          brokenReason = `${rel(root, script)} is registered in ${rel(root, file)} but is not executable (chmod +x it).`;
          continue;
        }
        return { found: true, settingsFile: file, script };
      }
    }
  }
  return {
    found: false,
    reason: brokenReason
      ?? 'no PreToolUse hook running .claude/hooks/aidlc-approval-gate.py on Bash in .claude/settings.json, ' +
        '.claude/settings.local.json or your user settings — see ONBOARDING.md, "Turn on the approval gate".',
  };
}

/**
 * Why `aidlc run exec` should not start this autopilot run — empty when it
 * may. Only steps not yet approved count toward needing the gate: a finished
 * Claude step will not run again in this loop.
 */
export function autopilotPreflight(args: {
  root: string;
  state: RunState;
  pipeline: PipelineConfig;
  config: WorkspaceConfig;
  /** Start on top of uncommitted changes nobody can vouch for (`--allow-dirty`). */
  allowDirty?: boolean;
  /** Told when the tree is dirty and the run starts anyway, and why. */
  onNote?: (message: string) => void;
  /**
   * Told the uncommitted paths when they are why the run may not start, so a
   * front end can offer to start anyway instead of only printing the refusal.
   */
  onDirty?: (paths: string[]) => void;
  /** Overrides the user's Claude config dir, for tests. */
  userConfigDir?: string;
}): string[] {
  const { root, state, config } = args;
  const problems: string[] = [];

  const git = (gitArgs: string[]): string | null => {
    try {
      return execFileSync('git', gitArgs, {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };

  if (git(['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') {
    problems.push('This is not a git checkout. Autopilot works on a branch of its own, so it needs git.');
  } else {
    const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'])?.trim();
    const remoteDefault = git(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])?.trim().replace(/^origin\//, '');
    const protectedBranches = new Set([...PROTECTED_BRANCHES, ...(remoteDefault ? [remoteDefault] : [])]);
    if (!branch) {
      problems.push('HEAD is detached. Check out a branch for this epic (git switch -c <branch>) so the agent\'s commits land on it.');
    } else if (protectedBranches.has(branch)) {
      problems.push(`You are on "${branch}". Autopilot does not commit to it — switch to a branch for this epic (git switch -c <branch>).`);
    }

    const exclude = [
      toPosix(path.relative(root, path.join(epicsRoot(root, config), state.runId))),
      '.aidlc',
    ];
    const dirty = uncommittedPaths(root, exclude);
    if (dirty.length > 0) {
      const shown = listPaths(dirty);
      const left = state.steps.filter((s) => s.leftover);
      const tree = left.length > 0 ? codeFingerprint(root, exclude) : null;
      const own = tree ? left.find((s) => s.leftover!.tree === tree) : undefined;
      if (own) {
        args.onNote?.(
          `Carrying on from what "${own.name ?? own.agent}" left uncommitted when it ${leftoverWhy(own)} ` +
          `(${shown}). Nothing else has changed since.`,
        );
      } else if (args.allowDirty) {
        args.onNote?.(`--allow-dirty: starting on top of uncommitted changes (${shown}).`);
      } else {
        args.onDirty?.(dirty);
        const changed = left.length > 0
          ? ` They are not what "${left.map((s) => s.name ?? s.agent).join('", "')}" left when it stopped — ` +
            'something has changed since.'
          : '';
        problems.push(
          `The working tree has uncommitted changes (${shown}). Commit or stash them first: the agent would build ` +
          `on them, and its own changes would be mixed in with them.${changed} If they are this run's own ` +
          'unfinished work, run again with --allow-dirty.',
        );
      }
    }
  }

  const claudeSteps = new Set(
    state.steps
      .filter((s) => s.status !== 'approved' && s.status !== 'skipped')
      .map((s) => config.agents.find((a) => a.id === s.agent))
      .filter((a) => a?.runner === 'default')
      .map((a) => a!.id),
  );
  if (claudeSteps.size > 0) {
    const gate = findApprovalGate(root, { userConfigDir: args.userConfigDir });
    if (!gate.found) {
      problems.push(`The approval gate is not on: ${gate.reason}`);
    }
  }

  args.pipeline.steps.forEach((s, i) => {
    if (state.steps[i]?.status === 'approved') { return; }
    const norm = normalizeStep(s);
    if (!norm.enabled) { return; }
    const runner = norm.auto_review ? norm.auto_review_runner : undefined;
    if (runner && hasEmptyCiChecks(root, runner)) {
      problems.push(emptyCiChecksMessage(runner, norm.name ?? norm.agent));
    }
  });

  return problems;
}

// `const CHECKS = []` once comments are gone, so commented-out examples do not count.
const EMPTY_CHECKS = /\bCHECKS\s*=\s*\[\s*\]/;

/**
 * True when the auto-review runner at `runner` (relative to `root`) is a CI
 * validator in the shape of the shipped `ci.mjs` — a `CHECKS` array of
 * commands — with nothing in the array. A runner that is missing, or does
 * not declare `CHECKS` at all (`verdict.mjs`, a project's own), is not.
 */
export function hasEmptyCiChecks(root: string, runner: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path.isAbsolute(runner) ? runner : path.join(root, runner), 'utf8');
  } catch {
    return false;
  }
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return EMPTY_CHECKS.test(code);
}

/** What {@link autopilotPreflight} and `aidlc doctor` say about an empty `CHECKS`. */
export function emptyCiChecksMessage(runner: string, step: string): string {
  return `${runner} has no commands in CHECKS, so it passes whatever "${step}" builds. Add your lint, ` +
    'typecheck and test commands to it before leaving a run alone.';
}

function listPaths(paths: string[]): string {
  return paths.slice(0, 5).join(', ') + (paths.length > 5 ? `, and ${paths.length - 5} more` : '');
}

function leftoverWhy(step: StepRecord): string {
  switch (step.leftover!.why) {
    case 'timeout': return 'ran past its timeout_minutes';
    case 'stopped': return 'was stopped';
    default: return 'failed';
  }
}

/** Claude Code matches `matcher` against the tool name; absent, empty or `*` matches every tool. */
function matcherCoversBash(matcher: string | undefined): boolean {
  if (!matcher || matcher === '*') { return true; }
  try {
    return new RegExp(`^(?:${matcher})$`).test('Bash');
  } catch {
    return matcher.split('|').map((m) => m.trim()).includes('Bash');
  }
}

/** The script a hook command runs, resolved against the project. */
function hookScriptPath(command: string, root: string): string | null {
  const expanded = command
    .replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, root)
    .replace(/["']/g, '');
  const token = expanded.split(/\s+/).find((t) => t.includes(APPROVAL_GATE_SCRIPT));
  if (!token) { return null; }
  const p = token.startsWith('~/') ? path.join(os.homedir(), token.slice(2)) : token;
  // resolve() also normalises separators: on Windows `$CLAUDE_PROJECT_DIR/gate/x.py`
  // expands to a mixed `C:\repo/gate/x.py`.
  return path.resolve(root, p);
}

/** True when the command is the script itself, not `python3 <script>`. */
function runsScriptDirectly(command: string): boolean {
  const first = command.replace(/["']/g, '').trim().split(/\s+/)[0] ?? '';
  return first.includes(APPROVAL_GATE_SCRIPT);
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function rel(root: string, p: string): string {
  const r = path.relative(root, p);
  return r.startsWith('..') ? p : toPosix(r);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
