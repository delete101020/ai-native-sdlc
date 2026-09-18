/**
 * Code-graph integration orchestrator. Picks the engine from
 * `aidlcNative.astGraph.engine` and wires it up from a single
 * `registerAstGraph(context, output)` call invoked from `extension.ts`:
 *
 *   - `ast-graph` (default) — this file.
 *   - `codegraph` (opt-in)  — ./codegraph.ts.
 *
 * Lifecycle per workspace folder for ast-graph (primary only — multi-root
 * falls back to the first folder, matching what Claude's `local` MCP scope
 * can actually point at):
 *   1. Resolve binary (download + verify on first run, cache afterwards)
 *   2. Scan only when needed: no graph yet, or HEAD moved while the window
 *      was closed. Otherwise reuse the cached summary — a scan rewrites the
 *      whole db and can take minutes on a large repo, so doing it on every
 *      activation is what made opening the extension slow.
 *   3. Register MCP server with Claude CLI (config-file check first, so no
 *      spawn when it is already registered)
 *   4. Watch git refs → clean rescan on branch switch / merge / pull; watch
 *      source saves only when `aidlcNative.astGraph.rescanOnSave` is on.
 *
 * Failures are surfaced via the status-bar pill rather than blocking
 * notifications — the user can click into the report to see what went
 * wrong and retry.
 */

import * as vscode from 'vscode';

import { AST_GRAPH_VERSION, ensureAstGraphBinary, UnsupportedPlatformError } from './binary';
import {
  createSourceWatcher,
  createGitWatcher,
  dbExists,
  dbPathFor,
  ensureGitignoreEntry,
  readGitHead,
  runScan,
  type ScanSummary,
} from './scanner';
import { ensureMcpServer, registeredServer, removeMcpServer, type McpRegistration } from './mcpRegister';
import { ensureClaudeMdHint } from './claudeMdHint';
import { AstGraphReportWebview } from './reportWebview';
import { registerCodeGraph, CODEGRAPH_MCP_NAME } from './codegraph';

const SETTING_NAMESPACE = 'aidlcNative.astGraph';
const OPEN_REPORT_CMD = 'aidlcNative.astGraph.openReport';
const RESCAN_CMD = 'aidlcNative.astGraph.rescan';
const REREGISTER_CMD = 'aidlcNative.astGraph.reregisterMcp';
const MCP_NAME = 'ast-graph';
/** workspaceState key: last good scan per folder, so activation can skip scanning. */
const CACHE_KEY = 'aidlc.astGraph.scanCache';

interface ScanCacheEntry {
  summary: ScanSummary;
  /** Commit the tree was on when scanned; null when unknown (not a git repo). */
  head: string | null;
  /** Binary version that wrote the db — a bump invalidates the entry. */
  version: string;
}

interface FolderState {
  folder: vscode.WorkspaceFolder;
  lastScan: ScanSummary | null;
  scanning: boolean;
  mcp: McpRegistration;
  watcher: vscode.Disposable | null;
  /** Watches .git refs → clean rescan on branch switch / merge / pull. */
  gitWatcher: vscode.Disposable | null;
}

