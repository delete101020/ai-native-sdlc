/**
 * Switching between Claude Code accounts without editing JSON.
 *
 * Claude Code has exactly one active account per process — it reads a single
 * `CLAUDE_CONFIG_DIR`. So there is no "enable three at once": what a user with
 * several accounts actually needs is (a) a saved list to pick from and (b) a
 * visible indicator of which one this window is talking to, so a run never
 * lands in the wrong account by accident.
 *
 * Three pieces, all thin:
 *   - `aidlc.claude.configDirs` — the address book (labels + paths). Purely a
 *     convenience list; it never changes what is active.
 *   - `aidlc.claude.configDir`  — the one that *is* active for this window.
 *     `scope: resource`, so different windows can hold different accounts at
 *     the same time; that is how three accounts run in parallel.
 *   - `AIDLC: Switch Claude Account` + a status bar item that opens it.
 *
 * Everything AIDLC writes under the global Claude folder resolves through
 * `claudeConfigDir()` in core, so switching here moves agents/skills, the
 * annotation tools, the epic-memory hook, MCP registration, the token monitor
 * and every `claude` terminal together. Long-lived readers captured the old
 * path, hence the reload prompt.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as vscode from 'vscode';

import {
  claudeConfigDir,
  claudeJsonPath,
  defaultClaudeConfigDir,
  isDefaultClaudeConfigDir,
  setClaudeConfigDir,
} from '@aidlc/core';

export const CONFIG_DIR_KEY = 'aidlc.claude.configDir';
export const CONFIG_DIRS_KEY = 'aidlc.claude.configDirs';
export const SWITCH_ACCOUNT_CMD = 'aidlc.switchClaudeAccount';

/** One entry of the user's saved account list. */
interface SavedAccount {
  label?: string;
  path: string;
}

/** A saved account resolved to an absolute path, ready to show. */
interface Account {
  label: string;
  /** As the user wrote it — what gets written back to the setting. */
  declared: string;
  /** Absolute, `~` expanded — used for comparison and for probing on disk. */
  resolved: string;
}

function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function resolvePath(p: string): string {
  return path.resolve(expandTilde(p.trim()));
}

function setting<T>(key: string): T | undefined {
  return vscode.workspace.getConfiguration().get<T>(key);
}

/** The active dir as the *setting* holds it (may be empty = inherit/default). */
function declaredActive(): string {
  return (setting<string>(CONFIG_DIR_KEY) ?? '').trim();
}

/**
 * The saved list, normalised: blanks dropped, duplicates collapsed on resolved
 * path, and the plain `~/.claude` always present so "go back to the default"
 * is one pick away even when the user never listed it.
 */
function savedAccounts(): Account[] {
  const raw = setting<SavedAccount[]>(CONFIG_DIRS_KEY) ?? [];
  const out: Account[] = [];
  const seen = new Set<string>();

  const add = (declared: string, label?: string): void => {
    const trimmed = declared.trim();
    if (!trimmed) { return; }
    const resolved = resolvePath(trimmed);
    if (seen.has(resolved)) { return; }
    seen.add(resolved);
    out.push({ label: label?.trim() || path.basename(resolved), declared: trimmed, resolved });
  };

  for (const entry of Array.isArray(raw) ? raw : []) {
    if (entry && typeof entry.path === 'string') { add(entry.path, entry.label); }
  }
  // The default account, and whatever is active right now, are always offered.
  add('~/.claude', 'Default');
  if (declaredActive()) { add(declaredActive()); }
  return out;
}

/**
 * Who is signed in to a config dir, for the QuickPick detail line. Best-effort:
 * an account that has never been logged into simply has no `.claude.json`.
 */
function accountEmail(configDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(claudeJsonPath({ configDir }), 'utf8');
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } };
    return parsed.oauthAccount?.emailAddress;
  } catch {
    return undefined;
  }
}

/** Where the active value comes from — shown in the tooltip so it is never a guess. */
function activeSource(): 'setting' | 'CLAUDE_CONFIG_DIR' | 'default' {
  if (declaredActive()) { return 'setting'; }
  return process.env.CLAUDE_CONFIG_DIR?.trim() ? 'CLAUDE_CONFIG_DIR' : 'default';
}

/** Friendly name for the active dir: its saved label if it has one. */
function activeLabel(): string {
  const active = claudeConfigDir();
  const match = savedAccounts().find((a) => a.resolved === active);
  if (match) { return match.label; }
  return isDefaultClaudeConfigDir() ? 'Default' : path.basename(active);
}

// ── Switch command ───────────────────────────────────────────────────────────

const ENTER_PATH = '__enter__';
const BROWSE = '__browse__';

interface Pick extends vscode.QuickPickItem {
  value: string;
}

async function promptForPath(): Promise<string | undefined> {
  const entered = await vscode.window.showInputBox({
    title: 'Claude config directory',
    prompt: 'Path to the Claude Code config folder for this account',
    placeHolder: '~/.claude-work',
    value: declaredActive(),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Enter a path, or press Escape to cancel'),
  });
  return entered?.trim() || undefined;
}

