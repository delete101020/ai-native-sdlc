/**
 * Getting to the epic you are working on without scrolling the Epics list.
 *
 *  - **Go to Epic** (`aidlcNative.goToEpic`, Ctrl+Alt+E): a quick pick over
 *    every epic, searchable by id, title, description and tags, with the active,
 *    pinned and recent ones on top. Enter opens it and makes it active.
 *  - **Active epic** in the status bar: the epic being worked on, one click from
 *    the picker. Also written to `.aidlc/user.yaml` so a skill in a Claude
 *    terminal (`/epic-context` with no id) and `aidlc epic current` agree.
 *  - **Follows the git branch**: checking out `feature/EPIC-012-…` makes
 *    EPIC-012 active (setting `aidlcNative.epics.followGitBranch`).
 *
 * The storage is core's `loader/epicFocus`; this module is only the VS Code
 * surface over it.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

import {
  USER_CONFIG_RELPATH,
  ensureUserConfigIgnored,
  epicIdFromBranch,
  readEpicFocus,
  recordEpicOpened,
  setActiveEpic,
  setEpicPinned,
  type EpicFocus,
} from '@aidlc/core';
import { readYaml } from './yamlIO';
import { epicsRoot, listEpics, type EpicSummary } from './epicsList';
import { WorkspaceWebview } from './workspaceWebview';

const FOLLOW_BRANCH_KEY = 'aidlcNative.epics.followGitBranch';
/** workspaceState: the branch seen last, so only a *change* of branch switches epics. */
const LAST_BRANCH_KEY = 'aidlcNative.epics.lastBranch';

const STATUS_ICON: Record<string, string> = {
  pending: '$(circle-large-outline)',
  in_progress: '$(play-circle)',
  done: '$(pass)',
  failed: '$(error)',
};

const STATUS_TEXT: Record<string, string> = {
  pending: 'pending',
  in_progress: 'in progress',
  done: 'done',
  failed: 'failed',
};

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** "step 3/6 · implement", or '' for an epic with no steps. */
export function stepLabel(e: EpicSummary): string {
  const total = e.agents.length;
  if (total === 0) { return ''; }
  const idx = Math.min(Math.max(e.currentStep, 0), total - 1);
  const d = e.stepDetails[idx];
  const name = d?.name || d?.agent || e.agents[idx] || '';
  return `step ${idx + 1}/${total}${name ? ` · ${name}` : ''}`;
}

function currentBranch(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, windowsHide: true }, (err, out) => {
      const b = err ? '' : String(out).trim();
      resolve(b && b !== 'HEAD' ? b : null);
    });
  });
}

/** `.git/HEAD` for a plain checkout, or the worktree's HEAD when `.git` is a file. */
function gitHeadPath(root: string): string | null {
  const dotGit = path.join(root, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) { return path.join(dotGit, 'HEAD'); }
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    return m ? path.join(path.resolve(root, m[1].trim()), 'HEAD') : null;
  } catch {
    return null;
  }
}

type EpicPickItem = vscode.QuickPickItem & { epicId?: string };

