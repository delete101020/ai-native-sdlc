/**
 * Opt-in code-graph engine: CodeGraph (github.com/colbymchenry/codegraph),
 * selected with `aidlc.astGraph.engine: "codegraph"`.
 *
 * Why it is cheaper than ast-graph at startup: CodeGraph's MCP server
 * (`codegraph serve --mcp`) watches the project itself and syncs only what
 * changed, so the extension never has to scan. Activation is: resolve the
 * bundle, build the index once if `.codegraph/` is missing, kick off a quick
 * incremental `sync` in the background, and make sure Claude has the server.
 *
 * Distribution mirrors ast-graph's: a pinned per-platform release bundle
 * (vendored Node runtime + app) downloaded from GitHub into globalStorage and
 * verified against SHA256 values baked in below — no npm, no global install,
 * nothing on PATH. Bump CODEGRAPH_VERSION + checksums together (they come
 * from the release's SHA256SUMS file).
 *
 * Cache layout:
 *   <globalStorage>/codegraph/<version>/{node.exe, lib/…}   (Windows)
 *   <globalStorage>/codegraph/<version>/{bin/codegraph, …}  (macOS / Linux)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

import { downloadFile, runChecked, sha256OfFile } from './binary';
import { ensureMcpServer, type McpRegistration } from './mcpRegister';
import { ensureClaudeMdHint } from './claudeMdHint';

export const CODEGRAPH_VERSION = '1.6.0';
export const CODEGRAPH_MCP_NAME = 'codegraph';
const RELEASE_BASE = `https://github.com/colbymchenry/codegraph/releases/download/v${CODEGRAPH_VERSION}`;

/** Archive name + SHA256 per `<platform>-<arch>`, from the v1.6.0 SHA256SUMS. */
const TARGETS: Record<string, { asset: string; sha256: string }> = {
  'darwin-arm64': { asset: 'codegraph-darwin-arm64.tar.gz', sha256: '1c73033512d55f67be04717e81532e8beaf7be6fb8531f51a179fa23064ad480' },
  'darwin-x64': { asset: 'codegraph-darwin-x64.tar.gz', sha256: 'cb86a2b62ee676b62a56bf8423600e7d867e752e57f323cdc98c0f6236efd908' },
  'linux-arm64': { asset: 'codegraph-linux-arm64.tar.gz', sha256: '6dc935a7b8f1a61e688a578b98ea34680eb2e36d7b91db079d64f4011f1a668f' },
  'linux-x64': { asset: 'codegraph-linux-x64.tar.gz', sha256: 'de3391f79ed42622d937e6cd5b7642a7ea8bb7d1473607e80b879ba73ef216b0' },
  'win32-arm64': { asset: 'codegraph-win32-arm64.zip', sha256: '3ca980010bd718a6b5e75be1145806ae6491afb1a59a2cec6cee4bf5c39f1b3a' },
  'win32-x64': { asset: 'codegraph-win32-x64.zip', sha256: 'cd76c3c3391f2d40abef12b142151950b6d77abc2d8429e648f89eaa90f5b68a' },
};

/** How to start CodeGraph: `command` + `args` come before the subcommand. */
interface Launcher {
  command: string;
  args: string[];
}

interface Summary {
  files: number;
  nodes: number;
  edges: number;
  languages: string[];
  lastIndexed: string | null;
  pending: number;
}

export interface CodeGraphOptions {
  openReportCmd: string;
  rescanCmd: string;
  reregisterCmd: string;
  /** Called once the codegraph server is registered for `folder`. */
  onReady: (folder: vscode.WorkspaceFolder) => Promise<void>;
}

