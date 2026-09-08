import { useState, useEffect, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Bot,
  GitBranch,
  Zap,
  Layers,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Beaker,
  FileCode2,
  Play,
  X,
  Sparkles,
  Diamond,
  RefreshCw,
  Plug,
  Loader2,
  HelpCircle,
  ListTree,
  Github,
  Languages,
  Fingerprint,
  Check,
  Clipboard,
  ScanEye,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  SidebarState,
  RecentEpicRef,
  TemplateRef,
  McpServerInfo,
  ActiveRun,
  AgentActivity,
  AgentActivityMap,
} from '@/lib/types';
import { ConfirmModal } from './ConfirmModal';
import { SavePresetModal } from './SavePresetModal';
import { LoadDemoModal } from './LoadDemoModal';
import { ThemeToggle } from './ThemeToggle';
import { AgentRunningBanner } from './AgentRunningBanner';
import { postMessage, getPersistedUi, setPersistedUi } from '@/lib/bridge';

interface CollapseState {
  activeRuns: boolean;
  recentEpics: boolean;
  workflows: boolean;
  mcpServers: boolean;
}

interface PersistedUi {
  collapsed?: Partial<CollapseState>;
}

const DEFAULT_COLLAPSED: CollapseState = {
  // The one section that is asking the user to do something — never starts shut.
  activeRuns: false,
  recentEpics: false,
  workflows: false,
  mcpServers: true,
};

export function AppSidebar({ state }: { state: SidebarState | null }) {
  const seed = (getPersistedUi<PersistedUi>() ?? {});
  const [collapsed, setCollapsed] = useState<CollapseState>({
    ...DEFAULT_COLLAPSED,
    ...(seed.collapsed ?? {}),
  });
  const persist = useCallback(
    (next: { collapsed?: CollapseState }) => {
      const merged: PersistedUi = {
        collapsed: next.collapsed ?? collapsed,
      };
      setPersistedUi(merged);
    },
    [collapsed],
  );

  const toggleSection = (key: keyof CollapseState) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    persist({ collapsed: next });
  };

  if (!state) {
    return (
      <aside className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <BrandIcon />
          <div className="min-w-0">
            <h2 className="text-[11px] font-bold tracking-widest uppercase">AIDLC</h2>
            <p className="truncate text-[10px] text-muted-foreground">Agent workflow runner</p>
          </div>
        </div>
        <ThemeToggle />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        <AskButton />
        {!state.hasFolder ? (
          <EmptyNoFolder demoProjectExists={state.demoProjectExists} />
        ) : (
          <>
            <ProjectBar workspaceName={state.workspaceName} configExists={state.configExists} extraProjects={state.extraProjects} />
            {state.configExists && (
              <button
                type="button"
                onClick={() => postMessage({ type: 'openYaml' })}
                className="flex w-full items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <FileCode2 className="h-3.5 w-3.5" />
                <span>Open workspace.yaml</span>
              </button>
            )}

            {state.configExists && <ArtifactLanguageRow value={state.artifactLanguage} />}

            {state.configExists && <EpicIdPrefixRow value={state.epicIdPrefix} />}

            {!state.configExists && (
              <div className="rounded-md border border-dashed border-border bg-surface/50 p-3 text-[11px] text-muted-foreground leading-relaxed">
                No <code className="rounded bg-primary/10 px-1 py-0.5 font-mono text-primary">workspace.yaml</code> yet — open the Builder from the title bar to scaffold one.
              </div>
            )}

            {/* Analyze Requirements — always visible when a folder is open */}
            <button
              type="button"
              onClick={() => postMessage({ type: 'openAnalyzeView' })}
              className="flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <ListTree className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Analyze Requirements</span>
              <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-50" />
            </button>

            {state.configExists && (
              <>
                <button
                  type="button"
                  onClick={() => postMessage({ type: 'requestStartEpic' })}
                  className="flex w-full items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>Start Epic</span>
                  <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-70" />
                </button>

                <StatsGrid state={state} />

                {state.activeRuns.length > 0 && (
                  <ActiveRunsSection
                    runs={state.activeRuns}
                    activity={state.agentActivity ?? {}}
                    collapsed={collapsed.activeRuns}
                    onToggle={() => toggleSection('activeRuns')}
                  />
                )}

                {state.recentEpics.length > 0 && (
                  <RecentEpicsSection
                    epics={state.recentEpics}
                    epicsCount={state.epicsCount}
                    collapsed={collapsed.recentEpics}
                    onToggle={() => toggleSection('recentEpics')}
                  />
                )}
              </>
            )}

            <WorkflowsSection
              builtins={state.builtinTemplates}
              project={state.projectTemplates}
              configExists={state.configExists}
              workspaceName={state.workspaceName}
              autopilotEnabled={state.autopilotEnabled}
              collapsed={collapsed.workflows}
              onToggle={() => toggleSection('workflows')}
            />

            <McpServersSection
              servers={state.mcpServers}
              loading={state.mcpLoading}
              error={state.mcpError}
              collapsed={collapsed.mcpServers}
              onToggle={() => toggleSection('mcpServers')}
            />
          </>
        )}
      </div>

      <Footer hasFolder={state.hasFolder} />

    </aside>
  );
}

