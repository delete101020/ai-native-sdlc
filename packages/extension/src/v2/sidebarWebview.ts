/**
 * Sidebar webview — minimal v2 launcher.
 *
 * Replaces the legacy SDLC pipeline tree view. The sidebar is intentionally
 * simple: it shows where you are (project / workspace.yaml status / counts),
 * provides one-click access to the Builder panel and Claude CLI, and
 * surfaces the slash commands the user has wired up. Everything that needs
 * real estate (forms, cards, workflow editor) lives in the Builder panel.
 *
 * The data source is `.aidlc/workspace.yaml`. State is rebuilt on every
 * file change via a workspace watcher (set up in extension.ts).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

import * as fs from 'fs';

const DEMO_DIR_NAME = 'aidlc-demo-project';

import { readYaml, writeYaml } from './yamlIO';
import {
  WORKSPACE_DIR,
  WORKSPACE_FILENAME,
  RunStateStore,
  normalizeStep,
  resolvePath,
  discoverAssets,
  provisionDeclaredWorkflows,
  relativeEpicRoot,
  resolveArtifactLanguage,
  resolveEpicIdPrefixChain,
  readUserConfig,
  readGitUserName,
  writeUserEpicIdPrefix,
  ensureUserConfigIgnored,
  USER_CONFIG_RELPATH,
  EPIC_ID_PREFIX_PATTERN,
  writeTwoLayerCommands,
} from '@aidlc/core';
import type { PipelineConfig, DiscoveredAsset, EpicIdPrefixSource } from '@aidlc/core';
import { listEpics } from './epicsList';
import type { PresetStore } from './presetStore';
import { themeManager } from './themeManager';
import { loadMcpServers, type McpServerInfo } from './mcpServers';
import { pickAndReadTextFile } from './pickAndReadTextFile';
import { scaffoldRequirementAnalysis } from './requirementWizard';
import {
  rejectStepInlineCommand,
  rerunStepInlineCommand,
  requestStepUpdateInlineCommand,
  startPipelineRunInlineCommand,
} from './runCommands';
import { WorkspaceWebview } from './workspaceWebview';
import { missingBundleHtml } from './webviewBundleGuard';
import { agentActivity, type AgentActivityMap } from './agentActivity';

// VS Code reuses output channels by name, so this resolves to the same
// channel created in extension.ts activate().
const output = vscode.window.createOutputChannel('AIDLC');

interface TemplateRef {
  id: string;
  name: string;
  description: string;
}

/** Resolved artifact path with existence check, surfaced in the run card. */
interface ArtifactPath {
  /** Path relative to workspace root, with placeholders substituted. */
  path: string;
  exists: boolean;
}

/** Compact run summary for sidebar rendering. */
interface ActiveRun {
  runId: string;
  /**
   * The epic this run belongs to, when one exists — the convention is
   * `runId === epic.id`. Set so the sidebar can send a run that *is* an epic
   * to the Epics view (its full UI) instead of duplicating those controls in a
   * 300px-wide panel. Undefined for a bare run started from the Run button.
   */
  epicId?: string;
  pipelineId: string;
  currentStepIdx: number;
  totalSteps: number;
  currentAgent: string;
  /** Agent ids of every step, in pipeline order — used by the inline reject
   * modal to render the "send back to step N" picker without another roundtrip. */
  stepAgents: string[];
  /** awaiting_work | awaiting_review | rejected */
  currentStepStatus: string;
  revision: number;
  rejectReason?: string;
  feedback?: string;
  /** Files this step is expected to produce (resolved from template + context). */
  produces: ArtifactPath[];
  /** Files this step needs from upstream (already-produced gate inputs). */
  requires: ArtifactPath[];
  /**
   * Slash command (including the leading `/`) that invokes the current
   * step's agent, when one is wired up in `slash_commands`. Empty when no
   * command targets this agent — the user just sees the agent id then.
   */
  currentSlashCommand?: string;
}

interface PipelineRef {
  id: string;
  stepCount: number;
  onFailure: 'stop' | 'continue';
}