export function registerAstGraph(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): void {
  const cfg = () => vscode.workspace.getConfiguration(SETTING_NAMESPACE);
  if (!cfg().get<boolean>('enabled', true)) {
    output.appendLine('AST graph: disabled via aidlcNative.astGraph.enabled.');
    return;
  }

  // The engine is fixed for the lifetime of the window: switching tears down
  // one MCP registration and builds another, so ask for a reload instead of
  // hot-swapping half-initialised state.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration(`${SETTING_NAMESPACE}.engine`) && !e.affectsConfiguration(`${SETTING_NAMESPACE}.enabled`)) return;
      const pick = await vscode.window.showInformationMessage(
        'AIDLC: reload the window to apply the code-graph engine change.',
        'Reload Window',
      );
      if (pick) void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
  );

  if (cfg().get<string>('engine', 'ast-graph') === 'codegraph') {
    registerCodeGraph(context, output, {
      openReportCmd: OPEN_REPORT_CMD,
      rescanCmd: RESCAN_CMD,
      reregisterCmd: REREGISTER_CMD,
      // Claude should see one graph server, not both.
      onReady: (folder) => dropOwnedRegistration(context, folder, MCP_NAME, output),
    });
    return;
  }

  // ---- Status bar ----------------------------------------------------------
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.text = '$(type-hierarchy) AST …';
  item.tooltip = 'AST graph: preparing…';
  item.command = OPEN_REPORT_CMD;
  item.show();
  context.subscriptions.push(item);

  // ---- Per-folder state ----------------------------------------------------
  const folderStates = new Map<string, FolderState>();
  let binPath: string | null = null;

  const primaryFolder = (): vscode.WorkspaceFolder | undefined =>
    vscode.workspace.workspaceFolders?.[0];

  const primaryState = (): FolderState | undefined => {
    const f = primaryFolder();
    return f ? folderStates.get(f.uri.toString()) : undefined;
  };

  const newState = (folder: vscode.WorkspaceFolder): FolderState => ({
    folder,
    lastScan: null,
    scanning: false,
    mcp: { ok: false, reason: 'not registered yet' },
    watcher: null,
    gitWatcher: null,
  });

  const stateFor = (folder: vscode.WorkspaceFolder): FolderState => {
    const key = folder.uri.toString();
    let s = folderStates.get(key);
    if (!s) { s = newState(folder); folderStates.set(key, s); }
    return s;
  };

  // ---- Scan cache ----------------------------------------------------------
  const readCache = (folder: vscode.WorkspaceFolder): ScanCacheEntry | undefined => {
    const all = context.workspaceState.get<Record<string, ScanCacheEntry>>(CACHE_KEY, {});
    const entry = all[folder.uri.toString()];
    return entry?.version === AST_GRAPH_VERSION ? entry : undefined;
  };
  const writeCache = async (folder: vscode.WorkspaceFolder, entry: ScanCacheEntry): Promise<void> => {
    const all = context.workspaceState.get<Record<string, ScanCacheEntry>>(CACHE_KEY, {});
    await context.workspaceState.update(CACHE_KEY, { ...all, [folder.uri.toString()]: entry });
  };

  const updateStatusBar = (): void => {
    const f = primaryFolder();
    const s = f ? folderStates.get(f.uri.toString()) : undefined;
    if (!binPath) {
      item.text = '$(cloud-download) AST …';
      item.tooltip = 'AST graph: downloading binary…';
      return;
    }
    if (!s) {
      item.text = '$(type-hierarchy) AST';
      item.tooltip = 'AST graph: no workspace folder.';
      return;
    }
    if (s.scanning) {
      item.text = '$(sync~spin) AST';
      item.tooltip = 'AST graph: scanning…';
      return;
    }
    if (s.lastScan) {
      const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      item.text = `$(type-hierarchy) AST ${k(s.lastScan.nodes)}n`;
      const md = new vscode.MarkdownString();
      md.appendMarkdown('**AST graph**\n\n');
      md.appendMarkdown(`Files: ${s.lastScan.files} · Nodes: ${s.lastScan.nodes} · Edges: ${s.lastScan.edges}\n\n`);
      md.appendMarkdown(`Languages: ${s.lastScan.languages.join(', ') || '—'}\n\n`);
      md.appendMarkdown(`Last scan: ${new Date(s.lastScan.finishedAt).toLocaleString()}\n\n`);
      md.appendMarkdown(`MCP: ${s.mcp.ok ? 'registered' : `off (${s.mcp.reason || 'not registered'})`}\n\n`);
      md.appendMarkdown('Click to open the report.');
      item.tooltip = md;
    } else {
      item.text = '$(type-hierarchy) AST';
      item.tooltip = 'AST graph: no scan summary yet. Click to open, or run "AIDLC Native: Rescan AST Graph".';
    }
    AstGraphReportWebview.notifyUpdate();
  };

  // ---- Scan + MCP runner ---------------------------------------------------
  async function scanFolder(folder: vscode.WorkspaceFolder, clean: boolean): Promise<void> {
    if (!binPath) {
      output.appendLine('AST graph: binary not ready, scan skipped.');
      return;
    }
    const state = stateFor(folder);
    if (state.scanning) {
      output.appendLine(`AST graph: scan already in flight for ${folder.name}, skipping.`);
      return;
    }
    state.scanning = true;
    updateStatusBar();

    try {
      await ensureGitignoreEntry(folder);
      const head = await readGitHead(folder);
      const summary = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `ast-graph scan: ${folder.name}`,
        },
        () => runScan({ binPath: binPath!, folder, clean, output }),
      );
      state.lastScan = summary;
      await writeCache(folder, { summary, head, version: AST_GRAPH_VERSION });
      output.appendLine(
        `AST graph: scan done — ${summary.files} files, ${summary.nodes} nodes, ${summary.edges} edges in ${summary.durationMs}ms.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`AST graph: scan failed — ${msg}`);
      void vscode.window
        .showWarningMessage(`AST graph scan failed: ${msg}`, 'Try codegraph engine')
        .then((pick) => {
          if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', `${SETTING_NAMESPACE}.engine`);
        });
    } finally {
      state.scanning = false;
      updateStatusBar();
    }
  }

  async function registerMcp(folder: vscode.WorkspaceFolder, force = false): Promise<void> {
    if (!binPath) return;
    if (!(await dbExists(folder))) return;
    const state = stateFor(folder);

    const result = await ensureMcpServer({
      server: { name: MCP_NAME, command: binPath, args: ['mcp', '--db', dbPathFor(folder)] },
      cwd: folder.uri.fsPath,
      force,
    });
    state.mcp = result;
    if (result.ok) {
      output.appendLine(`AST graph: MCP ${result.reason || 'registered'} in ${folder.name}.`);
      // Keep the hint in .claude/CLAUDE.md so Claude actually reaches for
      // ast-graph tools instead of defaulting to grep+read. Without this the
      // MCP server is "available but unused". Idempotent — no write when the
      // block is already current.
      try {
        await ensureClaudeMdHint(folder, 'ast-graph', { rescanOnSave: cfg().get<boolean>('rescanOnSave', false) });
      } catch (err) {
        output.appendLine(`AST graph: failed to write CLAUDE.md hint — ${err instanceof Error ? err.message : String(err)}`);
      }
      await dropOwnedRegistration(context, folder, CODEGRAPH_MCP_NAME, output);
    } else {
      output.appendLine(`AST graph: MCP registration skipped — ${result.reason}`);
    }
    updateStatusBar();
  }

  function attachWatcher(folder: vscode.WorkspaceFolder): void {
    const state = stateFor(folder);
    if (state.gitWatcher) return; // already attached

    const debounceMs = Math.max(1, cfg().get<number>('autoRescanDebounceSeconds', 5)) * 1000;
    // Rescan-on-save is opt-in: each ast-graph scan rewrites the whole db, so
    // on a large repo it pins a core for minutes after every save.
    if (cfg().get<boolean>('rescanOnSave', false)) {
      state.watcher = createSourceWatcher({
        folder,
        debounceMs,
        onTrigger: () => { void scanFolder(folder, false); },
      });
      context.subscriptions.push(state.watcher);
    }
    // Git ref watcher: branch switch / merge / rebase / reset / pull → clean
    // rescan so the graph fully reflects the new tree (add/remove/rename).
    state.gitWatcher = createGitWatcher({
      folder,
      debounceMs,
      onTrigger: () => {
        output.appendLine(`AST graph: git ref changed in ${folder.name} — clean rescan.`);
        void scanFolder(folder, true);
      },
    });
    context.subscriptions.push(state.gitWatcher);
  }

  /**
   * Bring the primary folder up without scanning when the graph is still
   * good. Scans (in the background) only when there is no db yet, or when
   * HEAD moved since the cached scan — e.g. a pull while the window was
   * closed, which the git watcher could not see.
   */
  async function bringUp(folder: vscode.WorkspaceFolder): Promise<void> {
    const state = stateFor(folder);
    if (!(await dbExists(folder))) {
      output.appendLine(`AST graph: no graph for ${folder.name} yet — first scan.`);
      await scanFolder(folder, false);
    } else {
      const cached = readCache(folder);
      if (cached) state.lastScan = cached.summary;
      const head = await readGitHead(folder);
      if (cached && head && cached.head && head !== cached.head) {
        output.appendLine(`AST graph: HEAD moved since last scan (${cached.head.slice(0, 7)} → ${head.slice(0, 7)}) — background clean rescan.`);
        void scanFolder(folder, true);
      } else {
        output.appendLine(`AST graph: reusing existing graph for ${folder.name} — no scan on startup.`);
      }
      updateStatusBar();
    }
    await registerMcp(folder);
    attachWatcher(folder);
  }

  // ---- Bootstrap (async, non-blocking) -------------------------------------
  async function bootstrap(): Promise<void> {
    try {
      const res = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'Preparing AST graph CLI…',
        },
        () => ensureAstGraphBinary(context, output),
      );
      binPath = res.path;
      output.appendLine(`AST graph: binary ready (v${res.version}) at ${res.path}`);
    } catch (err) {
      if (err instanceof UnsupportedPlatformError) {
        output.appendLine(`AST graph: ${err.message}`);
      } else {
        output.appendLine(`AST graph: binary install failed — ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showWarningMessage(
          `AST graph: failed to install the bundled CLI. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      updateStatusBar();
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) stateFor(f);
    updateStatusBar();

    // Only bring up the primary folder. Multi-root scans would
    // multiply work and the MCP local scope can only point at one
    // db — users with multi-root setups can switch with `Rescan`.
    const primary = folders[0];
    if (!primary) {
      output.appendLine('AST graph: no workspace folder open, deferring scan.');
      return;
    }
    await bringUp(primary);
  }

  void bootstrap();

  // ---- Workspace folder change → bootstrap newly added folders -------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (ev) => {
      for (const f of ev.removed) {
        const s = folderStates.get(f.uri.toString());
        s?.watcher?.dispose();
        s?.gitWatcher?.dispose();
        folderStates.delete(f.uri.toString());
      }
      for (const f of ev.added) stateFor(f);
      const primary = primaryFolder();
      if (primary && binPath && !folderStates.get(primary.uri.toString())?.gitWatcher) {
        await bringUp(primary);
      }
      updateStatusBar();
    }),
  );

  // ---- Runtime exposed to the report webview ------------------------------
  const runtime = {
    binPath: () => binPath,
    lastScan: () => primaryState()?.lastScan ?? null,
    isScanning: () => primaryState()?.scanning ?? false,
    mcpStatus: () => primaryState()?.mcp ?? { ok: false, reason: 'no workspace folder' },
    primaryFolder,
    async rescan(clean: boolean): Promise<void> {
      const f = primaryFolder();
      if (!f) return;
      await scanFolder(f, clean);
      await registerMcp(f);
      attachWatcher(f);
    },
    async reregisterMcp(): Promise<void> {
      const f = primaryFolder();
      if (!f) return;
      const s = stateFor(f);
      s.mcp = { ok: false, reason: 'reregistering…' };
      updateStatusBar();
      await registerMcp(f, true);
    },
  };

  // ---- Commands ------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_REPORT_CMD, () => AstGraphReportWebview.show(runtime)),
    vscode.commands.registerCommand(RESCAN_CMD, async () => {
      await runtime.rescan(true);
    }),
    vscode.commands.registerCommand(REREGISTER_CMD, async () => {
      await runtime.reregisterMcp();
    }),
  );

  output.appendLine('AST graph: integration registered.');

}

/**
 * Remove the other engine's local registration — but only one this extension
 * made (its command lives under our globalStorage), never a server the user
 * added by hand under the same name.
 */
async function dropOwnedRegistration(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  name: string,
  output: vscode.OutputChannel,
): Promise<void> {
  const existing = registeredServer(folder.uri.fsPath, name);
  if (!existing) return;
  const storage = context.globalStorageUri.fsPath.toLowerCase();
  if (!existing.command.toLowerCase().startsWith(storage)) return;
  const res = await removeMcpServer(folder.uri.fsPath, name);
  output.appendLine(`AST graph: ${res.ok ? 'removed' : 'could not remove'} the ${name} MCP entry (other engine)${res.ok ? '' : ` — ${res.reason}`}.`);
}
