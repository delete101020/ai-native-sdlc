import { useState, useEffect, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import {
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
  AlertTriangle,
  Search,
  Star,
  Archive,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  SidebarState,
  RecentEpicRef,
  TemplateRef,
  McpServerInfo,
  ActiveRun,
  AgentActivityMap,
  EpicIdPrefixSource,
} from '@/lib/types';
import { ConfirmModal } from './ConfirmModal';
import { SavePresetModal } from './SavePresetModal';
import { LoadDemoModal } from './LoadDemoModal';
import { ThemeToggle } from './ThemeToggle';
import { postMessage, getPersistedUi, setPersistedUi } from '@/lib/bridge';

interface CollapseState {
  workflows: boolean;
  mcpServers: boolean;
  setup: boolean;
  myEpics: boolean;
}

interface PersistedUi {
  collapsed?: Partial<CollapseState>;
}

const DEFAULT_COLLAPSED: CollapseState = {
  workflows: false,
  mcpServers: true,
  // Set once and left alone; the prefix warning is shown outside it.
  setup: true,
  myEpics: false,
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

  const setupNeeded = state.configExists && state.epicIdPrefixNeedsSetup;

  return (
    <aside className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Body */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {!state.hasFolder ? (
          <>
            <AskButton />
            <EmptyNoFolder demoProjectExists={state.demoProjectExists} />
          </>
        ) : (
          <>
            <ProjectBar workspaceName={state.workspaceName} configExists={state.configExists} extraProjects={state.extraProjects} />

            {/* The one setup item that is a problem rather than a preference
                stays in view until it is dealt with. */}
            {setupNeeded && (
              <EpicIdPrefixRow
                value={state.epicIdPrefix}
                source={state.epicIdPrefixSource}
                suggestion={state.epicIdPrefixSuggestion}
                needsSetup
              />
            )}

            {!state.configExists && (
              <div className="rounded-md border border-dashed border-border bg-surface/50 p-3 text-[11px] text-muted-foreground leading-relaxed">
                No <code className="rounded bg-primary/10 px-1 py-0.5 font-mono text-primary">workspace.yaml</code> yet — open the Builder from the title bar to scaffold one.
              </div>
            )}

            <PrimaryActions configExists={state.configExists} />

            {state.configExists && state.epicsCount > 0 && (
              <MyEpicsSection
                epics={state.myEpics}
                epicsCount={state.epicsCount}
                runs={state.activeRuns}
                activity={state.agentActivity ?? {}}
                collapsed={collapsed.myEpics}
                onToggle={() => toggleSection('myEpics')}
              />
            )}

            {state.configExists ? (
              <SectionShell
                label="Project setup"
                collapsed={collapsed.setup}
                onToggle={() => toggleSection('setup')}
              >
                <button
                  type="button"
                  onClick={() => postMessage({ type: 'openYaml' })}
                  className="flex w-full items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <FileCode2 className="h-3.5 w-3.5" />
                  <span>Open workspace.yaml</span>
                </button>
                <ArtifactLanguageRow value={state.artifactLanguage} />
                {!setupNeeded && (
                  <EpicIdPrefixRow
                    value={state.epicIdPrefix}
                    source={state.epicIdPrefixSource}
                    suggestion={state.epicIdPrefixSuggestion}
                    needsSetup={false}
                  />
                )}
                <WorkflowsSection
                  label="Workflow templates"
                  builtins={state.builtinTemplates}
                  project={state.projectTemplates}
                  configExists={state.configExists}
                  workspaceName={state.workspaceName}
                  collapsed={collapsed.workflows}
                  onToggle={() => toggleSection('workflows')}
                />
              </SectionShell>
            ) : (
              // Without a workspace.yaml a template is how one gets made, so the
              // list is the main event rather than a setting.
              <WorkflowsSection
                label="Workflows"
                builtins={state.builtinTemplates}
                project={state.projectTemplates}
                configExists={state.configExists}
                workspaceName={state.workspaceName}
                collapsed={collapsed.workflows}
                onToggle={() => toggleSection('workflows')}
              />
            )}

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
 * Start Epic, with Analyze Requirements beside it. Analyze needs no
 * workspace.yaml, so without one it is the only action and takes the row.
 */
function PrimaryActions({ configExists }: { configExists: boolean }) {
  const analyze = (
    <button
      type="button"
      onClick={() => postMessage({ type: 'openAnalyzeView' })}
      title="Analyze Requirements"
      className={cn(
        'flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted',
        !configExists && 'w-full',
      )}
    >
      <ListTree className="h-3.5 w-3.5 text-muted-foreground" />
      <span>{configExists ? 'Analyze' : 'Analyze Requirements'}</span>
      {!configExists && <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-50" />}
    </button>
  );
  if (!configExists) { return analyze; }
  return (
    <div className="flex gap-1.5">
      <button
        type="button"
        onClick={() => postMessage({ type: 'requestStartEpic' })}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <Play className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Start Epic</span>
      </button>
      {analyze}
    </div>
  );
}

/** A collapsible section whose body is plain children. */
function SectionShell({
  label,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <SectionHeader label={label} collapsed={collapsed} onToggle={onToggle} />
      {!collapsed && <div className="mt-1.5 space-y-1.5">{children}</div>}
    </div>
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
/**
 * The two letters that scope this checkout's epic ids.
 *
 * The row has two faces. Once `.aidlc/user.yaml` names a prefix it is the
 * quiet input it always was. Until then it is a warning, because the unset
 * state used to be an empty box with a "none" placeholder — indistinguishable
 * from a box someone had already looked at and left alone, which is how a
 * whole team ends up sharing one person's initials.
 *
 * Two things are deliberately *not* done here. A derived prefix is offered,
 * never applied: guessing someone's initials and stamping them on every epic
 * they open is the same mistake as inheriting a colleague's. And there is no
 * pop-up on activation — leaving the prefix unset is a legitimate choice for a
 * one-person repo, and nagging the people who made it correctly is worse than
 * a warning they can see when they look.
 */
function EpicIdPrefixRow({ value, source, suggestion, needsSetup }: {
  value: string | null;
  source: EpicIdPrefixSource;
  suggestion: string | null;
  needsSetup: boolean;
}) {
  // Unset rows open on the suggestion so accepting it is one click; set rows
  // open on the real value so the field never lies about what is in effect.
  const initial = needsSetup ? (suggestion ?? '') : (value ?? '');
  const [draft, setDraft] = useState(initial);
  useEffect(() => { setDraft(initial); }, [initial]);

  const invalid = draft !== '' && !/^[A-Za-z]{2}$/.test(draft);
  const save = (next: string) => {
    if (next !== '' && !/^[A-Za-z]{2}$/.test(next)) { return; }
    postMessage({ type: 'setEpicIdPrefix', prefix: next.toUpperCase() });
  };
  const commit = () => {
    if (invalid) { return; }
    const next = draft.toUpperCase();
    // While unset, committing the untouched suggestion is the whole point, so
    // this cannot short-circuit on "same as current" the way the settled row does.
    if (needsSetup || next !== (value ?? '')) { save(next); }
  };

  const field = (
    <input
      value={draft}
      maxLength={2}
      placeholder="none"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
      className={`w-14 rounded border bg-surface px-1.5 py-0.5 text-center text-[11px] uppercase text-foreground ${invalid ? 'border-destructive' : 'border-border'}`}
    />
  );

  if (!needsSetup) {
    return (
      <label
        className="flex w-full items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-2 text-xs text-muted-foreground"
        title="epic_id_prefix in .aidlc/user.yaml — two letters of your own, so a new epic is suggested as EPIC-260908-NG-001 instead of a number a colleague may already be using. This file is gitignored: your prefix stays yours. Clear it for plain EPIC-001."
      >
        <Fingerprint className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">Epic ID prefix</span>
        <span className="ml-auto">{field}</span>
      </label>
    );
  }

  return (
    <div className="w-full rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-foreground">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
        <span>No epic id prefix of your own</span>
      </div>
      <p className="mt-1 text-muted-foreground">
        {source === 'workspace' ? (
          <>
            <code className="font-mono text-foreground">{value}</code> comes from the shared{' '}
            <code className="font-mono">workspace.yaml</code>, so everyone who pulls it files
            their epics under it. Claim two letters of your own.
          </>
        ) : (
          <>New epics are named <code className="font-mono text-foreground">EPIC-001</code> — a
          number a colleague may already be using. Two letters of your own keep them apart.</>
        )}
      </p>
      <div className="mt-2 flex items-center gap-2">
        {field}
        <button
          type="button"
          onClick={commit}
          disabled={invalid || draft === ''}
          className="rounded-md border border-warning/50 bg-warning/20 px-2 py-1 text-[10.5px] font-semibold text-foreground transition-colors hover:bg-warning/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Use {draft.toUpperCase() || '—'}
        </button>
        {suggestion && (
          <span className="text-[10px] text-muted-foreground">from your git user.name</span>
        )}
      </div>
    </div>
  );
}

function AskButton() {
  // Always visible — the whole point is helping users understand the
  // extension and how to set it up, which matters most *before* a workspace
  // exists. Routes to the host `aidlcNative.ask` command (prompts → claude → preview).
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

const RUN_STEP_STATUS: Record<string, { label: string; cls: string }> = {
  awaiting_work: { label: 'Awaiting work', cls: 'border-warning/40 bg-warning/15 text-warning' },
  awaiting_auto_review: { label: 'Auto-review', cls: 'border-primary/40 bg-primary/15 text-primary' },
  awaiting_review: { label: 'Awaiting review', cls: 'border-primary/40 bg-primary/15 text-primary' },
  rejected: { label: 'Rejected', cls: 'border-destructive/40 bg-destructive/15 text-destructive' },
  pending: { label: 'Pending', cls: 'border-border bg-secondary text-muted-foreground' },
  approved: { label: 'Approved', cls: 'border-success/40 bg-success/15 text-success' },
};

function runStatus(run: ActiveRun): { label: string; cls: string } {
  return RUN_STEP_STATUS[run.currentStepStatus] ?? {
    label: run.currentStepStatus || 'unknown',
    cls: 'border-border bg-secondary text-muted-foreground',
  };
}

function openEpicHandlers(id: string) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    title: `Open ${id} in the Epics view`,
    onClick: () => postMessage({ type: 'openEpic', id }),
    onKeyDown: (ev: React.KeyboardEvent) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        postMessage({ type: 'openEpic', id });
      }
    },
  };
}

/** The row opens the epic; its buttons must not also do that. */
function epicAction(type: 'toggleWatchEpic', id: string) {
  return (ev: ReactMouseEvent) => {
    ev.stopPropagation();
    postMessage({ type, id });
  };
}

function EpicRow({
  epic: e,
  run,
  activity,
}: {
  epic: RecentEpicRef;
  run: ActiveRun | undefined;
  activity: AgentActivityMap;
}) {
  const busy = run ? (activity[run.runId]?.length ?? 0) > 0 : false;
  const status = run ? runStatus(run) : null;
  return (
    <div
      {...openEpicHandlers(e.id)}
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5 text-[11px] transition-colors hover:bg-accent',
        e.archived && 'border-dashed opacity-60 hover:opacity-100',
      )}
    >
      <EpicDot status={e.status} />
      <span className="shrink-0 font-mono text-[10px] font-bold text-primary">{e.id}</span>
      {e.archived && (
        <Archive className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Archived" />
      )}
      {e.title && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={e.step || undefined}>· {e.title}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {busy && <Loader2 className="h-3 w-3 animate-spin text-primary" aria-label="Agent running" />}
        {status && run && (
          <span
            className={cn('rounded-full border px-1.5 py-px text-[8.5px] font-bold uppercase tracking-wider group-hover:hidden', status.cls)}
            title={`${status.label} · step ${run.currentStepIdx + 1}/${run.totalSteps} · ${run.currentAgent}`}
          >
            {status.label}
          </span>
        )}
        <WatchButton epic={e} />
      </span>
    </div>
  );
}

/** Shown while set, so the row says so; otherwise only on hover. */
function WatchButton({ epic: e }: { epic: RecentEpicRef }) {
  return (
    <button
      type="button"
      onClick={epicAction('toggleWatchEpic', e.id)}
      title={e.watched ? 'Stop watching' : 'Watch — list under My epics'}
      className={cn(
        'hover:text-primary',
        e.watched ? 'inline-flex text-warning' : 'hidden text-muted-foreground group-hover:inline-flex',
      )}
    >
      <Star className={cn('h-3 w-3', e.watched && 'fill-current')} />
    </button>
  );
}

/** Rows shown before "Show N more". */
const MY_EPICS_LIMIT = 8;

/**
 * The epics this user watches (`watched_epics` in `.aidlc/user.yaml`), in the
 * order the Epics view is sorted by, so the two never disagree about which
 * comes first. The Go to Epic picker (Ctrl+Alt+E) is the way to everything
 * else. A run shows on its epic's row; there is no separate runs list.
 */
function MyEpicsSection({
  epics,
  epicsCount,
  runs,
  activity,
  collapsed,
  onToggle,
}: {
  epics: RecentEpicRef[];
  epicsCount: number;
  runs: ActiveRun[];
  activity: AgentActivityMap;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? epics : epics.slice(0, MY_EPICS_LIMIT);
  const runFor = (id: string) => runs.find((r) => r.epicId === id);
  return (
    <div>
      <SectionHeader
        label="My epics"
        collapsed={collapsed}
        onToggle={onToggle}
        trailing={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => postMessage({ type: 'goToEpic' })}
              title="Go to Epic… (Ctrl+Alt+E)"
              className="text-muted-foreground hover:text-primary"
            >
              <Search className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => postMessage({ type: 'openEpicsList' })}
              className="text-[10px] text-muted-foreground hover:text-primary"
            >
              All {epicsCount} →
            </button>
          </div>
        }
      />
      {!collapsed && (
        <div className="mt-1.5 space-y-1">
          {epics.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-2.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
              <Star className="mr-1 inline h-3 w-3 align-text-bottom" />
              Star the epics you want to keep an eye on from a card in the Epics view, or find one with Go to Epic.
            </div>
          ) : (
            shown.map((e) => (
              <EpicRow key={e.id} epic={e} run={runFor(e.id)} activity={activity} />
            ))
          )}
          {epics.length > MY_EPICS_LIMIT && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="w-full rounded-md py-1 text-center text-[10px] text-muted-foreground hover:bg-accent hover:text-primary"
            >
              {showAll ? 'Show less' : `Show ${epics.length - MY_EPICS_LIMIT} more`}
            </button>
          )}
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
  // The section starts shut, so a server that needs attention says so on the header.
  const troubled = servers?.filter((s) => s.status === 'failed' || s.status === 'needs_auth').length ?? 0;
  return (
    <div>
      <SectionHeader
        label="MCP servers"
        collapsed={collapsed}
        onToggle={onToggle}
        trailing={
          <div className="flex items-center gap-1.5">
            {troubled > 0 && (
              <span
                className="flex items-center gap-0.5 text-[10px] text-warning"
                title={`${troubled} server${troubled === 1 ? '' : 's'} failed or need${troubled === 1 ? 's' : ''} auth`}
              >
                <AlertTriangle className="h-3 w-3" />
                {troubled}
              </span>
            )}
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
  label,
  builtins,
  project,
  configExists,
  workspaceName,
  collapsed,
  onToggle,
}: {
  label: string;
  builtins: TemplateRef[];
  project: TemplateRef[];
  configExists: boolean;
  workspaceName: string;
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
      <SectionHeader label={label} collapsed={collapsed} onToggle={onToggle} />
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


function Footer({ hasFolder }: { hasFolder: boolean }) {
  const v = typeof window !== 'undefined' ? window.EXTENSION_VERSION : undefined;
  return (
    <div className="flex items-center justify-center border-t border-sidebar-border px-3 py-2 text-[10px] text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
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
      </span>
      <ThemeToggle />
    </div>
  );
}

// Suppress unused-import warning when GitBranch / Zap are not directly used
// (they may be used by future stat icons; keeping references to avoid churn).
const _ICON_REFS = { GitBranch, Zap };
void _ICON_REFS;