interface SidebarState {
  hasFolder: boolean;
  workspaceName: string;
  configExists: boolean;
  agentsCount: number;
  skillsCount: number;
  pipelinesCount: number;
  epicsCount: number;
  /** Last 3 epics with status, for the "Recent Epics" mini-list. */
  recentEpics: Array<{ id: string; title: string; status: string; statePath: string }>;
  slashCommands: Array<{ name: string; target: string }>;
  /** Workspace templates split by source — built-in (extension) vs project. */
  builtinTemplates: TemplateRef[];
  projectTemplates: TemplateRef[];
  /** Pipeline runs with status === 'running'. */
  activeRuns: ActiveRun[];
  /** Lightweight pipeline list for the inline Start-Run modal. */
  pipelines: PipelineRef[];
  /** All existing run ids (any status). */
  runIds: string[];
  /** True when ~/aidlc-demo-project already exists — surfaced so the
   * sidebar can pop an inline "re-seed / open-as-is / cancel" modal
   * instead of letting the host show a VS Code notification. */
  demoProjectExists: boolean;
  /** MCP servers Claude is currently connected to — null while loading
   * (the CLI runs a health check that takes several seconds), [] when
   * none are configured. */
  mcpServers: McpServerInfo[] | null;
  /** True while `claude mcp list` is in flight — the section shows a
   * spinner instead of the empty-list message. */
  mcpLoading: boolean;
  /** Surfaced from the spawn so the user knows why the list is missing
   * (claude not on PATH, timeout, etc.). */
  mcpError: string | null;
  /** Extra projects from the active/recent epic (GH-67). */
  extraProjects?: Array<{ type: string; ref: string; label: string; mode?: string }>;
  /** `artifact_language` from workspace.yaml — the language every artifact's
   * prose is written in, or null when the workspace states no preference.
   * Surfaced because there was no way to set it short of hand-editing the
   * YAML, and a workspace that never sets it gets a Vietnamese intent followed
   * by an English spec. */
  artifactLanguage: string | null;
  /** The two letters that keep this checkout’s epic ids from colliding with
   * a colleague’s, or null when neither file declares one. Resolved from
   * `.aidlc/user.yaml` first and the shared `workspace.yaml` second — see
   * `resolveEpicIdPrefixChain`. */
  epicIdPrefix: string | null;
  /** Which file {@link epicIdPrefix} came from, so the UI can say when a
   * value inherited from the shared file is not yet this person’s own. */
  epicIdPrefixSource: EpicIdPrefixSource;
  /** Two letters derived from `git config user.name`, offered when this
   * checkout has none of its own. Never reaches an id unaccepted. */
  epicIdPrefixSuggestion: string | null;
  /** True when `.aidlc/user.yaml` declares no prefix, whatever the shared
   * file says — what the sidebar warning renders on. */
  epicIdPrefixNeedsSetup: boolean;
  /**
   * Runs with an agent this window dispatched still working, keyed by run id.
   * Empty for a run whose agent the user launched in their own Claude window —
   * see {@link agentActivity} for why that case is unknowable.
   */
  agentActivity: AgentActivityMap;
}

interface McpSnapshot {
  servers: McpServerInfo[] | null;
  loading: boolean;
  error: string | null;
}

/**
 * How many distinct agents (or skills) this project actually has.
 *
 * The same asset is normally present twice: declared in `workspace.yaml` AND
 * installed as a `.md` file under `~/.claude/` or `.claude/` — that is how a
 * preset works, the YAML entry and the file on disk are two halves of one
 * asset. Adding the two lists produced doubled numbers in the stat row (12
 * agents for 6, 19 skills for 12) that disagreed with the Builder tab, which
 * has always deduplicated by id (`mergeAgents` / `mergeSkills`). Count ids,
 * not rows, so both surfaces tell the user the same thing.
 */
function countDistinct(declaredIds: string[], discovered: DiscoveredAsset[]): number {
  const ids = new Set(declaredIds);
  for (const a of discovered) { ids.add(a.id); }
  return ids.size;
}