/**
 * The languages offered by name. The setting takes free text — the prompt
 * section quotes whatever is there back at the model — so this list is a
 * convenience, not a whitelist; a value set by hand in the YAML is preserved
 * and shown as its own option.
 */
const ARTIFACT_LANGUAGES = [
  'English',
  'Vietnamese',
  'Japanese',
  'Korean',
  'Chinese',
  'French',
  'German',
  'Spanish',
];

/**
 * Picks the language every artifact's prose is written in.
 *
 * Unset is a real choice, not a missing one: it means "no opinion", the phase
 * prompts emit no language section at all, and each agent infers a language
 * from the epic brief. That inference is per-phase, which is how a workspace
 * ends up with a Vietnamese intent and an English spec — the pipeline's whole
 * premise is that phase N+1 reads phase N.
 */
function ArtifactLanguageRow({ value }: { value: string | null }) {
  const current = value ?? '';
  const known = current === '' || ARTIFACT_LANGUAGES.includes(current);
  return (
    <label
      className="flex w-full items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-xs text-muted-foreground"
      title="artifact_language in workspace.yaml — the language agents write artifact prose in. Headings, field labels and identifiers stay English either way."
    >
      <Languages className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0">Artifact language</span>
      <select
        value={current}
        onChange={(e) => postMessage({ type: 'setArtifactLanguage', language: e.target.value })}
        className="ml-auto min-w-0 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground"
      >
        <option value="">No preference</option>
        {!known && <option value={current}>{current}</option>}
        {ARTIFACT_LANGUAGES.map((lang) => (
          <option key={lang} value={lang}>{lang}</option>
        ))}
      </select>
    </label>
  );
}

/**
 * Sets the two letters that scope this checkout's suggested epic ids.
 *
 * Unset is the historical behaviour and stays available: the Start-Epic
 * suggestion is then `EPIC-<nnn>`, numbered across the whole folder. With two
 * letters set it becomes `EPIC-<yymmdd>-<XX>-<nnn>`, the date read locally, and
 * the counter restarts each day within this prefix. Nothing renames an epic
 * that already exists.
 */
function EpicIdPrefixRow({ value }: { value: string | null }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  const invalid = draft !== '' && !/^[A-Za-z]{2}$/.test(draft);
  const commit = () => {
    if (invalid) { return; }
    const next = draft.toUpperCase();
    if (next !== (value ?? '')) { postMessage({ type: 'setEpicIdPrefix', prefix: next }); }
  };
  return (
    <label
      className="flex w-full items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-xs text-muted-foreground"
      title="epic_id_prefix in workspace.yaml — two letters of your own, so a new epic is suggested as EPIC-260908-NG-001 instead of a number a colleague may already be using. Leave it empty for plain EPIC-001."
    >
      <Fingerprint className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0">Epic id prefix</span>
      <input
        value={draft}
        maxLength={2}
        placeholder="none"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
        className={`ml-auto w-14 rounded border bg-surface px-1.5 py-0.5 text-center text-[11px] uppercase text-foreground ${invalid ? 'border-destructive' : 'border-border'}`}
      />
    </label>
  );
}

