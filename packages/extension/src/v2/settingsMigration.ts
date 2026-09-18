/**
 * Settings moved from `aidlc.*` to `aidlcNative.*` in 4.0.0, so this build can
 * be installed next to the upstream AIDLC extension, which still owns
 * `aidlc.*`. The old values are copied, never deleted: they may be the
 * upstream extension's live settings.
 *
 * Each level is migrated once (a memento flag), so clearing a migrated value
 * later does not bring it back. Commands cannot be migrated the same way —
 * keybindings.json belongs to the user — which the CHANGELOG says.
 */
import * as vscode from 'vscode';

import {
  CURRENT_PREFIX,
  contributedSettingKeys,
  planSettingsMigration,
  type SettingLevel,
  type SettingMove,
} from './settingsMigrationPlan';

const DONE_KEY = 'aidlcNative.settingsMigratedFromAidlc';

const TARGET: Record<SettingLevel, vscode.ConfigurationTarget> = {
  global: vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace,
  workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
};

async function apply(
  moves: SettingMove[],
  scope: vscode.Uri | undefined,
  output: vscode.OutputChannel,
): Promise<number> {
  let applied = 0;
  for (const m of moves) {
    try {
      await vscode.workspace
        .getConfiguration(undefined, scope)
        .update(CURRENT_PREFIX + m.key, m.value, TARGET[m.level]);
      output.appendLine(`settings: copied aidlc.${m.key} → ${CURRENT_PREFIX}${m.key} (${m.level})`);
      applied++;
    } catch (e) {
      output.appendLine(`settings: could not copy aidlc.${m.key} (${m.level}) — ${(e as Error).message}`);
    }
  }
  return applied;
}

/**
 * Copy legacy settings forward, then offer a reload when anything moved: the
 * settings read during this activation (the Claude config dir, the graph
 * engine) were read before the copy landed.
 */
export async function migrateLegacySettings(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  const keys = contributedSettingKeys(context.extension.packageJSON);
  let applied = 0;

  if (!context.globalState.get<boolean>(DONE_KEY)) {
    const cfg = vscode.workspace.getConfiguration();
    applied += await apply(planSettingsMigration(keys, ['global'], (k) => cfg.inspect(k)), undefined, output);
    await context.globalState.update(DONE_KEY, true);
  }

  if (vscode.workspace.workspaceFolders?.length && !context.workspaceState.get<boolean>(DONE_KEY)) {
    const cfg = vscode.workspace.getConfiguration();
    applied += await apply(planSettingsMigration(keys, ['workspace'], (k) => cfg.inspect(k)), undefined, output);
    // Per-folder settings only exist apart from workspace settings in a
    // multi-root workspace; in a single folder they are the same file.
    if (vscode.workspace.workspaceFile) {
      for (const folder of vscode.workspace.workspaceFolders) {
        const fcfg = vscode.workspace.getConfiguration(undefined, folder.uri);
        applied += await apply(
          planSettingsMigration(keys, ['workspaceFolder'], (k) => fcfg.inspect(k)),
          folder.uri,
          output,
        );
      }
    }
    await context.workspaceState.update(DONE_KEY, true);
  }

  if (applied === 0) return;
  const pick = await vscode.window.showInformationMessage(
    `AIDLC Native: copied ${applied} setting${applied === 1 ? '' : 's'} from aidlc.* to aidlcNative.*. Reload the window to apply them.`,
    'Reload Window',
  );
  if (pick) void vscode.commands.executeCommand('workbench.action.reloadWindow');
}