export function registerCodeGraph(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  opts: CodeGraphOptions,
): void {
  const cfg = () => vscode.workspace.getConfiguration('aidlc.astGraph');
  // CodeGraph's anonymous usage telemetry is on by default upstream; the
  // extension spawns it on the user's behalf, so it stays off unless asked.
  const env = (): Record<string, string> =>
    cfg().get<boolean>('codegraphTelemetry', false) ? {} : { CODEGRAPH_TELEMETRY: '0' };

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.text = '$(type-hierarchy) CodeGraph …';
  item.tooltip = 'CodeGraph: preparing…';
  item.command = opts.openReportCmd;
  item.show();
  context.subscriptions.push(item);

  let launcher: Launcher | null = null;
  let busy: string | null = null;
  let summary: Summary | null = null;
  let mcp: McpRegistration = { ok: false, reason: 'not registered yet' };

  const primaryFolder = (): vscode.WorkspaceFolder | undefined => vscode.workspace.workspaceFolders?.[0];

  const updateStatusBar = (): void => {
    if (!launcher) { item.text = '$(cloud-download) CodeGraph …'; item.tooltip = 'CodeGraph: downloading…'; return; }
    if (busy) { item.text = '$(sync~spin) CodeGraph'; item.tooltip = `CodeGraph: ${busy}…`; return; }
    if (!summary) { item.text = '$(type-hierarchy) CodeGraph'; item.tooltip = 'CodeGraph: no index yet. Click for status.'; return; }
    const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    item.text = `$(type-hierarchy) CG ${k(summary.nodes)}n`;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**CodeGraph** v${CODEGRAPH_VERSION}\n\n`);
    md.appendMarkdown(`Files: ${summary.files} · Nodes: ${summary.nodes} · Edges: ${summary.edges}\n\n`);
    md.appendMarkdown(`Languages: ${summary.languages.join(', ') || '—'}\n\n`);
    if (summary.lastIndexed) md.appendMarkdown(`Last indexed: ${new Date(summary.lastIndexed).toLocaleString()}\n\n`);
    if (summary.pending) md.appendMarkdown(`Pending changes: ${summary.pending} (the MCP server syncs them)\n\n`);
    md.appendMarkdown(`MCP: ${mcp.ok ? 'registered' : `off (${mcp.reason || 'not registered'})`}\n\n`);
    md.appendMarkdown('Click for full status.');
    item.tooltip = md;
  };

  const run = (args: string[], cwd: string, timeoutMs: number): Promise<string> => {
    const l = launcher!;
    output.appendLine(`codegraph: ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      execFile(
        l.command,
        [...l.args, ...args],
        { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env(), NO_COLOR: '1' } },
        (err, stdout, stderr) => {
          if (err) {
            const tail = (stderr || stdout || '').toString().trim().split(/\r?\n/).slice(-4).join(' | ');
            reject(new Error(`codegraph ${args[0]} failed: ${tail || err.message}`));
            return;
          }
          resolve(stdout.toString());
        },
      );
    });
  };

  async function refreshSummary(folder: vscode.WorkspaceFolder): Promise<void> {
    try {
      const j = JSON.parse(await run(['status', '--json', folder.uri.fsPath], folder.uri.fsPath, 30_000));
      const p = j.pendingChanges ?? {};
      summary = j.initialized
        ? {
          files: j.fileCount ?? 0,
          nodes: j.nodeCount ?? 0,
          edges: j.edgeCount ?? 0,
          languages: Array.isArray(j.languages) ? j.languages : [],
          lastIndexed: j.lastIndexed ?? null,
          pending: (p.added ?? 0) + (p.modified ?? 0) + (p.removed ?? 0),
        }
        : null;
    } catch (err) {
      output.appendLine(`CodeGraph: status failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    updateStatusBar();
  }

  /** Run a long codegraph command with the status bar showing `label`. */
  async function withBusy(label: string, fn: () => Promise<unknown>, quiet = false): Promise<boolean> {
    busy = label;
    updateStatusBar();
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `CodeGraph: ${label}` }, fn);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`CodeGraph: ${label} failed — ${msg}`);
      if (!quiet) void vscode.window.showWarningMessage(`CodeGraph ${label} failed: ${msg}`);
      return false;
    } finally {
      busy = null;
      updateStatusBar();
    }
  }

  async function registerMcp(folder: vscode.WorkspaceFolder, force = false): Promise<void> {
    if (!launcher) return;
    mcp = await ensureMcpServer({
      server: {
        name: CODEGRAPH_MCP_NAME,
        command: launcher.command,
        args: [...launcher.args, 'serve', '--mcp', '--path', folder.uri.fsPath],
        env: env(),
      },
      cwd: folder.uri.fsPath,
      force,
    });
    output.appendLine(mcp.ok ? `CodeGraph: MCP ${mcp.reason || 'registered'} in ${folder.name}.` : `CodeGraph: MCP registration skipped — ${mcp.reason}`);
    if (mcp.ok) {
      try {
        await ensureClaudeMdHint(folder, 'codegraph');
      } catch (err) {
        output.appendLine(`CodeGraph: failed to write CLAUDE.md hint — ${err instanceof Error ? err.message : String(err)}`);
      }
      await opts.onReady(folder);
    }
    updateStatusBar();
  }

  async function bringUp(folder: vscode.WorkspaceFolder): Promise<void> {
    const cwd = folder.uri.fsPath;
    const indexed = await fs.promises.stat(path.join(cwd, '.codegraph', 'codegraph.db')).then(() => true, () => false);
    if (!indexed) {
      // One-time full build. Runs in the background; Claude gets the server
      // once there is something to serve.
      if (!(await withBusy('indexing', () => run(['init', '--yes', cwd], cwd, 60 * 60 * 1000)))) return;
    } else {
      // Catch up on edits made while no MCP server was watching. Incremental —
      // about a second on a mid-size repo — and failure is harmless: the MCP
      // server syncs on its own.
      await withBusy('syncing', () => run(['sync', cwd], cwd, 10 * 60 * 1000), true);
    }
    await refreshSummary(folder);
    await registerMcp(folder);
  }

  async function bootstrap(): Promise<void> {
    try {
      launcher = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Preparing CodeGraph…' },
        () => ensureCodeGraph(context, output),
      );
      output.appendLine(`CodeGraph: ready (v${CODEGRAPH_VERSION}) at ${launcher.command}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`CodeGraph: install failed — ${msg}`);
      void vscode.window.showWarningMessage(`CodeGraph: failed to install the bundle. ${msg}`);
      item.text = '$(warning) CodeGraph';
      item.tooltip = `CodeGraph: install failed — ${msg}`;
      return;
    }
    updateStatusBar();
    const primary = primaryFolder();
    if (!primary) { output.appendLine('CodeGraph: no workspace folder open.'); return; }
    await bringUp(primary);
  }

  void bootstrap();

  context.subscriptions.push(
    vscode.commands.registerCommand(opts.openReportCmd, async () => {
      const f = primaryFolder();
      if (!f || !launcher) { output.show(true); return; }
      try {
        const text = await run(['status', f.uri.fsPath], f.uri.fsPath, 30_000);
        output.appendLine(text);
      } catch (err) {
        output.appendLine(`CodeGraph: ${err instanceof Error ? err.message : String(err)}`);
      }
      output.show(true);
      await refreshSummary(f);
    }),
    vscode.commands.registerCommand(opts.rescanCmd, async () => {
      const f = primaryFolder();
      if (!f || !launcher) return;
      if (await withBusy('re-indexing', () => run(['index', f.uri.fsPath], f.uri.fsPath, 60 * 60 * 1000))) {
        await refreshSummary(f);
        await registerMcp(f);
      }
    }),
    vscode.commands.registerCommand(opts.reregisterCmd, async () => {
      const f = primaryFolder();
      if (f) await registerMcp(f, true);
    }),
  );

  output.appendLine('CodeGraph: integration registered.');
}