export class EpicFocusController implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires whenever the working set or the epics behind it may have changed. */
  readonly onDidChange = this.changed.event;
  private refreshTimer: NodeJS.Timeout | undefined;
  private headWatcher: fs.FSWatcher | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
  ) {
    // Just right of the "AIDLC" launcher (priority 50).
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.5);
    this.status.command = 'aidlcNative.goToEpic';
    this.disposables.push(this.status, this.changed);

    this.disposables.push(
      vscode.commands.registerCommand('aidlcNative.goToEpic', () => this.goToEpic()),
      vscode.commands.registerCommand('aidlcNative.openActiveEpic', () => this.openActive()),
      vscode.commands.registerCommand('aidlcNative.setActiveEpic', (id?: string) => this.setActive(id)),
      vscode.commands.registerCommand('aidlcNative.clearActiveEpic', () => this.setActive(null)),
      vscode.commands.registerCommand('aidlcNative.togglePinEpic', (id?: string) => this.togglePin(id)),
      // Every way into an epic (sidebar, active runs, this picker) goes through
      // WorkspaceWebview.openEpic, so this one hook keeps "Recent" honest.
      WorkspaceWebview.onDidOpenEpic((id) => {
        const root = workspaceRoot();
        if (root) { this.write(root, () => recordEpicOpened(root, id)); }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.watch(); this.scheduleRefresh(); }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(FOLLOW_BRANCH_KEY)) { void this.followBranch(); }
      }),
    );

    this.watch();
    this.refresh();
    void this.followBranch();
  }

  // ── reading ──────────────────────────────────────────────────────────────

  private snapshot(): { root: string; epics: EpicSummary[]; focus: EpicFocus } | null {
    const root = workspaceRoot();
    if (!root) { return null; }
    return { root, epics: listEpics(root, readYaml(root)), focus: readEpicFocus(root) };
  }

  // ── watching ─────────────────────────────────────────────────────────────

  private watchers: vscode.Disposable[] = [];

  private watch(): void {
    for (const w of this.watchers) { w.dispose(); }
    this.watchers = [];
    this.headWatcher?.close();
    this.headWatcher = undefined;

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }
    const root = folder.uri.fsPath;

    // Forward slashes: RelativePattern takes a glob, and `\` escapes in a glob.
    const userYaml = USER_CONFIG_RELPATH.split(path.sep).join('/');
    const epicsRel = path.relative(root, epicsRoot(root, readYaml(root))).split(path.sep).join('/');
    for (const glob of [userYaml, `${epicsRel}/*/state.json`]) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob));
      const on = () => this.scheduleRefresh();
      w.onDidChange(on); w.onDidCreate(on); w.onDidDelete(on);
      this.watchers.push(w);
    }

    // .git is excluded from VS Code's file watcher by default, so HEAD is
    // watched with fs directly — through its directory, because git replaces
    // the file (write HEAD.lock, rename) and a watch on the old file goes deaf.
    const head = gitHeadPath(root);
    if (head && fs.existsSync(head)) {
      try {
        this.headWatcher = fs.watch(path.dirname(head), (_event, name) => {
          if (!name || String(name) === 'HEAD') { void this.followBranch(); }
        });
      } catch { /* no branch following on this filesystem — not worth an error */ }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => this.refresh(), 250);
  }

  refresh(): void {
    const snap = this.snapshot();
    if (!snap) { this.status.hide(); this.changed.fire(); return; }

    const active = snap.focus.active
      ? snap.epics.find((e) => e.id === snap.focus.active)
      : undefined;
    if (active) {
      this.status.text = `$(target) ${active.id}`;
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**${active.id}** — ${active.title || '(untitled)'}\n\n`);
      md.appendMarkdown(`${STATUS_ICON[active.status] ?? ''} ${STATUS_TEXT[active.status] ?? active.status}`);
      const step = stepLabel(active);
      if (step) { md.appendMarkdown(` · ${step}`); }
      md.appendMarkdown('\n\n---\n\nClick to switch epic (Ctrl+Alt+E)');
      this.status.tooltip = md;
    } else {
      this.status.text = '$(target) Epic…';
      this.status.tooltip = 'No active epic — click to pick one (Ctrl+Alt+E)';
    }
    this.status.show();
    this.changed.fire();
  }

  // ── writing ──────────────────────────────────────────────────────────────

  private write(root: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      void vscode.window.showWarningMessage(
        `AIDLC: could not update ${USER_CONFIG_RELPATH}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // First write in an older workspace: keep the personal file out of git.
    ensureUserConfigIgnored(root);
    this.refresh();
  }

  private async setActive(id: string | null | undefined): Promise<void> {
    const root = workspaceRoot();
    if (!root) { return; }
    if (id === undefined) { return this.goToEpic(); }
    this.write(root, () => setActiveEpic(root, id));
  }

  private async togglePin(id?: string): Promise<void> {
    const root = workspaceRoot();
    if (!root) { return; }
    const focus = readEpicFocus(root);
    const target = id ?? focus.active;
    if (!target) {
      void vscode.window.showInformationMessage('AIDLC: no active epic to pin — pick one first.');
      return;
    }
    this.write(root, () => setEpicPinned(root, target, !focus.pinned.includes(target)));
  }

  private openActive(): void {
    const root = workspaceRoot();
    const active = root ? readEpicFocus(root).active : null;
    if (active) { WorkspaceWebview.openEpic(this.extensionUri, active); }
    else { void this.goToEpic(); }
  }

  /**
   * Make the branch's epic active — but only when the branch has changed
   * since last seen, so an epic picked by hand is not overridden on every
   * window reload while the same branch stays checked out.
   */
  private async followBranch(): Promise<void> {
    const root = workspaceRoot();
    if (!root) { return; }
    if (!vscode.workspace.getConfiguration().get<boolean>(FOLLOW_BRANCH_KEY, true)) { return; }

    const branch = await currentBranch(root);
    const last = this.context.workspaceState.get<string | null>(LAST_BRANCH_KEY, null);
    if (branch === last) { return; }
    await this.context.workspaceState.update(LAST_BRANCH_KEY, branch);
    if (!branch) { return; }

    const ids = listEpics(root, readYaml(root)).map((e) => e.id);
    const id = epicIdFromBranch(branch, ids);
    if (!id || id === readEpicFocus(root).active) { return; }
    this.write(root, () => setActiveEpic(root, id));
    vscode.window.setStatusBarMessage(`$(target) Active epic → ${id} (branch ${branch})`, 5000);
  }

  // ── Go to Epic ───────────────────────────────────────────────────────────

  private buildItems(epics: EpicSummary[], focus: EpicFocus): EpicPickItem[] {
    const byId = new Map(epics.map((e) => [e.id, e] as const));
    const seen = new Set<string>();
    const items: EpicPickItem[] = [];

    const pinBtn = (pinned: boolean): vscode.QuickInputButton => ({
      iconPath: new vscode.ThemeIcon(pinned ? 'pinned' : 'pin'),
      tooltip: pinned ? 'Unpin' : 'Pin to the top',
    });
    const peekBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('eye'),
      tooltip: 'Open without making it the active epic',
    };

    const section = (label: string, ids: string[]) => {
      const rows = ids.map((id) => byId.get(id)).filter((e): e is EpicSummary => !!e && !seen.has(e.id));
      if (rows.length === 0) { return; }
      items.push({ label, kind: vscode.QuickPickItemKind.Separator });
      for (const e of rows) {
        seen.add(e.id);
        const pinned = focus.pinned.includes(e.id);
        const step = stepLabel(e);
        const meta = [
          STATUS_TEXT[e.status] ?? e.status,
          step,
          e.tags.length > 0 ? e.tags.map((t) => `#${t}`).join(' ') : '',
        ].filter(Boolean).join(' · ');
        const brief = e.description.replace(/\s+/g, ' ').trim();
        items.push({
          epicId: e.id,
          label: `${STATUS_ICON[e.status] ?? ''} ${e.id}${e.id === focus.active ? '  $(target)' : ''}${pinned ? '  $(pinned)' : ''}`,
          description: e.title,
          // Searched too (matchOnDetail), so a word from the brief finds it.
          detail: brief ? `${meta} — ${brief.length > 120 ? `${brief.slice(0, 117)}…` : brief}` : meta,
          buttons: [peekBtn, pinBtn(pinned)],
        });
      }
    };

    section('Active', focus.active ? [focus.active] : []);
    section('Pinned', focus.pinned);
    section('Recent', focus.recent);
    section('All epics', epics.map((e) => e.id));
    return items;
  }

  async goToEpic(): Promise<void> {
    const snap = this.snapshot();
    if (!snap) {
      void vscode.window.showInformationMessage('AIDLC: open a folder to see its epics.');
      return;
    }
    if (snap.epics.length === 0) {
      const start = 'Start Epic';
      const pick = await vscode.window.showInformationMessage('AIDLC: no epics in this workspace yet.', start);
      if (pick === start) { void vscode.commands.executeCommand('aidlcNative.startEpic'); }
      return;
    }

    const { root } = snap;
    let epics = snap.epics;
    const qp = vscode.window.createQuickPick<EpicPickItem>();
    qp.title = 'Go to Epic';
    qp.placeholder = `Search ${epics.length} epics by id, title, description or #tag — Enter opens and makes it active`;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = this.buildItems(epics, snap.focus);

    const open = (id: string, makeActive: boolean) => {
      qp.hide();
      if (makeActive) { this.write(root, () => setActiveEpic(root, id)); }
      WorkspaceWebview.openEpic(this.extensionUri, id);
    };

    qp.onDidAccept(() => {
      const id = qp.selectedItems[0]?.epicId;
      if (id) { open(id, true); }
    });
    qp.onDidTriggerItemButton(({ item, button }) => {
      const id = item.epicId;
      if (!id) { return; }
      if ((button.iconPath as vscode.ThemeIcon).id === 'eye') { open(id, false); return; }
      const pinned = readEpicFocus(root).pinned.includes(id);
      this.write(root, () => setEpicPinned(root, id, !pinned));
      // Re-list in place; the typed filter survives because qp.value is untouched.
      epics = listEpics(root, readYaml(root));
      qp.items = this.buildItems(epics, readEpicFocus(root));
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  dispose(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.headWatcher?.close();
    for (const w of this.watchers) { w.dispose(); }
    for (const d of this.disposables) { d.dispose(); }
  }
}