function AskButton() {
  // Always visible — the whole point is helping users understand the
  // extension and how to set it up, which matters most *before* a workspace
  // exists. Routes to the host `aidlc.ask` command (prompts → claude → preview).
  return (
    <button
      type="button"
      onClick={() => postMessage({ type: 'askAidlc' })}
      title="Ask Claude about AIDLC — what it does, how to set it up"
      className="flex w-full items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
    >
      <HelpCircle className="h-3.5 w-3.5" />
      <span>Ask AIDLC</span>
      <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-70" />
    </button>
  );
}

function BrandIcon() {
  const uri = typeof window !== 'undefined' ? window.BRAND_ICON_URI : undefined;
  if (uri) {
    return (
      <img
        src={uri}
        alt="AIDLC"
        className="h-7 w-7 shrink-0 rounded-md object-cover shadow-md shadow-primary/20"
      />
    );
  }
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
      <Bot className="h-3.5 w-3.5" />
    </div>
  );
}

function ProjectBar({
  workspaceName,
  configExists,
  extraProjects,
}: {
  workspaceName: string;
  configExists: boolean;
  extraProjects?: Array<{ type: string; ref: string; label: string; mode?: string }>;
}) {
  const hasExtras = extraProjects && extraProjects.length > 0;
  return (
    <div className="space-y-1">
      {hasExtras && (
        <div className="px-1 text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
          AIDLC Workspace
        </div>
      )}
      <div
        role="button"
        tabIndex={0}
        onClick={() => postMessage({ type: 'openBuilder' })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            postMessage({ type: 'openBuilder' });
          }
        }}
        className="group flex cursor-pointer items-center gap-2 rounded-md border border-primary/30 bg-gradient-to-br from-primary/10 to-primary/5 px-3 py-2 transition-all hover:border-primary/40 hover:from-primary/20 hover:to-primary/10"
        title="Click to open Builder"
      >
        <Layers className="h-3.5 w-3.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-bold tracking-wide text-primary">{workspaceName}</div>
          {!configExists && (
            <div className="text-[10px] text-muted-foreground">no workspace.yaml</div>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            postMessage({ type: 'openProject' });
          }}
          title="Switch project"
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-primary/20 hover:text-primary"
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            postMessage({ type: 'closeProject' });
          }}
          title="Close project"
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {hasExtras && extraProjects.map((p, i) => (
        <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-1.5 text-[10.5px]">
          {p.type === 'github'
            ? <Github className="h-3 w-3 shrink-0 text-muted-foreground" />
            : <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={p.ref}>{p.label}</span>
          <span className={cn(
            'shrink-0 rounded-full px-1 py-0.5 text-[7px] font-bold uppercase',
            p.mode === 'workspace' ? 'bg-green-500/15 text-green-600 dark:text-green-400'
              : p.mode === 'clone' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
              : 'bg-muted text-muted-foreground',
          )}>
            {p.mode === 'workspace' ? 'ws' : p.mode === 'clone' ? 'clone' : 'ref'}
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyNoFolder({ demoProjectExists }: { demoProjectExists: boolean }) {
  const [demoModalOpen, setDemoModalOpen] = useState(false);
  const onLoadDemo = () => {
    if (demoProjectExists) {
      // Pop the inline picker — replaces the VS Code notification chrome
      // that the host would otherwise show when the dir already exists.
      setDemoModalOpen(true);
    } else {
      // Fresh install — just create + open. No prompt needed.
      postMessage({ type: 'loadDemoProject' });
    }
  };
  return (
    <div className="rounded-md border border-dashed border-border bg-surface/50 p-4 text-center">
      <h3 className="mb-1.5 text-xs font-bold tracking-wide">No project open</h3>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Open a folder to start building agents and workflows — or load the demo project.
      </p>
      <button
        type="button"
        onClick={() => postMessage({ type: 'openProject' })}
        className="flex w-full items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        <span>Open Project</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-70" />
      </button>
      <button
        type="button"
        onClick={onLoadDemo}
        className="mt-2 flex w-full items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Beaker className="h-3.5 w-3.5" />
        <span>Load Demo Project</span>
      </button>
      {demoModalOpen && (
        <LoadDemoModal
          onChoose={(mode) => postMessage({ type: 'loadDemoProject', mode })}
          onClose={() => setDemoModalOpen(false)}
        />
      )}
    </div>
  );
}

function StatsGrid({ state }: { state: SidebarState }) {
  // Each tile doubles as navigation: Agents/Skills/Flows deep-link into the
  // matching Builder tab, while Epics opens the dedicated top-level Epics view
  // (the Builder no longer has an Epics tab).
  const stats: { label: string; value: number; onClick: () => void }[] = [
    {
      label: 'Agents',
      value: state.agentsCount,
      onClick: () => postMessage({ type: 'openBuilderTab', tab: 'agents' }),
    },
    {
      label: 'Skills',
      value: state.skillsCount,
      onClick: () => postMessage({ type: 'openBuilderTab', tab: 'skills' }),
    },
    {
      label: 'Flows',
      value: state.pipelinesCount,
      onClick: () => postMessage({ type: 'openBuilderTab', tab: 'workflows' }),
    },
    {
      label: 'Epics',
      value: state.epicsCount,
      onClick: () => postMessage({ type: 'openEpicsList' }),
    },
  ];
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {stats.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={s.onClick}
          title={`Open ${s.label}`}
          className="flex flex-col items-center gap-0.5 rounded-md border border-border bg-card/50 px-1 py-2 transition-colors hover:border-primary/40 hover:bg-accent"
        >
          <span className="font-mono text-base font-bold tabular-nums text-primary leading-none">
            {s.value}
          </span>
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
            {s.label}
          </span>
        </button>
      ))}
    </div>
  );
}

function SectionHeader({
  label,
  collapsed,
  onToggle,
  trailing,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between pt-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-1 items-center gap-1.5 text-left text-[10px] font-bold uppercase tracking-widest text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          className={cn('h-3 w-3 transition-transform', collapsed && '-rotate-90')}
        />
        <span>{label}</span>
      </button>
      {trailing}
    </div>
  );
}

/**
 * Pipeline runs with `status === 'running'`.
 *
 * The host has always computed `activeRuns`, but nothing rendered it — so a run
 * started from the Builder's Run button had no surface at all once its toast
 * faded, and the toast's own "click Mark step done in the sidebar" pointed at a
 * section that did not exist. This is that section.
 *
 * Runs that belong to an epic get a link into the Epics view rather than a
 * second, thinner copy of the epic UI; the step controls stay here either way
 * because acting on the current step is the whole reason to look at this list.
 */
function ActiveRunsSection({
  runs,
  activity,
  collapsed,
  onToggle,
}: {
  runs: ActiveRun[];
  activity: AgentActivityMap;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <SectionHeader
        label="Active Runs"
        collapsed={collapsed}
        onToggle={onToggle}
        trailing={
          <span className="text-[10px] tabular-nums text-muted-foreground">{runs.length}</span>
        }
      />
      {!collapsed && (
        <div className="mt-1.5 space-y-1.5">
          {runs.map((r) => (
            <ActiveRunCard key={r.runId} run={r} activity={activity[r.runId] ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}

const RUN_STEP_STATUS: Record<string, { label: string; cls: string }> = {
  awaiting_work: { label: 'Awaiting work', cls: 'border-warning/40 bg-warning/15 text-warning' },
  awaiting_auto_review: { label: 'Auto-review', cls: 'border-primary/40 bg-primary/15 text-primary' },
  awaiting_review: { label: 'Awaiting review', cls: 'border-primary/40 bg-primary/15 text-primary' },
  rejected: { label: 'Rejected', cls: 'border-destructive/40 bg-destructive/15 text-destructive' },
  pending: { label: 'Pending', cls: 'border-border bg-secondary text-muted-foreground' },
  approved: { label: 'Approved', cls: 'border-success/40 bg-success/15 text-success' },
};

function ActiveRunCard({
  run,
  activity,
}: {
  run: ActiveRun;
  activity: AgentActivity | null;
}) {
  const status = RUN_STEP_STATUS[run.currentStepStatus] ?? {
    label: run.currentStepStatus || 'unknown',
    cls: 'border-border bg-secondary text-muted-foreground',
  };
  // The commands below resolve the current step themselves when handed only a
  // runId, so the sidebar never has to reason about step indices.
  const act = (type: string) => () => postMessage({ type, runId: run.runId });
  const missingRequires = run.requires.filter((r) => !r.exists);
  // Same rule as the epic card: while an agent we launched is still on this
  // run, there is nothing yet to mark done, approve or reject.
  const busy = !!activity;
  const busyTitle = 'An agent is still working on this run — wait for it, or dismiss the banner above';

  return (
    <div className="rounded-md border border-border bg-card/50 px-2.5 py-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        {run.epicId ? (
          <button
            type="button"
            onClick={() => postMessage({ type: 'openEpic', id: run.epicId })}
            title={`Open ${run.epicId} in the Epics view`}
            className="truncate font-mono text-[10px] font-bold text-primary hover:underline"
          >
            {run.runId}
          </button>
        ) : (
          <span className="truncate font-mono text-[10px] font-bold text-primary">
            {run.runId}
          </span>
        )}
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
          {run.currentStepIdx + 1}/{run.totalSteps}
        </span>
        <button
          type="button"
          onClick={act('openRunState')}
          title="Open the run JSON"
          className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FileCode2 className="h-3 w-3" />
        </button>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            'rounded-full border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider',
            status.cls,
          )}
        >
          {status.label}
        </span>
        <span className="truncate text-muted-foreground">{run.currentAgent}</span>
        {run.revision > 1 && (
          <span className="text-[9px] text-muted-foreground">rev {run.revision}</span>
        )}
      </div>

      {run.currentSlashCommand && run.currentStepStatus === 'awaiting_work' && (
        <button
          type="button"
          onClick={() =>
            postMessage({
              type: 'copyCommand',
              command: `${run.currentSlashCommand} ${run.runId}`,
            })
          }
          title="Copy this command to the clipboard"
          className="mt-1.5 flex w-full items-center gap-1.5 rounded border border-border bg-surface/60 px-1.5 py-1 font-mono text-[10px] text-foreground hover:bg-accent"
        >
          <Clipboard className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {run.currentSlashCommand} {run.runId}
          </span>
        </button>
      )}

      {activity && <AgentRunningBanner activity={activity} className="mt-1.5" />}

      {(run.rejectReason || run.feedback) && (
        <div className="mt-1.5 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-1 text-[10px] leading-snug text-muted-foreground">
          {run.rejectReason || run.feedback}
        </div>
      )}

      {missingRequires.length > 0 && (
        <div className="mt-1.5 text-[10px] leading-snug text-warning">
          Missing input{missingRequires.length === 1 ? '' : 's'}:{' '}
          <span className="font-mono">{missingRequires.map((r) => r.path).join(', ')}</span>
        </div>
      )}

      {run.produces.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {run.produces.map((p) => (
            <button
              key={p.path}
              type="button"
              onClick={() => postMessage({ type: 'openArtifact', path: p.path })}
              title={p.exists ? `Open ${p.path}` : `${p.path} — not written yet`}
              className="flex w-full items-center gap-1.5 text-left font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  p.exists ? 'bg-success' : 'border border-muted-foreground/50',
                )}
              />
              <span className="truncate">{p.path}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap gap-1">
        {run.currentStepStatus === 'awaiting_work' && (
          <RunAction icon={<Check className="h-2.5 w-2.5" />} label="Mark step done" onClick={act('markStepDone')} primary disabled={busy} title={busy ? busyTitle : undefined} />
        )}
        {run.currentStepStatus === 'awaiting_auto_review' && (
          <RunAction icon={<ScanEye className="h-2.5 w-2.5" />} label="Run auto-review" onClick={act('runAutoReview')} primary disabled={busy} title={busy ? busyTitle : undefined} />
        )}
        {run.currentStepStatus === 'awaiting_review' && (
          <>
            <RunAction icon={<Check className="h-2.5 w-2.5" />} label="Approve" onClick={act('approveStep')} primary disabled={busy} title={busy ? busyTitle : undefined} />
            <RunAction icon={<X className="h-2.5 w-2.5" />} label="Reject" onClick={act('rejectStep')} disabled={busy} title={busy ? busyTitle : undefined} />
          </>
        )}
        {run.currentStepStatus === 'rejected' && (
          <RunAction icon={<RefreshCw className="h-2.5 w-2.5" />} label="Rerun" onClick={act('rerunStep')} primary disabled={busy} title={busy ? busyTitle : undefined} />
        )}
      </div>
    </div>
  );
}

function RunAction({
  icon,
  label,
  onClick,
  primary,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors',
        primary
          ? 'border-primary/40 bg-primary/15 text-primary'
          : 'border-border bg-card text-muted-foreground',
        disabled
          ? 'cursor-not-allowed opacity-40'
          : primary
          ? 'hover:bg-primary/25'
          : 'hover:bg-accent hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function RecentEpicsSection({
  epics,
  epicsCount,
  collapsed,
  onToggle,
}: {
  epics: RecentEpicRef[];
  epicsCount: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <SectionHeader
        label="Recent Epics"
        collapsed={collapsed}
        onToggle={onToggle}
        trailing={
          <button
            type="button"
            onClick={() => postMessage({ type: 'openEpicsList' })}
            className="text-[10px] text-muted-foreground hover:text-primary"
          >
            All {epicsCount} →
          </button>
        }
      />
      {!collapsed && (
        <div className="mt-1.5 space-y-1">
          {epics.map((e) => (
            <div
              key={e.id}
              role="button"
              tabIndex={0}
              title={`Open ${e.id} in the Epics view`}
              onClick={() => postMessage({ type: 'openEpic', id: e.id })}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  postMessage({ type: 'openEpic', id: e.id });
                }
              }}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5 text-[11px] transition-colors hover:bg-accent"
            >
              <EpicDot status={e.status} />
              <span className="font-mono text-[10px] font-bold text-primary truncate">{e.id}</span>
              {e.title && (
                <span className="truncate text-muted-foreground">· {e.title}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EpicDot({ status }: { status: string }) {
  const cls = (() => {
    switch (status) {
      case 'in_progress':
        return 'bg-warning shadow-[0_0_4px_var(--color-warning)]';
      case 'done':
        return 'bg-success';
      case 'failed':
        return 'bg-destructive';
      default:
        return 'bg-muted-foreground/40';
    }
  })();
  return <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', cls)} />;
}

function McpServersSection({
  servers,
  loading,
  error,
  collapsed,
  onToggle,
}: {
  servers: McpServerInfo[] | null;
  loading: boolean;
  error: string | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  // Show counts in the header so users can glance the connected total
  // without expanding. servers === null means the list hasn't loaded yet.
  const total = servers?.length ?? 0;
  const connected = servers?.filter((s) => s.status === 'connected').length ?? 0;
  return (
    <div>
      <SectionHeader
        label="MCP servers"
        collapsed={collapsed}
        onToggle={onToggle}
        trailing={
          <div className="flex items-center gap-1.5">
            {servers && (
              <span className="text-[10px] text-muted-foreground">
                {connected}/{total}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                postMessage({ type: 'refreshMcp' });
              }}
              title="Re-run claude mcp list"
              className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </button>
          </div>
        }
      />
      {!collapsed && (
        <div className="mt-1.5 space-y-1">
          {error && (
            <div className="rounded border-l-2 border-destructive bg-destructive/5 px-2 py-1.5 text-[10px] text-muted-foreground">
              {error}
            </div>
          )}
          {servers === null && !error && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Querying claude mcp list…</span>
            </div>
          )}
          {servers && servers.length === 0 && !error && (
            <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground">
              No MCP servers configured.
            </div>
          )}
          {servers?.map((s) => <McpRow key={s.name} server={s} />)}
        </div>
      )}
    </div>
  );
}

const MCP_DOT: Record<McpServerInfo['status'], string> = {
  connected: 'bg-success shadow-[0_0_4px_var(--color-success)]',
  needs_auth: 'bg-warning',
  failed: 'bg-destructive',
  unknown: 'bg-muted-foreground/40',
};

function McpRow({ server }: { server: McpServerInfo }) {
  const titleParts = [server.statusText];
  if (server.transport) { titleParts.push(server.transport); }
  if (server.endpoint) { titleParts.push(server.endpoint); }
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5 text-[11px]"
      title={titleParts.join(' · ')}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', MCP_DOT[server.status])} />
      <Plug className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium text-foreground">{server.name}</span>
      <span className="ml-auto shrink-0 truncate text-[9px] uppercase tracking-wider text-muted-foreground">
        {server.status === 'needs_auth' ? 'auth' : server.status}
      </span>
    </div>
  );
}


function WorkflowsSection({
  builtins,
  project,
  configExists,
  workspaceName,
  autopilotEnabled,
  collapsed,
  onToggle,
}: {
  builtins: TemplateRef[];
  project: TemplateRef[];
  configExists: boolean;
  workspaceName: string;
  autopilotEnabled: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [pendingApply, setPendingApply] = useState<TemplateRef | null>(null);

  if (builtins.length === 0 && project.length === 0 && !configExists) { return null; }

  const onApplyClick = (template: TemplateRef) => {
    if (configExists) {
      setPendingApply(template);
    } else {
      postMessage({ type: 'applyTemplate', id: template.id, skipConfirm: true });
    }
  };

  return (
    <div>
      <SectionHeader label="Workflows" collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && (
        <div className="mt-1.5 space-y-1.5">
          {configExists && (
            <button
              type="button"
              onClick={() => setSaveOpen(true)}
              className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              <Diamond className="h-3 w-3" />
              <span>Save current as template</span>
            </button>
          )}
          {builtins.length > 0 && (
            <>
              <div className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                Common
              </div>
              {builtins.map((t) => (
                <TemplateRow key={t.id} template={t} builtin onApply={onApplyClick} />
              ))}
              <AutopilotRow enabled={autopilotEnabled} />
            </>
          )}
          {project.length > 0 && (
            <>
              <div className="mt-2 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                Custom
              </div>
              {project.map((t) => (
                <TemplateRow key={t.id} template={t} builtin={false} onApply={onApplyClick} />
              ))}
            </>
          )}
        </div>
      )}

      {saveOpen && (
        <SavePresetModal
          existingProjectIds={project.map((p) => p.id)}
          builtinIds={builtins.map((b) => b.id)}
          defaultId={workspaceName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')}
          defaultName={workspaceName}
          onSubmit={(draft) => postMessage({ type: 'savePresetInline', draft })}
          onClose={() => setSaveOpen(false)}
        />
      )}
      {pendingApply && (
        <ConfirmModal
          title="Apply template"
          danger
          confirmLabel="Overwrite & apply"
          message={
            <>
              This project already has <span className="font-mono">.aidlc/workspace.yaml</span>.
              Overwrite with template <span className="font-mono">{pendingApply.id}</span>?
            </>
          }
          onConfirm={() =>
            postMessage({ type: 'applyTemplate', id: pendingApply.id, skipConfirm: true })
          }
          onClose={() => setPendingApply(null)}
        />
      )}
    </div>
  );
}

// Lightweight hover tooltip. Native `title` tooltips are unreliable / slow in
// the VS Code webview, so we render our own: on hover we anchor a fixed-
// position card to the row's rect (fixed → escapes the sidebar's overflow
// clipping), clamped to the viewport.
function useTooltip() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const onMouseEnter = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(r.left, window.innerWidth - 312)),
      y: r.bottom + 6,
    });
  };
  const onMouseLeave = () => setPos(null);
  return { pos, onMouseEnter, onMouseLeave };
}

function Tooltip({ pos, text }: { pos: { x: number; y: number }; text: string }) {
  return (
    <div
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 9999, maxWidth: 300 }}
      className="pointer-events-none whitespace-pre-line rounded-md border border-border bg-card px-3 py-2 text-[11px] leading-relaxed text-foreground shadow-lg"
    >
      {text}
    </div>
  );
}

function TemplateRow({
  template,
  builtin,
  onApply,
}: {
  template: TemplateRef;
  builtin: boolean;
  onApply: (template: TemplateRef) => void;
}) {
  const Icon = builtin ? Sparkles : Diamond;
  const tip = useTooltip();
  const tipText = template.description
    ? `${template.name}\n\n${template.description}\n\nClick to apply.`
    : `Apply template ${template.id}`;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onApply(template)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onApply(template);
        }
      }}
      onMouseEnter={tip.onMouseEnter}
      onMouseLeave={tip.onMouseLeave}
      className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5 text-[11px] transition-colors hover:bg-accent"
    >
      <Icon className="h-3 w-3 shrink-0 text-primary opacity-80" />
      <span className="shrink-0 font-semibold text-primary truncate max-w-[40%]">
        {template.name}
      </span>
      <span className="truncate text-muted-foreground">· {template.description || template.id}</span>
      {tip.pos && <Tooltip pos={tip.pos} text={tipText} />}
    </div>
  );
}

// The AIDLC Autopilot entry in the Common workflows. It isn't a template you
// apply — it's a behavior gated by the `aidlc.autopilot.enabled` setting — so
// the row mirrors that setting: "Coming soon" (disabled look) when off, "On"
// (active look) when enabled. Clicking either state deep-links to the setting
// so the user can flip it. The shared concept blurb frames the feature.
const AUTOPILOT_CONCEPT =
  'AIDLC Autopilot\n\n' +
  "Reads your project's real context — codebase, tests, spec, and design — " +
  'sizes the epic, then drafts a plan tailored to it: which agents run in ' +
  'which phases, what to clarify first, and which phases to add. A near-' +
  'superpower that stays grounded in your business and codebase, not generic ' +
  'boilerplate.';

function AutopilotRow({ enabled }: { enabled: boolean }) {
  const tip = useTooltip();
  const tipText =
    AUTOPILOT_CONCEPT +
    (enabled
      ? '\n\n✅ On — runs automatically when you start an epic. Click to manage the setting.'
      : '\n\n🚧 Coming soon — ships disabled. Click to enable the experimental `aidlc.autopilot.enabled` setting.');
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => postMessage({ type: 'openAutopilotSetting' })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          postMessage({ type: 'openAutopilotSetting' });
        }
      }}
      onMouseEnter={tip.onMouseEnter}
      onMouseLeave={tip.onMouseLeave}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px] transition-colors',
        enabled
          ? 'border-border bg-card/50 hover:bg-accent'
          : 'border-dashed border-border bg-card/30 opacity-60 hover:opacity-100',
      )}
    >
      <Zap className={cn('h-3 w-3 shrink-0', enabled ? 'text-primary opacity-80' : 'text-muted-foreground')} />
      <span className={cn('shrink-0 truncate font-semibold max-w-[40%]', enabled ? 'text-primary' : 'text-muted-foreground')}>
        AIDLC Autopilot
      </span>
      <span className="truncate text-muted-foreground">· Auto-plan epics from your project context</span>
      <span
        className={cn(
          'ml-auto shrink-0 rounded-sm border px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wider',
          enabled
            ? 'border-primary/40 text-primary'
            : 'border-border text-muted-foreground',
        )}
      >
        {enabled ? 'On' : 'Coming soon'}
      </span>
      {tip.pos && <Tooltip pos={tip.pos} text={tipText} />}
    </div>
  );
}

function Footer({ hasFolder }: { hasFolder: boolean }) {
  const v = typeof window !== 'undefined' ? window.EXTENSION_VERSION : undefined;
  return (
    <div className="border-t border-sidebar-border px-3 py-2 text-center text-[10px] text-muted-foreground">
      {v && <span className="font-mono">v{v}</span>}
      {v && hasFolder && <span className="mx-1.5">·</span>}
      {hasFolder ? (
        <>
          <button
            type="button"
            onClick={() => postMessage({ type: 'openBuilder' })}
            className="hover:text-primary"
          >
            Builder
          </button>
          <span className="mx-1.5">·</span>
          <button
            type="button"
            onClick={() => postMessage({ type: 'refresh' })}
            className="hover:text-primary"
          >
            <RefreshCw className="inline h-2.5 w-2.5 align-text-bottom" /> Refresh
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => postMessage({ type: 'openProject' })}
          className="hover:text-primary"
        >
          Open Project
        </button>
      )}
    </div>
  );
}

// Suppress unused-import warning when GitBranch / Zap are not directly used
// (they may be used by future stat icons; keeping references to avoid churn).
const _ICON_REFS = { GitBranch, Zap };
void _ICON_REFS;
