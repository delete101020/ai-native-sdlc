import { useEffect, useState, useMemo } from 'react';
import { Plus, Brain, FolderOpen, Pencil, Radio, ChevronRight, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkspaceState, EpicSummary, EpicFilter } from '@/lib/types';
import { EpicCard } from './EpicCard';
import { StartEpicModal } from './StartEpicModal';
import { ReportSignalModal } from './ReportSignalModal';
import { postMessage, onHostMessage } from '@/lib/bridge';

const FILTERS: { id: EpicFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'pending', label: 'Pending' },
  { id: 'done', label: 'Done' },
  { id: 'failed', label: 'Failed' },
];

function matches(epic: EpicSummary, filter: EpicFilter): boolean {
  if (filter === 'all') { return true; }
  return epic.status === filter;
}

/**
 * The epic this one was opened from, or null.
 *
 * `from_epic` is written into inputs.json by `openFollowUpEpic` — the only
 * parent/child edge the system records, and it costs nothing to draw. A generic
 * `group` field on state.json would need someone to fill it in; this one is
 * already true on disk for every incident that produced work.
 */
function parentOf(epic: EpicSummary): string | null {
  const from = (epic.inputs?.from_epic ?? '').trim();
  return from || null;
}

/** Root of the family an epic belongs to — itself, unless it follows another. */
function familyOf(epic: EpicSummary): string {
  return parentOf(epic) ?? epic.id;
}

/** One rendered row: a lone epic, or an incident and everything it opened. */
interface Family {
  rootId: string;
  epics: EpicSummary[];
}