function detectTarget(): string {
  const target = `${process.platform}-${process.arch}`;
  if (!TARGETS[target]) {
    throw new Error(`no prebuilt CodeGraph bundle for ${target}. Supported: ${Object.keys(TARGETS).join(', ')}.`);
  }
  return target;
}

function launcherIn(dir: string): Launcher {
  if (process.platform === 'win32') {
    // Spawn the bundled node.exe on the app entry directly — Node refuses to
    // spawn a .cmd without a shell. Same flags CodeGraph's own shim passes:
    // --liftoff-only avoids a V8 Zone OOM in tree-sitter's WASM grammars, and
    // the warning filter keeps node:sqlite's notice out of the output.
    return {
      command: path.join(dir, 'node.exe'),
      args: ['--liftoff-only', '--disable-warning=ExperimentalWarning', path.join(dir, 'lib', 'dist', 'bin', 'codegraph.js')],
    };
  }
  return { command: path.join(dir, 'bin', 'codegraph'), args: [] };
}

async function isReady(l: Launcher): Promise<boolean> {
  const files = [l.command, ...l.args.filter((a) => a.endsWith('.js'))];
  for (const f of files) {
    const ok = await fs.promises.stat(f).then((s) => s.isFile() && s.size > 0, () => false);
    if (!ok) return false;
  }
  return true;
}