function buildState(
  presetStore: PresetStore | null,
  mcp: McpSnapshot,
): SidebarState {
  const demoProjectExists = fs.existsSync(path.join(os.homedir(), DEMO_DIR_NAME));
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return {
      hasFolder: false,
      workspaceName: '',
      configExists: false,
      agentsCount: 0, skillsCount: 0, pipelinesCount: 0,
      epicsCount: 0, recentEpics: [],
      slashCommands: [],
      builtinTemplates: [], projectTemplates: [],
      activeRuns: [],
      pipelines: [], runIds: [],
      demoProjectExists,
      mcpServers: mcp.servers,
      mcpLoading: mcp.loading,
      mcpError: mcp.error,
      artifactLanguage: null,
      epicIdPrefix: null,
      epicIdPrefixSource: null,
      epicIdPrefixSuggestion: null,
      epicIdPrefixNeedsSetup: false,
      agentActivity: {},
    };
  }

  const root = folder.uri.fsPath;
  const doc = readYaml(root);

  // Epics live on disk independent of workspace.yaml — list them either way.
  const allEpics = listEpics(root, doc);

  // Discovered skills + agents from .claude/ (project) and ~/.claude/
  // (global). These are independent of workspace.yaml — they exist as
  // long as the folder is open. The disk scan returns aidlc-scope items
  // too, but for counting we ignore those and rely on the workspace.yaml
  // declarations (the runtime source of truth for AIDLC pipelines).
  const discovered = discoverAssets(root);
  const claudeSkills = discovered.skills.filter((s) => s.scope !== 'aidlc');
  const claudeAgents = discovered.agents.filter((a) => a.scope !== 'aidlc');
  const recentEpics = allEpics.slice(0, 3).map((e) => ({
    id: e.id,
    title: e.title,
    status: e.status,
    statePath: e.statePath,
  }));

  // GH-67: read extra_projects from the most recent in-progress epic for sidebar display.
  let sidebarExtraProjects: Array<{ type: string; ref: string; label: string; mode?: string }> | undefined;
  const activeEpic = allEpics.find((e) => e.status === 'in_progress') ?? allEpics[0];
  if (activeEpic) {
    const raw = activeEpic.inputs?.extra_projects;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) { sidebarExtraProjects = parsed; }
      } catch { /* ignore */ }
    }
  }

  // Templates also live independent of workspace.yaml — surface them even
  // when the project hasn't been initialized yet, so the user can apply one
  // as their first action.
  const { builtinTemplates, projectTemplates } = listTemplates(presetStore, root);

  // Active pipeline runs live in .aidlc/runs/ and are independent of the
  // workspace doc — surface them whenever the folder is open.
  const activeRuns = listActiveRuns(root, new Set(allEpics.map((e) => e.id)));
  const runIds = listAllRunIds(root);

  if (!doc) {
    return {
      hasFolder: true,
      workspaceName: folder.name,
      configExists: false,
      agentsCount: countDistinct([], claudeAgents),
      skillsCount: countDistinct([], claudeSkills),
      pipelinesCount: 0,
      epicsCount: allEpics.length, recentEpics,
      slashCommands: [],
      builtinTemplates, projectTemplates,
      activeRuns,
      pipelines: [],
      runIds,
      demoProjectExists,
      mcpServers: mcp.servers,
      mcpLoading: mcp.loading,
      mcpError: mcp.error,
      extraProjects: sidebarExtraProjects,
      artifactLanguage: null,
      epicIdPrefix: null,
      epicIdPrefixSource: null,
      epicIdPrefixSuggestion: null,
      epicIdPrefixNeedsSetup: false,
      agentActivity: agentActivity.snapshot(),
    };
  }

  const pipelines: PipelineRef[] = (doc.pipelines as PipelineConfig[]).map((p) => ({
    id: String(p.id),
    stepCount: Array.isArray(p.steps) ? p.steps.length : 0,
    onFailure: p.on_failure === 'continue' ? 'continue' : 'stop',
  }));

  return {
    hasFolder: true,
    // Use the folder name as the project identity, not workspace.yaml's
    // free-form `name:` field (see comment in builderWebview.ts).
    workspaceName: folder.name,
    configExists: true,
    // Counts span all 3 scopes: workspace.yaml entries (aidlc) + .claude/
    // (project) + ~/.claude/ (global), deduplicated by id — the same total
    // the Builder tab shows.
    agentsCount: countDistinct(doc.agents.map((a) => String(a.id)), claudeAgents),
    skillsCount: countDistinct(doc.skills.map((s) => String(s.id)), claudeSkills),
    pipelinesCount: doc.pipelines.length,
    epicsCount: allEpics.length,
    recentEpics,
    slashCommands: doc.slash_commands.map((c) => ({
      name: typeof c.name === 'string' ? c.name : '',
      target:
        typeof (c as { agent?: unknown }).agent === 'string'
          ? `agent ${(c as { agent: string }).agent}`
          : typeof (c as { pipeline?: unknown }).pipeline === 'string'
          ? `pipeline ${(c as { pipeline: string }).pipeline}`
          : '',
    })),
    builtinTemplates,
    projectTemplates,
    activeRuns,
    pipelines,
    runIds,
    demoProjectExists,
    mcpServers: mcp.servers,
    mcpLoading: mcp.loading,
    mcpError: mcp.error,
    extraProjects: sidebarExtraProjects,
    // `YamlDocument` models only the keys the sidebar reads; the setting is a
    // free top-level string the schema knows about and this type does not.
    artifactLanguage: resolveArtifactLanguage(doc as { artifact_language?: unknown }),
    ...epicIdPrefixFields(root, doc),
    agentActivity: agentActivity.snapshot(),
  };
}

