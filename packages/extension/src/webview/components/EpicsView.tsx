import { useEffect, useState, useMemo } from 'react';
import { Plus, Brain, FolderOpen, Pencil, Radio, ChevronRight, RefreshCw, Tag as TagIcon, X, ArrowDownUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkspaceState, EpicSummary, EpicFilter, FollowUpContext } from '@/lib/types';
import { EpicCard } from './EpicCard';
import { StartEpicModal } from './StartEpicModal';
import { ReportSignalModal } from './ReportSignalModal';
import { postMessage, onHostMessage } from '@/lib/bridge';
import { EPIC_SORTS, DEFAULT_EPIC_SORT, isEpicSort, sortEpics, type EpicSort } from '@/lib/epicSort';

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
 * Tag filtering is AND, not OR: each tag clicked narrows the list.
 *
 * OR is the other plausible reading, and it is the wrong one here — tags on an
 * epic are facets (a theme, a release, a squad), so "PAYMENT + RELEASE-Q3" is a
 * question someone actually asks and "PAYMENT or RELEASE-Q3" is one nobody does.
 * It is also the behaviour of every tracker these tags are borrowed from.
 */
function matchesTags(epic: EpicSummary, wanted: string[]): boolean {
  if (wanted.length === 0) { return true; }
  const have = epic.tags ?? [];
  return wanted.every((t) => have.includes(t));
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
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  // The host keeps the order: this webview's own state dies with the panel.
  const [sort, setSort] = useState<EpicSort>(() => {
    const saved = state.epicSortPref?.sort;
    return isEpicSort(saved) ? saved : DEFAULT_EPIC_SORT;
  });
  const [sortReversed, setSortReversed] = useState<boolean>(
    () => state.epicSortPref?.reversed === true,
  );
  const persistSort = (next: { sort: EpicSort; reversed: boolean }) => {
    postMessage({ type: 'setEpicSort', ...next });
  };
  const prefix = state.epicIdPrefix ?? null;
  // "My epics" with no prefix would silently read as "Created"; fall back so
  // the picker never claims an order the list is not in.
  const effectiveSort: EpicSort = sort === 'mine' && !prefix ? DEFAULT_EPIC_SORT : sort;
  const [startEpicOpen, setStartEpicOpen] = useState(false);
  // Set while Start Epic is open as "New follow-up of <parent>" — cleared on close
  // so the header's plain Start Epic never inherits a parent.
  const [followUp, setFollowUp] = useState<FollowUpContext | null>(null);
  const [reportSignalOpen, setReportSignalOpen] = useState(false);
  // Focus comes from two places now: the host deep link, and the incident ⇄
  // follow-up chips on the cards themselves. Both land here so the scroll,
  // the expand and the filter reset behave identically either way.
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Deep links unfold the family they land in. Families start folded, so
  // without this the sidebar would scroll to a card that is not rendered.
  useEffect(() => {
    if (!focusEpic) { return; }
    const target = state.epics.find((e) => e.id === focusEpic.id);
    if (target) { setCollapsed((c) => ({ ...c, [familyOf(target)]: false })); }
    setFocus(focusEpic);
    // Deliberately keyed on the link alone: re-running when `state.epics`
    // changes would re-open a family the user had just folded shut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEpic]);

  // A deep link has to win over the filter — landing on an empty list because
  // the epic is done and the filter says "in progress" reads as a broken link.
  useEffect(() => {
    if (focus) { setFilter('all'); setTagFilter([]); }
  }, [focus]);

  // A tag that no epic carries any more (its last epic was retagged or deleted)
  // would otherwise stay selected and hide everything, with no chip left to
  // click to undo it.
  useEffect(() => {
    const live = new Set(state.epics.flatMap((e) => e.tags ?? []));
    setTagFilter((cur) => (cur.every((t) => live.has(t)) ? cur : cur.filter((t) => live.has(t))));
  }, [state.epics]);

  useEffect(() => {
    return onHostMessage((msg) => {
      if (msg.type === 'triggerStartEpic' || msg.type === 'openStartEpicModal') {
        setFollowUp(null);
        setStartEpicOpen(true);
      }
      if (msg.type === 'openFollowUpModal' && msg.followUp && typeof msg.followUp === 'object') {
        setFollowUp(msg.followUp as FollowUpContext);
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

  // Sorted before grouping: a family takes the place of whichever of its
  // epics sorts first, so one follow-up awaiting review lifts its incident.
  const visible = useMemo(
    () => sortEpics(
      state.epics.filter((e) => matches(e, filter) && matchesTags(e, tagFilter)),
      effectiveSort,
      sortReversed,
      prefix,
    ),
    [state.epics, filter, tagFilter, effectiveSort, sortReversed, prefix],
  );

  /**
   * Every tag in use, with how many epics carry it — counted against the status
   * filter so the numbers describe the list the user is looking at. Ordered by
   * count, then alphabetically: the themes an epic is most likely to belong to
   * sit where the eye already is.
   */
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of state.epics) {
      if (!matches(e, filter)) { continue; }
      for (const t of e.tags ?? []) { counts.set(t, (counts.get(t) ?? 0) + 1); }
    }
    // A selected tag always keeps its chip, even when the status filter has
    // narrowed its count to zero — it is the only way back out of that state.
    for (const t of tagFilter) { if (!counts.has(t)) { counts.set(t, 0); } }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [state.epics, filter, tagFilter]);

  const allTags = useMemo(
    () => [...new Set(state.epics.flatMap((e) => e.tags ?? []))].sort(),
    [state.epics],
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
    // The incident leads its own family wherever it happened to sort; its
    // follow-ups read in id order (natural, so -W2 comes before -W10) rather
    // than newest first, since they are siblings of one batch, not a timeline.
    for (const f of out) {
      f.epics.sort((a, b) =>
        Number(b.id === f.rootId) - Number(a.id === f.rootId)
        || a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }));
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
            onClick={() => { setFollowUp(null); setStartEpicOpen(true); }}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            Start Epic
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
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
        <div className="ml-auto flex items-center gap-1">
          <select
            aria-label="Sort epics"
            value={effectiveSort}
            onChange={(e) => {
              const next = e.target.value as EpicSort;
              setSort(next);
              persistSort({ sort: next, reversed: sortReversed });
            }}
            title={EPIC_SORTS.find((s) => s.id === effectiveSort)?.hint}
            className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
          >
            {EPIC_SORTS.map((s) => (
              <option
                key={s.id}
                value={s.id}
                disabled={s.id === 'mine' && !prefix}
                title={s.id === 'mine' && !prefix ? 'Set an epic ID prefix to tell your epics apart' : s.hint}
              >
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              const next = !sortReversed;
              setSortReversed(next);
              persistSort({ sort, reversed: next });
            }}
            title={sortReversed ? 'Reversed order — click for the default' : 'Reverse the order'}
            aria-pressed={sortReversed}
            className={cn(
              'inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors',
              sortReversed
                ? 'border-primary bg-primary/15 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            <ArrowDownUp className="h-3 w-3" />
          </button>
        </div>
      </div>

      {tagCounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <TagIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          {tagCounts.map(([tag, count]) => {
            const on = tagFilter.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() =>
                  setTagFilter((cur) => (on ? cur.filter((t) => t !== tag) : [...cur, tag]))
                }
                title={on ? `Stop filtering by ${tag}` : `Show only epics tagged ${tag}`}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-wide transition-colors',
                  on
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
                )}
              >
                {tag}
                <span className={cn('font-sans text-[9.5px] tabular-nums', on ? 'text-primary/70' : 'text-muted-foreground/70')}>
                  {count}
                </span>
              </button>
            );
          })}
          {tagFilter.length > 0 && (
            <button
              type="button"
              onClick={() => setTagFilter([])}
              title="Clear the tag filter"
              className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <X className="h-2.5 w-2.5" />
              Clear
            </button>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface/50 p-6 text-center text-xs text-muted-foreground">
          {tagFilter.length > 0
            ? `No epics tagged ${tagFilter.join(' + ')}${filter === 'all' ? '' : ` in ${filter.replace('_', ' ')}`}.`
            : filter === 'all' ? 'No epics yet.' : `No ${filter.replace('_', ' ')} epics.`}
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
                // A list: a DAG can have an agent on each of its open steps.
                activities={(e.runId && state.agentActivity?.[e.runId]) || []}
                fromEpic={parentOf(e)}
                followUps={followUpsByEpic[e.id] ?? []}
                onNavigate={navigate}
                tagSuggestions={allTags}
                onTagClick={(tag) =>
                  setTagFilter((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]))
                }
              />
            ));
            // A family of one is just an epic. Wrapping it in a header would
            // add a row of chrome around every epic in the list to serve the
            // handful that were opened from an incident.
            if (f.epics.length < 2) { return cards; }

            const root = f.epics.find((e) => e.id === f.rootId);
            const running = f.epics.filter((e) => e.status === 'in_progress').length;
            const failed = f.epics.filter((e) => e.status === 'failed').length;
            // Folded until asked. An incident that opened three follow-ups is
            // one thing that happened, and unfolding all of them by default
            // buries every other epic in the list under it — so the header row
            // stands in for the family and says what is still moving inside.
            const isCollapsed = collapsed[f.rootId] ?? true;
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
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {running > 0 && (
                      <span className="rounded-full border border-info/30 bg-info/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-info">
                        {running} running
                      </span>
                    )}
                    {failed > 0 && (
                      <span className="rounded-full border border-destructive/30 bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                        {failed} failed
                      </span>
                    )}
                    <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {f.epics.length} epics
                    </span>
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
          // Keyed so switching between a plain start and a follow-up remounts
          // the form: its fields are seeded once, from the props at mount.
          key={followUp?.epicId ?? 'start'}
          followUp={followUp ?? undefined}
          pipelines={state.pipelines}
          recipes={state.recipes ?? []}
          agentMeta={state.agentMeta}
          nextEpicId={state.nextEpicId}
          epicIdPrefixNeedsSetup={state.epicIdPrefixNeedsSetup}
          epicIdPrefixSuggestion={state.epicIdPrefixSuggestion}
          existingEpicIds={state.existingEpicIds}
          existingTags={allTags}
          epicsDir={state.epicsDir}
          isFirstEpic={state.epics.length === 0}
          workspaceName={state.workspaceName}
          onReportSignal={() => setReportSignalOpen(true)}
          onSubmit={(draft) => postMessage({ type: 'startEpicInline', draft })}
          onClose={() => { setStartEpicOpen(false); setFollowUp(null); }}
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