async function browseForPath(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Select Claude config directory',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(path.dirname(defaultClaudeConfigDir())),
    openLabel: 'Use this folder',
  });
  return picked?.[0]?.fsPath;
}

/**
 * Which settings file to write to. Workspace is the useful default — it is what
 * lets three windows hold three accounts — but a single-account user wants the
 * choice to stick everywhere, so ask rather than assume.
 */
async function chooseTarget(): Promise<vscode.ConfigurationTarget | undefined> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return vscode.ConfigurationTarget.Global;
  }
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'This workspace',
        description: '.vscode/settings.json',
        detail: 'Other windows keep their own account — this is how several accounts run side by side',
        target: vscode.ConfigurationTarget.Workspace,
      },
      {
        label: 'All windows',
        description: 'User settings',
        detail: 'Every workspace without its own setting uses this account',
        target: vscode.ConfigurationTarget.Global,
      },
    ],
    { title: 'Apply the account to…', ignoreFocusOut: true },
  );
  return pick?.target;
}

async function switchAccount(): Promise<void> {
  const active = claudeConfigDir();
  const accounts = savedAccounts();

  const items: Pick[] = accounts.map((a) => {
    const email = accountEmail(a.resolved);
    const exists = fs.existsSync(a.resolved);
    return {
      label: a.resolved === active ? `$(check) ${a.label}` : a.label,
      description: a.declared,
      detail: email
        ? `Signed in as ${email}`
        : exists
          ? 'No Claude login recorded in this folder yet'
          : 'Folder does not exist yet — Claude will create it on first login',
      value: a.declared,
    };
  });

  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator, value: '' } as Pick,
    { label: '$(edit) Enter path…', value: ENTER_PATH },
    { label: '$(folder-opened) Browse…', value: BROWSE },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Switch Claude account',
    placeHolder: `Active: ${active}`,
    ignoreFocusOut: true,
  });
  if (!picked) { return; }

  let declared: string | undefined = picked.value;
  if (picked.value === ENTER_PATH) { declared = await promptForPath(); }
  else if (picked.value === BROWSE) { declared = await browseForPath(); }
  if (!declared) { return; }

  // The default account is expressed as an empty setting, not a literal path,
  // so a user who never configured anything stays on the inherit-or-default
  // behaviour instead of being pinned to a hard-coded `~/.claude`.
  const value = resolvePath(declared) === defaultClaudeConfigDir() ? '' : declared;

  const target = await chooseTarget();
  if (target === undefined) { return; }

  await vscode.workspace
    .getConfiguration()
    .update(CONFIG_DIR_KEY, value || undefined, target);
  // The configuration listener in `register` picks it up and offers the reload.
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Install the config-dir override, the switch command and the status bar item.
 *
 * MUST run before anything that touches the global Claude folder (the
 * annotation tools installer, the token monitor), or those write into the
 * previous account for the first moments of the session.
 */
export function registerClaudeAccounts(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  status.command = SWITCH_ACCOUNT_CMD;
  context.subscriptions.push(status);

  const refreshStatus = (): void => {
    // Silent for the single-account majority: nothing to disambiguate, so the
    // item would be pure noise. It appears as soon as the user has more than
    // one account in play.
    const configured =
      declaredActive() !== '' ||
      (setting<SavedAccount[]>(CONFIG_DIRS_KEY) ?? []).length > 0 ||
      !!process.env.CLAUDE_CONFIG_DIR?.trim();
    if (!configured) { status.hide(); return; }

    const dir = claudeConfigDir();
    const email = accountEmail(dir);
    status.text = `$(account) ${activeLabel()}`;
    status.tooltip = new vscode.MarkdownString(
      [
        `**Claude account for this window**`,
        '',
        `- Config dir: \`${dir}\``,
        `- Source: ${activeSource()}`,
        `- Signed in as: ${email ?? '_no login recorded_'}`,
        '',
        'Click to switch.',
      ].join('\n'),
    );
    status.show();
  };

  const apply = (): void => {
    setClaudeConfigDir(declaredActive() || undefined);
    output.appendLine(`Claude config dir: ${claudeConfigDir()} (${activeSource()})`);
    refreshStatus();
  };
  apply();

  context.subscriptions.push(
    vscode.commands.registerCommand(SWITCH_ACCOUNT_CMD, () => void switchAccount()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_DIRS_KEY)) { refreshStatus(); }
      if (!e.affectsConfiguration(CONFIG_DIR_KEY)) { return; }
      apply();
      // Long-lived readers (token monitor watchers, open webviews) captured the
      // old dir; a reload is the honest way to switch accounts mid-session.
      void vscode.window
        .showInformationMessage(
          `AIDLC: Claude config dir is now ${claudeConfigDir()}. Reload the window so every view picks it up.`,
          'Reload Window',
        )
        .then((choice) => {
          if (choice === 'Reload Window') {
            void vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
    }),
  );
}