/**
 * The four prefix fields, resolved together so they cannot disagree.
 *
 * Split across two files on purpose: `.aidlc/user.yaml` is this checkout’s
 * and is gitignored, `workspace.yaml` is the team’s and is committed. Reading
 * only the shared one — which is what shipped — hands the second developer to
 * pull their colleague’s initials, so every epic they open is filed under
 * someone else’s name.
 */
function epicIdPrefixFields(root: string, doc: unknown): {
  epicIdPrefix: string | null;
  epicIdPrefixSource: EpicIdPrefixSource;
  epicIdPrefixSuggestion: string | null;
  epicIdPrefixNeedsSetup: boolean;
} {
  const r = resolveEpicIdPrefixChain({
    user: readUserConfig(root),
    workspace: doc as { epic_id_prefix?: unknown },
    gitUserName: readGitUserName(root),
  });
  return {
    epicIdPrefix: r.prefix,
    epicIdPrefixSource: r.source,
    epicIdPrefixSuggestion: r.suggestion,
    epicIdPrefixNeedsSetup: r.needsSetup,
  };
}

function listAllRunIds(root: string): string[] {
  try {
    return RunStateStore.list(root).map((r) => r.runId);
  } catch {
    return [];
  }
}

function listActiveRuns(root: string, epicIds: ReadonlySet<string>): ActiveRun[] {
  try {
    // Read pipelines once so we can map runs → step config without
    // re-parsing workspace.yaml per run.
    const doc = readYaml(root);
    const pipelinesById = new Map<string, PipelineConfig>();
    // agent id → slash command name (including leading `/`). First wins
    // when multiple commands point at the same agent — the workspace
    // schema doesn't forbid that, but it's a config smell so we don't
    // bother surfacing duplicates.
    const slashByAgent = new Map<string, string>();
    if (doc) {
      for (const p of doc.pipelines as PipelineConfig[]) {
        if (typeof p.id === 'string') { pipelinesById.set(p.id, p); }
      }
      for (const c of doc.slash_commands) {
        const agent = (c as { agent?: unknown }).agent;
        if (typeof c.name === 'string' && typeof agent === 'string' && !slashByAgent.has(agent)) {
          slashByAgent.set(agent, c.name);
        }
      }
    }

    return RunStateStore.list(root)
      .filter((r) => r.status === 'running')
      .map((r) => {
        const step = r.steps[r.currentStepIdx];
        const pipeline = pipelinesById.get(r.pipelineId);
        const stepConfig = pipeline?.steps?.[r.currentStepIdx];
        const norm = stepConfig ? normalizeStep(stepConfig) : null;
        const agent = step?.agent ?? '';

        return {
          runId: r.runId,
          epicId: epicIds.has(r.runId) ? r.runId : undefined,
          pipelineId: r.pipelineId,
          currentStepIdx: r.currentStepIdx,
          totalSteps: r.steps.length,
          currentAgent: agent,
          stepAgents: r.steps.map((s) => s.agent),
          currentStepStatus: step?.status ?? '',
          revision: step?.revision ?? 1,
          rejectReason: step?.rejectReason,
          feedback: step?.feedback,
          produces: norm
            ? norm.produces.map((p) => resolveArtifact(root, p, r.context))
            : [],
          requires: norm
            ? norm.requires.map((p) => resolveArtifact(root, p, r.context))
            : [],
          currentSlashCommand: agent ? slashByAgent.get(agent) : undefined,
        };
      });
  } catch {
    return [];
  }
}