/**
 * Return the launcher for the cached CodeGraph bundle, downloading and
 * extracting it on first call. Idempotent. Throws on unsupported platform,
 * network failure, or checksum mismatch.
 */
export async function ensureCodeGraph(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<Launcher> {
  const target = detectTarget();
  const spec = TARGETS[target];
  const root = path.join(context.globalStorageUri.fsPath, 'codegraph');
  const dir = path.join(root, CODEGRAPH_VERSION);
  const ready = launcherIn(dir);
  if (await isReady(ready)) return ready;

  await fs.promises.mkdir(root, { recursive: true });
  const stage = await fs.promises.mkdtemp(path.join(root, '.dl-'));
  try {
    const archive = path.join(stage, spec.asset);
    const url = `${RELEASE_BASE}/${spec.asset}`;
    output.appendLine(`codegraph: downloading ${url}`);
    await downloadFile(url, archive);

    const actual = await sha256OfFile(archive);
    if (actual.toLowerCase() !== spec.sha256) {
      throw new Error(`checksum mismatch for ${spec.asset} (got ${actual}, expected ${spec.sha256})`);
    }
    output.appendLine(`codegraph: checksum OK (${actual.slice(0, 12)}…)`);

    const extracted = path.join(stage, 'x');
    await fs.promises.mkdir(extracted);
    if (spec.asset.endsWith('.zip')) {
      // Windows 10+ ships bsdtar, which reads zip; Expand-Archive is the
      // fallback (its module fails to load under some PSModulePath setups).
      const bsdtar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      await runChecked(bsdtar, ['-xf', archive, '-C', extracted], 300_000).catch(() => runChecked(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Path "${archive}" -DestinationPath "${extracted}" -Force`],
        300_000,
      ));
    } else {
      await runChecked('tar', ['-xzf', archive, '-C', extracted], 300_000);
    }
    // The archive holds one top-level `codegraph-<target>/` dir.
    const [top] = (await fs.promises.readdir(extracted, { withFileTypes: true })).filter((e) => e.isDirectory());
    if (!top) throw new Error('bundle archive is empty');
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.rename(path.join(extracted, top.name), dir);
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
  }

  const l = launcherIn(dir);
  if (!(await isReady(l))) throw new Error(`launcher missing after extraction under ${dir}`);
  if (process.platform === 'darwin') {
    await runChecked('xattr', ['-dr', 'com.apple.quarantine', dir], 10_000).catch(() => {});
  }
  output.appendLine(`codegraph: installed at ${dir}`);
  return l;
}