export function EpicsView({
  state,
  focusEpic,
}: {
  state: WorkspaceState;
  /** Epic the sidebar deep-linked to; `nonce` changes on every click. */
  focusEpic?: { id: string; nonce: number } | null;
}) {
  const [filter, setFilter] = useState<EpicFilter>('all');
  const [startEpicOpen, setStartEpicOpen] = useState(false);
  const [reportSignalOpen, setReportSignalOpen] = useState(false);
  // Focus comes from two places now: the host deep link, and the incident ⇄
  // follow-up chips on the cards themselves. Both land here so the scroll,
  // the expand and the filter reset behave identically either way.
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => { if (focusEpic) { setFocus(focusEpic); } }, [focusEpic]);

  // A deep link has to win over the filter — landing on an empty list because
  // the epic is done and the filter says "in progress" reads as a broken link.
  useEffect(() => {
    if (focus) { setFilter('all'); }
  }, [focus]);

  useEffect(() => {
    return onHostMessage((msg) => {
      if (msg.type === 'triggerStartEpic' || msg.type === 'openStartEpicModal') {
        setStartEpicOpen(true);
      }
      if (msg.type === 'openReportSignalModal') {
        setReportSignalOpen(true);
      }
    });
  }, []);

  const counts = useMemo(() => {
    const out: Record<EpicFilter, number> = {
      all: state.epics.length,
      in_progress: 0,
      pending: 0,
      done: 0,
      failed: 0,
    };
    for (const e of state.epics) { out[e.status] = (out[e.status] ?? 0) + 1; }
    return out;
  }, [state.epics]);

  const visible = useMemo(
    () => state.epics.filter((e) => matches(e, filter)),
    [state.epics, filter],
  );

  /** epic id → epics opened from it. Read by the cards to draw the link back. */
  const followUpsByEpic = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const e of state.epics) {
      const from = parentOf(e);
      if (from) { (out[from] ??= []).push(e.id); }
    }
    return out;
  }, [state.epics]);

  // Group after filtering, not before: a filter is a question about epics, and
  // hiding a follow-up should not drag its incident out of the list with it.
  const families = useMemo(() => {
    const out: Family[] = [];
    const at = new Map<string, number>();
    for (const e of visible) {
      const key = familyOf(e);
      const i = at.get(key);
      if (i === undefined) { at.set(key, out.length); out.push({ rootId: key, epics: [e] }); }
      else { out[i].epics.push(e); }
    }
    // The incident leads its own family wherever it happened to sort.
    for (const f of out) {
      f.epics.sort((a, b) => Number(b.id === f.rootId) - Number(a.id === f.rootId));
    }
    return out;
  }, [visible]);

  const navigate = (id: string) => {
    const target = state.epics.find((e) => e.id === id);
    // Following a link into a collapsed family and landing on nothing is the
    // one way this chip can lie.
    if (target) { setCollapsed((c) => ({ ...c, [familyOf(target)]: false })); }
    setFocus({ id, nonce: Date.now() });
  };

  const [editingDir, setEditingDir] = useState(false);
  const [dirDraft, setDirDraft] = useState(state.epicsDir);

  useEffect(() => { setDirDraft(state.epicsDir); }, [state.epicsDir]);

  const commitDirChange = () => {
    const val = dirDraft.trim();
    if (val && val !== state.epicsDir) {
      postMessage({ type: 'changeEpicsDir', dir: val });
    }
    setEditingDir(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">AIDLC Epics</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <FolderOpen className="h-3 w-3 shrink-0" />
            {editingDir ? (
              <span className="flex items-center gap-1">
                <input
                  type="text"
                  value={dirDraft}
                  autoFocus
                  onChange={(e) => setDirDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitDirChange(); }
                    if (e.key === 'Escape') { setEditingDir(false); setDirDraft(state.epicsDir); }
                  }}
                  onBlur={commitDirChange}
                  className="w-40 rounded border border-border bg-input/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <span className="font-mono text-[11px]">{state.epicsDir}</span>
                <button
                  type="button"
                  onClick={() => setEditingDir(true)}
                  title="Edit epics directory"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Pencil className="h-2.5 w-2.5" />
                </button>
                <button
                  type="button"
                  onClick={() => postMessage({ type: 'browseEpicsDir' })}
                  title="Browse for epics directory"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <FolderOpen className="h-2.5 w-2.5" />
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => postMessage({ type: 'refresh' })}
            title="Re-read the epics from disk. The panel follows file changes on its own; this is the way back when it hasn't — an epic folder removed outside the editor, or a deletion whose watcher event never arrived."
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </button>
          <button
            type="button"
            onClick={() =>
              postMessage({ type: 'toggleEpicMemoryHook', enabled: !state.epicMemoryHookEnabled })
            }
            title={
              state.epicMemoryHookEnabled
                ? 'Epic-memory auto-load is ON — prompts mentioning an epic auto-load its memory. Click to turn off.'
                : 'Turn ON epic-memory auto-load — a Claude Code hook injects an epic’s memory whenever a prompt refers to it.'
            }
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors',
              state.epicMemoryHookEnabled
                ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                : 'border-border bg-card text-muted-foreground hover:text-foreground',
            )}
          >
            <Brain className="h-3.5 w-3.5" />
            Memory auto-load: {state.epicMemoryHookEnabled ? 'On' : 'Off'}
          </button>
          <button
            type="button"
            onClick={() => setReportSignalOpen(true)}
            title="Something broke in production — record the signal and open an incident epic that diagnoses it (stage 6)."
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Radio className="h-3.5 w-3.5" />
            Report signal
          </button>
          <button
            type="button"
            onClick={() => setStartEpicOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            Start Epic
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
              filter === f.id
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-accent',
            )}
          >
            {f.label}
            <span
              className={cn(
                'text-[10px] tabular-nums',
                filter === f.id ? 'text-primary-foreground/70' : 'text-muted-foreground',
              )}
            >
              {counts[f.id]}
            </span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface/50 p-6 text-center text-xs text-muted-foreground">
          {filter === 'all' ? 'No epics yet.' : `No ${filter.replace('_', ' ')} epics.`}
        </div>
      ) : (
        <div className="space-y-2">
          {families.map((f) => {
            const cards = f.epics.map((e) => (
              <EpicCard
                key={e.id}
                epic={e}
                agentMeta={state.agentMeta}
                slashCommandsByAgent={state.slashCommandsByAgent}
                focusNonce={focus?.id === e.id ? focus.nonce : 0}
                // Keyed by run id, and an epic's run id is the epic id by
                // convention — but read it off the epic rather than assuming.
                activity={(e.runId && state.agentActivity?.[e.runId]) || null}
                fromEpic={parentOf(e)}
                followUps={followUpsByEpic[e.id] ?? []}
                onNavigate={navigate}
              />
            ));
            // A family of one is just an epic. Wrapping it in a header would
            // add a row of chrome around every epic in the list to serve the
            // handful that were opened from an incident.
            if (f.epics.length < 2) { return cards; }

            const root = f.epics.find((e) => e.id === f.rootId);
            // Finished families fold themselves away: an incident and its fix,
            // both done, is history — it should not cost four rows forever.
            const isCollapsed = collapsed[f.rootId] ?? f.epics.every((e) => e.status === 'done');
            return (
              <div key={f.rootId} className="rounded-lg border border-border/70 bg-surface/40">
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [f.rootId]: !isCollapsed }))}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left"
                >
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                      !isCollapsed && 'rotate-90',
                    )}
                  />
                  <span className="shrink-0 font-mono text-[11px] font-bold text-primary">
                    {f.rootId}
                  </span>
                  {root && (
                    <span className="truncate text-[11px] text-muted-foreground">{root.title}</span>
                  )}
                  <span className="ml-auto shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {f.epics.length} epics
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="space-y-2 border-t border-border/60 px-3 py-3">{cards}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {startEpicOpen && (
        <StartEpicModal
          pipelines={state.pipelines}
          recipes={state.recipes ?? []}
          agentMeta={state.agentMeta}
          nextEpicId={state.nextEpicId}
          epicIdPrefixNeedsSetup={state.epicIdPrefixNeedsSetup}
          epicIdPrefixSuggestion={state.epicIdPrefixSuggestion}
          existingEpicIds={state.existingEpicIds}
          epicsDir={state.epicsDir}
          isFirstEpic={state.epics.length === 0}
          workspaceName={state.workspaceName}
          onReportSignal={() => setReportSignalOpen(true)}
          onSubmit={(draft) => postMessage({ type: 'startEpicInline', draft })}
          onClose={() => setStartEpicOpen(false)}
        />
      )}

      {reportSignalOpen && (
        <ReportSignalModal
          existingEpicIds={state.existingEpicIds}
          onClose={() => setReportSignalOpen(false)}
        />
      )}
    </div>
  );
}