function resolveArtifact(
  root: string,
  template: string,
  context: Record<string, string>,
): ArtifactPath {
  const resolved = resolvePath(template, context);
  const abs = path.isAbsolute(resolved) ? resolved : path.join(root, resolved);
  return { path: resolved, exists: fs.existsSync(abs) };
}

function listTemplates(
  store: PresetStore | null,
  root: string,
): { builtinTemplates: TemplateRef[]; projectTemplates: TemplateRef[] } {
  if (!store) { return { builtinTemplates: [], projectTemplates: [] }; }
  try {
    const all = store.list(root);
    const builtinTemplates: TemplateRef[] = [];
    const projectTemplates: TemplateRef[] = [];
    for (const p of all) {
      const ref = { id: p.id, name: p.name, description: p.description };
      if (p.builtin) { builtinTemplates.push(ref); } else { projectTemplates.push(ref); }
    }
    return { builtinTemplates, projectTemplates };
  } catch {
    return { builtinTemplates: [], projectTemplates: [] };
  }
}

export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aidlcSidebar';
  private view: vscode.WebviewView | undefined;

  // MCP list is loaded lazily via `claude mcp list`; the CLI runs a health
  // check that takes several seconds so we cache the snapshot and let the
  // user trigger refreshes from the UI.
  private mcp: McpSnapshot = { servers: null, loading: false, error: null };
  private mcpLoadPromise: Promise<void> | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly presetStore: PresetStore | null = null,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) { this.refresh(); }
    });
    // Register the webview with the theme manager so user toggles in any
    // other panel propagate here too.
    const themeReg = themeManager.register(view.webview);
    view.onDidDispose(() => themeReg.dispose());
    // A dispatch or its completion is a state change like any other — the
    // panel has to redraw for the running indicator to appear and go away.
    const activityReg = agentActivity.onDidChange(() => this.refresh());
    view.onDidDispose(() => activityReg.dispose());
    this.refresh();
    // First-time MCP load happens once the panel is up — kicks off the
    // spawn and re-posts state when the result lands.
    void this.loadMcp();
  }

  refresh(): void {
    if (!this.view) { return; }
    void this.view.webview.postMessage({
      type: 'state',
      state: buildState(this.presetStore, this.mcp),
    });
  }

  private async loadMcp(): Promise<void> {
    if (this.mcpLoadPromise) { return this.mcpLoadPromise; }
    this.mcp = { servers: this.mcp.servers, loading: true, error: null };
    this.refresh();
    this.mcpLoadPromise = (async () => {
      try {
        const timeoutSeconds = vscode.workspace
          .getConfiguration('aidlc.mcp')
          .get<number>('listTimeoutSeconds', 90);
        const result = await loadMcpServers(undefined, Math.max(5, timeoutSeconds) * 1000);
        this.mcp = { servers: result.servers, loading: false, error: result.error };
      } catch (e) {
        this.mcp = {
          servers: this.mcp.servers,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        };
      } finally {
        this.refresh();
        this.mcpLoadPromise = null;
      }
    })();
    return this.mcpLoadPromise;
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.refresh();
        return;
      case 'setTheme': {
        const mode = String(msg.mode ?? '');
        if (mode === 'auto' || mode === 'light' || mode === 'dark') {
          await themeManager.set(mode);
        }
        return;
      }
      case 'openBuilder':
        await vscode.commands.executeCommand('aidlc.openBuilder');
        return;
      case 'openBuilderTab': {
        const tab = String(msg.tab ?? '');
        if (tab) { WorkspaceWebview.openBuilderTab(this.extensionUri, tab); }
        return;
      }
      case 'openClaude':
        await vscode.commands.executeCommand('aidlc.openClaudeTerminal');
        return;
      case 'askAidlc': {
        const question = typeof msg.question === 'string' ? msg.question : undefined;
        await vscode.commands.executeCommand('aidlc.ask', question);
        return;
      }
      case 'openProject': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
          openLabel: 'Open project',
        });
        if (picked && picked.length > 0) {
          output.appendLine(`[openProject] Opening folder: ${picked[0].fsPath}`);
          try {
            await vscode.commands.executeCommand(
              'vscode.openFolder', picked[0], { forceNewWindow: false },
            );
            output.appendLine('[openProject] openFolder command returned');
          } catch (err) {
            output.appendLine(`[openProject] Error: ${err}`);
            await vscode.window.showErrorMessage(`Failed to open folder: ${err}`);
          }
        }
        return;
      }
      case 'closeProject':
        await vscode.commands.executeCommand('workbench.action.closeFolder');
        return;
      case 'init':
        await vscode.commands.executeCommand('aidlc.initWorkspace');
        return;
      case 'loadDemoProject': {
        // mode is set by the React modal so the host skips the VS Code
        // notification — undefined falls back to the legacy prompt.
        const mode = msg.mode === 'reseed' || msg.mode === 'open-as-is'
          ? msg.mode
          : undefined;
        await vscode.commands.executeCommand('aidlc.loadDemoProject', mode);
        return;
      }
      case 'startEpic':
        await vscode.commands.executeCommand('aidlc.startEpic');
        return;
      case 'analyzeRequirements':
        await vscode.commands.executeCommand('aidlc.analyzeRequirements');
        return;
      case 'startAnalyzeRequirements':
        // Form now lives in the workspace panel — this case is a fallback for
        // the sidebar's old modal which is no longer used.
        WorkspaceWebview.show(this.extensionUri, 'analyze');
        return;
      case 'openAnalyzeView':
        WorkspaceWebview.show(this.extensionUri, 'analyze');
        return;
      case 'requestStartEpic':
        WorkspaceWebview.triggerStartEpic(this.extensionUri);
        return;
      case 'openEpicsList':
        await vscode.commands.executeCommand('aidlc.openEpicsList');
        return;
      case 'openEpic': {
        // Recent Epics is a deep link into the run, not a file browser — the
        // raw `state.json` is still one click away inside the card.
        const id = String(msg.id ?? '');
        if (!id) { return; }
        WorkspaceWebview.openEpic(this.extensionUri, id);
        return;
      }
      case 'openEpicState': {
        const statePath = String(msg.path ?? '');
        if (!statePath) { return; }
        const docOpen = await vscode.workspace.openTextDocument(statePath);
        await vscode.window.showTextDocument(docOpen, { preview: false });
        return;
      }
      case 'openYaml': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return; }
        const yp = path.join(root, WORKSPACE_DIR, WORKSPACE_FILENAME);
        const doc = await vscode.workspace.openTextDocument(yp);
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }
      case 'setArtifactLanguage': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return; }
        const doc = readYaml(root);
        if (!doc) { return; }
        const next = String(msg.language ?? '').trim();
        // Empty means "no opinion" — the field is removed rather than set to
        // '', because `resolveArtifactLanguage` treats blank as unset and a
        // stray `artifact_language: ""` in the YAML reads like a broken value.
        if (next) {
          (doc as { artifact_language?: string }).artifact_language = next;
        } else {
          delete (doc as { artifact_language?: string }).artifact_language;
        }
        writeYaml(root, doc);
        // The slash-command bodies resolve the setting at invocation time, so
        // nothing needs regenerating here — but a workspace set up by a build
        // that predates `artifact_language` has bodies that never look. This
        // refreshes exactly those; see `commandBodyPredatesArtifactLanguage`.
        try {
          const pipelineIds = (doc.pipelines ?? []).map((p) => String(p.id ?? '')).filter(Boolean);
          writeTwoLayerCommands(root, { epicRoot: relativeEpicRoot(doc) });
          provisionDeclaredWorkflows(this.extensionUri.fsPath, root, pipelineIds, {
            epicRoot: relativeEpicRoot(doc),
          });
        } catch (err) {
          // A refresh that fails leaves the setting written and the old bodies
          // in place — worth logging, not worth failing the edit over.
          output.appendLine(`[setArtifactLanguage] command refresh failed: ${String(err)}`);
        }
        this.refresh();
        return;
      }
      case 'setEpicIdPrefix': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return; }
        const next = String(msg.prefix ?? '').trim().toUpperCase();
        // Empty removes the key rather than writing `""`: no prefix is a real
        // choice, and it is the one every existing workspace already made.
        if (next && !EPIC_ID_PREFIX_PATTERN.test(next)) {
          void vscode.window.showWarningMessage(
            `epic_id_prefix must be exactly two letters — "${next}" was not saved.`,
          );
          this.refresh();
          return;
        }
        writeUserEpicIdPrefix(root, next || null);
        // Ignore it the moment it exists, not at `init`: the workspaces that
        // most need this are the ones scaffolded before the file did.
        if (next && ensureUserConfigIgnored(root)) {
          void vscode.window.showInformationMessage(
            `Added ${USER_CONFIG_RELPATH} to .gitignore — your prefix stays yours.`,
          );
        }
        // Nothing to regenerate: the prefix is read when an id is *suggested*,
        // not baked into any command body, and epics already on disk keep the
        // ids they were created with.
        this.refresh();
        return;
      }
      case 'applyTemplate': {
        const id = String(msg.id ?? '');
        if (!id) { return; }
        await vscode.commands.executeCommand(
          'aidlc.applyPreset',
          id,
          msg.skipConfirm === true,
        );
        return;
      }
      case 'savePresetInline': {
        const draft = msg.draft;
        if (!draft || typeof draft !== 'object') { return; }
        await vscode.commands.executeCommand('aidlc.savePresetInline', draft);
        return;
      }
      case 'rerunStepInline': {
        const runId = String(msg.runId ?? '');
        const feedback = String(msg.feedback ?? '');
        if (!runId) { return; }
        await rerunStepInlineCommand(runId, feedback);
        this.refresh();
        return;
      }
      case 'runStepWithFeedback': {
        const slash = String(msg.slashCommand ?? '');
        const runId = String(msg.runId ?? '');
        const feedback = String(msg.feedback ?? '');
        if (!slash || !runId) { return; }
        await vscode.commands.executeCommand(
          'aidlc.runStepWithFeedback',
          slash,
          runId,
          feedback,
        );
        return;
      }
      case 'requestStepUpdate': {
        const runId = String(msg.runId ?? '');
        const stepIdx = Number(msg.stepIdx);
        const feedback = String(msg.feedback ?? '');
        if (!runId || !Number.isInteger(stepIdx)) { return; }
        await requestStepUpdateInlineCommand(runId, stepIdx, feedback);
        this.refresh();
        return;
      }
      case 'startPipelineRun':
        await vscode.commands.executeCommand('aidlc.startPipelineRun');
        return;
      case 'clearAgentActivity': {
        // The user's override: they can see the agent is finished even though
        // no end signal reached us. Trusting them here is what keeps a missed
        // signal from being a dead end.
        const runId = String(msg.runId ?? '');
        if (!runId) { return; }
        agentActivity.end(runId);
        return;
      }
      case 'markStepDone':
      case 'approveStep':
      case 'rejectStep':
      case 'rerunStep':
      case 'runAutoReview':
      case 'openRunState': {
        const runId = String(msg.runId ?? '');
        const cmd = `aidlc.${msg.type}`;
        await vscode.commands.executeCommand(cmd, runId || undefined);
        // Refresh from here rather than leaning on the runs/ watcher. The
        // watcher is for edits made outside this window — the CLI, another
        // editor — and it is the wrong tool for a button the user just
        // pressed in this panel: it fires on the filesystem's own schedule,
        // and on a network or virtual filesystem it may not fire at all.
        // Approving a step and watching the panel keep showing the step you
        // approved is the whole bug this closes.
        this.refresh();
        return;
      }
      case 'deleteRun': {
        const runId = String(msg.runId ?? '');
        await vscode.commands.executeCommand(
          'aidlc.deleteRun',
          runId || undefined,
          msg.confirmed === true,
        );
        return;
      }
      case 'deleteEpic': {
        const epicId = String(msg.epicId ?? '');
        if (!epicId) { return; }
        const runId = typeof msg.runId === 'string' && msg.runId ? msg.runId : undefined;
        await vscode.commands.executeCommand(
          'aidlc.deleteEpic',
          epicId,
          runId,
          msg.deleteFolder === true,
          msg.confirmed === true,
        );
        // A removed folder is not a file change: the recursive delete need not
        // emit a watcher event per file, so the deleted epic could survive in
        // this list until something else forced a re-read.
        this.refresh();
        return;
      }
      case 'rejectStepInline': {
        const runId = String(msg.runId ?? '');
        const reason = String(msg.reason ?? '');
        const targetIdx = Number(msg.targetIdx);
        if (!runId || !Number.isInteger(targetIdx)) { return; }
        await rejectStepInlineCommand(runId, reason, targetIdx);
        this.refresh();
        return;
      }
      case 'startRunInline': {
        const pipelineId = String(msg.pipelineId ?? '');
        const runId = String(msg.runId ?? '');
        if (!pipelineId || !runId) { return; }
        await startPipelineRunInlineCommand(pipelineId, runId);
        this.refresh();
        return;
      }
      case 'openArtifact': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return; }
        const rel = String(msg.path ?? '');
        if (!rel) { return; }
        const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
        const uri = vscode.Uri.file(abs);
        try {
          // If the file exists, open it. If not, reveal the parent dir
          // in the explorer so the user can create it. This matches the
          // sidebar's "produces with a ◌ icon" affordance.
          await vscode.workspace.fs.stat(uri);
          const docArt = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(docArt, { preview: false });
        } catch {
          await vscode.commands.executeCommand('revealInExplorer', uri);
        }
        return;
      }
      case 'copyCommand': {
        const cmd = String(msg.command ?? '');
        if (!cmd) { return; }
        await vscode.env.clipboard.writeText(cmd);
        void vscode.window.setStatusBarMessage(`Copied ${cmd} to clipboard`, 2000);
        return;
      }
      case 'refresh':
        this.refresh();
        return;
      case 'refreshMcp':
        void this.loadMcp();
        return;
      case 'pickAndReadFile': {
        const requestId = String(msg.requestId ?? '');
        if (!requestId) { return; }
        const reply = await pickAndReadTextFile(requestId);
        void this.view?.webview.postMessage({ type: 'pickAndReadFile:reply', ...reply });
        return;
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const cspSource = webview.cspSource;
    const fallback = missingBundleHtml(this.extensionUri.fsPath, 'sidebar.js', cspSource, nonce);
    if (fallback) { return fallback; }
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg'),
    ).toString();
    const version = readExtensionVersion(this.extensionUri.fsPath);
    const initialState = buildState(this.presetStore, this.mcp);
    const initialTheme = themeManager.current;

    const assetsRoot = vscode.Uri.joinPath(this.extensionUri, 'out', 'webviews');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, 'styles.css')).toString();
    const entryUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, 'sidebar.js')).toString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           img-src ${cspSource} https: data:;
           font-src ${cspSource} https: data:;
           style-src ${cspSource} 'unsafe-inline';
           script-src 'nonce-${nonce}' ${cspSource};">
<title>AIDLC</title>
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
window.BRAND_ICON_URI = ${JSON.stringify(iconUri)};
window.EXTENSION_VERSION = ${JSON.stringify(version)};
window.__AIDLC_INITIAL_STATE__ = ${JSON.stringify(initialState)};
window.__AIDLC_INITIAL_THEME__ = ${JSON.stringify(initialTheme)};
</script>
<script type="module" nonce="${nonce}" src="${entryUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) { out += chars[Math.floor(Math.random() * chars.length)]; }
  return out;
}

function readExtensionVersion(extensionRoot: string): string {
  try {
    const raw = fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) { return pkg.version; }
  } catch { /* fall through */ }
  return '';
}

