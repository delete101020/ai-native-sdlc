import { useEffect, useRef, useState } from 'react';
import { ClampedNote } from './ClampedNote';
import {
  ChevronRight,
  ChevronDown,
  CornerDownRight,
  GitBranchPlus,
  Check,
  X,
  Inbox,
  Outdent,
  FileText,
  Terminal,
  Copy,
  Bot,
  User,
  ExternalLink,
  Eye,
  Highlighter,
  Brain,
  Folder,
  FolderOpen,
  Github,
  Play,
  History,
  RefreshCw,
  RotateCcw,
  Zap,
  AlertTriangle,
  ShieldCheck,
  ClipboardList,
  Trash2,
  Gauge,
  Loader2,
  Workflow,
  Undo2,
  Tag as TagIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  EpicSummary,
  EpicStepDetailFull,
  AgentMeta,
  StepHistoryEntry,
  StepStatus,
  UiStatus,
  AgentActivity,
} from '@/lib/types';
import { StatusBadge } from './StatusBadge';
import { TagInput } from './TagInput';
import { normalizeTags } from '@/lib/tags';
import { RejectModal } from './RejectModal';
import { RerunModal } from './RerunModal';
import { RunWithFeedbackModal } from './RunWithFeedbackModal';
import { RequestUpdateModal } from './RequestUpdateModal';
import { RerunStepModal } from './RerunStepModal';
import { DeleteEpicModal } from './DeleteEpicModal';
import { ConfirmModal } from './ConfirmModal';
import { AgentRunningBanner } from './AgentRunningBanner';
import { AutoRunModal } from './AutoRunModal';
import { postMessage } from '@/lib/bridge';

function fmtCost(c: number): string {
  if (c >= 100) return `$${c.toFixed(0)}`;
  if (c >= 10) return `$${c.toFixed(1)}`;
  return `$${c.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function epicUiStatus(status: EpicSummary['status']): UiStatus {
  switch (status) {
    case 'in_progress':
      return 'in_progress';
    case 'done':
      return 'done';
    case 'failed':
      return 'rejected';
    default:
      return 'pending';
  }
}

function runStatusUi(status: StepStatus | null): UiStatus | null {
  if (!status || status === 'pending' || status === 'approved') { return null; }
  if (status === 'awaiting_work') { return 'awaiting_work'; }
  if (status === 'awaiting_auto_review' || status === 'awaiting_review') { return 'awaiting_review'; }
  if (status === 'rejected') { return 'rejected'; }
  return null;
}

const STEP_LABEL: Record<EpicStepDetailFull['status'], string> = {
  pending: 'pending',
  in_progress: 'in progress',
  done: 'done',
  failed: 'failed',
};

interface Props {
  epic: EpicSummary;
  agentMeta: Record<string, AgentMeta>;
  slashCommandsByAgent: Record<string, string>;
  /**
   * Non-zero when the sidebar deep-linked to this epic; a *new* value each
   * click, so opening the same epic twice re-expands and re-scrolls instead of
   * appearing to do nothing the second time.
   */
  focusNonce?: number;
  /**
   * The agents this window dispatched for the epic's run that are still
   * working — one entry per step, because a DAG opens its parallel steps
   * together and each can have its own agent on it. An empty list covers both
   * "idle" and "running somewhere we cannot see": the UI adds a busy state
   * from this, it never infers an idle one.
   */
  activities?: AgentActivity[];
  /** The incident this epic was opened from (`from_epic` in inputs.json). */
  fromEpic?: string | null;
  /** Epics opened from this one — an incident's fix, or a manifest's children. */
  followUps?: string[];
  /** Jump the list to another epic — expands it, scrolls to it, highlights it. */
  onNavigate?: (epicId: string) => void;
  /** Every tag in use in the workspace — offered while editing this epic's. */
  tagSuggestions?: string[];
  /** Filter the list by a tag the user clicked on this card. */
  onTagClick?: (tag: string) => void;
}

/**
 * What the percentage is counted in. The bar measures stages, not steps —
 * steps that run as peers share one — so a card showing "3/9 steps done" next
 * to 33% needs to say where the 33% came from.
 */
function progressTitle(epic: EpicSummary): string {
  const total = epic.stepDetails.length;
  const done = epic.stepDetails.filter((s) => s.status === 'done').length;
  if (typeof epic.stages !== 'number' || epic.stages === 0) {
    return `${done} of ${total} steps done`;
  }
  const stagesDone = Math.round((epic.stagesDone ?? 0) * 10) / 10;
  return epic.stages === total
    ? `${done} of ${total} steps done`
    : `${stagesDone} of ${epic.stages} stages done — ${done} of ${total} steps, `
      + 'with steps that run as peers counting as one stage, done once any of them is';
}

export function EpicCard({
  epic,
  agentMeta,
  slashCommandsByAgent,
  focusNonce = 0,
  activities = [],
  fromEpic = null,
  followUps = [],
  onNavigate,
  tagSuggestions = [],
  onTagClick,
}: Props) {
  const [expanded, setExpanded] = useState<boolean>(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusNonce) { return; }
    setExpanded(true);
    // The list can be long and the panel may have just switched views, so the
    // card is rarely on screen already.
    cardRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusNonce]);

  const [focusedIdx, setFocusedIdx] = useState<number>(epic.currentStep ?? 0);

  // The stepper reads epic.currentStep, which is live; the body reads
  // focusedIdx, which was only ever seeded at mount. So approving a step moved
  // the highlight and left the panel showing the step that had just been
  // approved. Follow the run, but only while the user is actually following it
  // — someone who clicked back to an earlier step stays where they parked.
  const followedStep = useRef<number>(epic.currentStep ?? 0);
  useEffect(() => {
    const next = epic.currentStep ?? 0;
    if (next === followedStep.current) { return; }
    setFocusedIdx((idx) => (idx === followedStep.current ? next : idx));
    followedStep.current = next;
  }, [epic.currentStep]);

  // Which steps have an agent on them right now, for the stepper's spinner.
  // An unattributed dispatch (`stepIdx: null`) names no step, so it marks none.
  const busySteps = new Set(
    activities.map((a) => a.stepIdx).filter((idx): idx is number => idx !== null),
  );

  const ui = epicUiStatus(epic.status);
  const total = epic.stepDetails.length;
  const done = epic.stepDetails.filter((s) => s.status === 'done').length;
  const focused = total > 0 ? epic.stepDetails[focusedIdx] : null;
  const inputKeys = Object.keys(epic.inputs || {});

  return (
    <div
      ref={cardRef}
      className={cn(
        'group relative rounded-lg border bg-card transition-all hover:border-primary/30',
        // Says *which* card the click landed on — after a scroll the reader
        // has no other way to tell the deep-linked one from its neighbours.
        focusNonce ? 'border-primary/60 ring-1 ring-primary/40' : 'border-border',
      )}
    >
      <div
        className={cn(
          'absolute left-0 top-0 h-full w-0.5 rounded-l-lg',
          epic.status === 'in_progress' && 'bg-primary',
          epic.status === 'done' && 'bg-success',
          epic.status === 'failed' && 'bg-destructive',
          epic.status === 'pending' && 'bg-muted-foreground',
        )}
      />

      <div className="flex items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="shrink-0 font-mono text-xs font-bold text-primary">{epic.id}</span>
          <span className="truncate text-sm text-foreground">{epic.title}</span>
          <EpicLinks fromEpic={fromEpic} followUps={followUps} onNavigate={onNavigate} />
          <TagChips tags={epic.tags ?? []} onTagClick={onTagClick} />
          {(epic.followUpHookFailures?.length ?? 0) > 0 && (
            <span
              title="A follow-up hook failed — expand the card for its error, then Sync follow-ups."
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              hook failed
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex items-center gap-1.5" title={progressTitle(epic)}>
            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-secondary">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  epic.status === 'done' ? 'bg-success' : 'bg-primary',
                )}
                style={{ width: `${epic.progress}%` }}
              />
            </div>
            <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
              {epic.progress}%
            </span>
          </div>
          {epic.tokenUsage && epic.tokenUsage.total.calls > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
              title={
                `${fmtTokens(epic.tokenUsage.total.totalTokens)} tokens · ${epic.tokenUsage.total.calls} calls · ${fmtCost(epic.tokenUsage.total.cost)} API equiv` +
                (epic.tokenUsage.hasOverlap ? ' · ⚠ overlaps with another run in this project — totals may double-count' : '')
              }
            >
              <Zap className="h-3 w-3" />
              {fmtTokens(epic.tokenUsage.total.totalTokens)}
              {epic.tokenUsage.hasOverlap && (
                <AlertTriangle className="h-3 w-3 text-warning" aria-label="Overlap warning" />
              )}
            </span>
          )}
          <StatusBadge status={ui} />
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
            aria-label={expanded ? 'Collapse epic' : 'Expand epic'}
          >
            <ChevronRight
              className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')}
            />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-border px-5 py-4">
          <EpicDescription epic={epic} />

          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            {epic.pipeline && (
              <span>
                Pipeline:{' '}
                <strong className="text-foreground">{epic.pipeline}</strong>
              </span>
            )}
            {!epic.pipeline && epic.agent && (
              <span>
                Agent: <strong className="text-foreground">{epic.agent}</strong>
              </span>
            )}
            {epic.artifactsOnly && (
              <span
                title="No pipeline binding — this epic's steps were derived from the .md files in its artifacts/ folder."
                className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
              >
                Artifacts only
              </span>
            )}
            {total > 0 && (
              <span>
                · <strong className="text-foreground">{done}/{total}</strong> steps done
              </span>
            )}
            {!epic.artifactsOnly && <DepthBadge epic={epic} />}
            {!epic.artifactsOnly && (
              <TagsEditor epic={epic} suggestions={tagSuggestions} onTagClick={onTagClick} />
            )}
            {epic.createdAt && (
              <span>
                · Started{' '}
                <strong className="text-foreground">{epic.createdAt.slice(0, 10)}</strong>
              </span>
            )}
            {epic.runId && (
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  title="Re-check this run's produced artifacts still exist and pass content assertions"
                  onClick={() => postMessage({ type: 'verifyRun', runId: epic.runId! })}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ShieldCheck className="h-3 w-3" />
                  Verify
                </button>
                <button
                  type="button"
                  title="Render this run's history as a shareable Markdown report"
                  onClick={() => postMessage({ type: 'runReport', runId: epic.runId! })}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ClipboardList className="h-3 w-3" />
                  Report
                </button>
              </div>
            )}
          </div>

          {total > 0 && (
            <Stepper
              steps={epic.stepDetails}
              currentStep={epic.currentStep}
              focusedIdx={focusedIdx}
              onFocus={setFocusedIdx}
              busySteps={busySteps}
            />
          )}

          {focused && (
            <StepDetail
              epic={epic}
              focusedIdx={focusedIdx}
              focused={focused}
              meta={agentMeta[focused.agent]}
              // The focused step's own agent, not the run's — focusing an idle
              // parallel sibling used to inherit the running step's banner and
              // lose its Run button with it.
              activity={activityForStep(activities, focusedIdx)}
              otherActivities={activities.filter((a) => a.stepIdx !== null && a.stepIdx !== focusedIdx)}
              stepLabel={(idx) => epic.stepDetails[idx]?.stepName ?? epic.stepDetails[idx]?.agent ?? `step ${idx + 1}`}
              slashCommand={
                // Use the host-resolved command (matched against the actual
                // workspace.yaml slash_commands — bare `/implement` or
                // namespaced `/sdlc-parallel-full-implement`), so it always
                // points at a command file that exists. Fall back to the
                // by-agent table for steps without a name.
                focused.slashCommand ?? slashCommandsByAgent[focused.agent]
              }
            />
          )}

          {inputKeys.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Inputs
              </div>
              <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
                {inputKeys.filter((k) => k !== 'extra_projects').map((k) => (
                  <Frag key={k} keyName={k} value={epic.inputs[k]} />
                ))}
              </div>
              {epic.inputs.extra_projects && (
                <ExtraProjectsList raw={epic.inputs.extra_projects} />
              )}
            </div>
          )}

          <FollowUpHookFailures epic={epic} />
          <EpicActions
            epic={epic}
            hasInputs={inputKeys.length > 0}
            // Deleting is a whole-epic act, so any agent anywhere on the run
            // blocks it — unlike the step gates, which are per step.
            busy={activities.length > 0}
            followUpCount={followUps.length}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A follow-up hook that failed, with its stderr. The epics it ran for were
 * opened and stay opened — what is left is re-running the hook, which a done
 * epic can only do from Sync follow-ups.
 */
function FollowUpHookFailures({ epic }: { epic: EpicSummary }) {
  const failures = epic.followUpHookFailures ?? [];
  if (failures.length === 0) { return null; }
  return (
    <div className="mb-4 space-y-2.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
        <AlertTriangle className="h-3 w-3" />
        Follow-up hook failed — the epics it ran for are kept
      </div>
      {failures.map((f) => (
        <div key={`${f.hook}-${f.at}`} className="space-y-1">
          <div className="font-mono text-[10.5px] text-muted-foreground">
            {f.hook} · {f.event === 'done' ? f.children.join(', ') : `${f.children.length} follow-up(s)`}
            {' · '}exit {f.exitCode ?? '—'} · {new Date(f.at).toLocaleString()}
          </div>
          <div className="break-all font-mono text-[10.5px] text-muted-foreground">$ {f.command}</div>
          {f.stderr.trim() && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/60 px-2 py-1.5 font-mono text-[10.5px] text-destructive/90">
              {f.stderr.trim()}
            </pre>
          )}
        </div>
      ))}
      <div className="text-[11px] text-muted-foreground">
        Fix the cause, then press <span className="font-semibold text-foreground">Sync follow-ups</span> to
        run <span className="font-mono">on_followups_opened</span> again over every follow-up of this epic.
      </div>
    </div>
  );
}

/**
 * The incident ⇄ follow-up edge, drawn in the card header.
 *
 * The link already existed on disk — `from_epic` in inputs.json, and the
 * `<incident>-FIX` id — but only to someone who opened the files. On the list
 * the two epics were unrelated rows that happened to sort next to each other,
 * which is how one incident quietly ends up with two follow-ups nobody notices.
 *
 * Chips over a rendered tree: an epic has at most one parent and usually one
 * child, and a two-node tree costs more chrome than it explains.
 */
function EpicLinks({
  fromEpic,
  followUps,
  onNavigate,
}: {
  fromEpic: string | null;
  followUps: string[];
  onNavigate?: (epicId: string) => void;
}) {
  if (!fromEpic && followUps.length === 0) { return null; }
  const chip =
    'inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/40 hover:text-primary';
  return (
    <span className="flex shrink-0 items-center gap-1">
      {fromEpic && (
        <button
          type="button"
          title={`Opened from ${fromEpic} — the incident this epic fixes`}
          onClick={(e) => { e.stopPropagation(); onNavigate?.(fromEpic); }}
          className={chip}
        >
          <CornerDownRight className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{fromEpic}</span>
        </button>
      )}
      {followUps.length > 0 && (
        <button
          type="button"
          title={`Follow-up epics opened from this one: ${followUps.join(', ')}`}
          onClick={(e) => { e.stopPropagation(); onNavigate?.(followUps[0]); }}
          className={chip}
        >
          <GitBranchPlus className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">
            {followUps.length === 1 ? followUps[0] : `${followUps.length} follow-ups`}
          </span>
        </button>
      )}
    </span>
  );
}

/**
 * `strict_mode` for one epic, as a badge that is also the only way to change it.
 *
 * Three things this deliberately does not do, each one a bug that was reported:
 *
 * 1. **It does not write on a single click.** The badge reads as a status chip,
 *    and it used to be a one-click write to `state.json` with no undo — an
 *    accidental click silently changed how every remaining phase composes its
 *    prompt. It now asks first, and the question names the steps it affects.
 * 2. **It always says which setting is on, in words.** Dropping the label when
 *    the setting was off left a bare 12px icon: quieter, and unreadable at a
 *    glance — which is the one thing a status chip has to be. The noise it was
 *    meant to cut comes back as colour instead.
 *
 *    The words are `Depth: full` / `Depth: proportional` rather than the shorter
 *    `Full depth` / `Proportional`, because the underlying key is called
 *    `strict_mode` and "strict" reads as a quality flag — as though `true` meant
 *    *done properly*. It does not: it is a budget, and an epic that covers
 *    exactly what was asked and stops is the `false` one. Naming the axis in the
 *    badge is what stops the reader having to translate.
 * 3. **It is frozen on a finished epic.** Depth is a budget on work that has yet
 *    to happen. Once every step is done there is no prompt left to shorten, so
 *    flipping it would change the record of how the artifacts were produced and
 *    nothing else.
 */
/**
 * The epic's tags in the collapsed header — read-only, and clickable as a
 * filter. Capped at three with a "+n" because the header is a scanning row: a
 * heavily tagged epic must not push its own title out of view. The rest are one
 * expand away, in the editor below.
 */
function TagChips({ tags, onTagClick }: { tags: string[]; onTagClick?: (tag: string) => void }) {
  if (tags.length === 0) { return null; }
  const shown = tags.slice(0, 3);
  const rest = tags.length - shown.length;

  return (
    <span className="flex shrink-0 items-center gap-1">
      {shown.map((tag) => (
        <button
          key={tag}
          type="button"
          title={onTagClick ? `Filter the list by ${tag}` : tag}
          onClick={(e) => { e.stopPropagation(); onTagClick?.(tag); }}
          className={cn(
            'rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-primary',
            onTagClick && 'hover:bg-primary/20',
          )}
        >
          {tag}
        </button>
      ))}
      {rest > 0 && (
        <span title={tags.join(' ')} className="text-[10px] text-muted-foreground">
          +{rest}
        </span>
      )}
    </span>
  );
}

/**
 * The epic's tags, and the only place they can be changed after it is created.
 *
 * Unlike `DepthBadge` this writes without asking. The two look alike and are
 * not: depth silently changes the prompt of every step still to run, while a
 * tag changes which list an epic shows up in and is undone by typing it back.
 * Confirming a retag would be ceremony around an edit nobody can get badly
 * wrong.
 *
 * The write is still explicit — Save, not save-as-you-type — because each write
 * rewrites `state.json` and refreshes the panel, and a per-keystroke version of
 * that would fight the user's cursor.
 */
function TagsEditor({
  epic,
  suggestions,
  onTagClick,
}: {
  epic: EpicSummary;
  suggestions: string[];
  onTagClick?: (tag: string) => void;
}) {
  const saved = epic.tags ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(saved);

  const open = () => { setDraft(saved); setEditing(true); };
  const save = () => {
    const next = normalizeTags(draft);
    // Nothing changed → no write, no refresh. The panel re-renders every card
    // on a refresh, and a no-op one costs the user their scroll position.
    if (next.join('\u0000') !== saved.join('\u0000')) {
      postMessage({ type: 'setEpicTags', epicId: epic.id, tags: next });
    }
    setEditing(false);
  };

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <TagIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
        {saved.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1">
            {saved.map((tag) => (
              <button
                key={tag}
                type="button"
                title={onTagClick ? `Filter the list by ${tag}` : tag}
                onClick={() => onTagClick?.(tag)}
                className={cn(
                  'rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-primary',
                  onTagClick && 'hover:bg-primary/20',
                )}
              >
                {tag}
              </button>
            ))}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">No tags</span>
        )}
        <button
          type="button"
          onClick={open}
          title="Edit this epic's tags — free text in, stored uppercase"
          className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {saved.length > 0 ? 'Edit' : 'Add tags'}
        </button>
      </span>
    );
  }

  return (
    <div className="basis-full space-y-2 rounded-md border border-border bg-surface/40 p-2.5">
      <TagInput tags={draft} onChange={setDraft} suggestions={suggestions} autoFocus />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={save}
          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          Save tags
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="rounded-md px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function DepthBadge({ epic }: { epic: EpicSummary }) {
  const [confirming, setConfirming] = useState(false);

  // Done steps are the ones the setting can no longer reach: their artifacts are
  // written. Everything else still has a prompt ahead of it.
  const pending = epic.stepDetails.filter((s) => s.status !== 'done');
  const frozen = epic.status === 'done' || pending.length === 0;

  const label = epic.strictMode
    ? 'strict_mode: true — every phase works at full depth.'
    : 'strict_mode: false — phases cover what the change needs and stop, with no invented non-functional, risk or alternatives sections.';

  const chip = cn(
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider',
    epic.strictMode
      ? 'border-border text-muted-foreground'
      : 'border-primary/40 bg-primary/10 text-primary',
  );

  if (frozen) {
    return (
      <span
        title={`${label} This epic has no step left to run, so depth is fixed.`}
        className={cn(chip, 'opacity-60')}
      >
        <Gauge className="h-3.5 w-3.5" />
        {epic.strictMode ? 'Depth: full' : 'Depth: proportional'}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        title={`${label} Click to switch — applies to the ${pending.length} step${pending.length === 1 ? '' : 's'} not yet done.`}
        onClick={() => setConfirming(true)}
        className={cn(chip, epic.strictMode && 'hover:text-foreground')}
      >
        <Gauge className="h-3.5 w-3.5" />
        {epic.strictMode ? 'Depth: full' : 'Depth: proportional'}
      </button>

      {confirming && (
        <ConfirmModal
          title={epic.strictMode ? 'Set depth to proportional?' : 'Set depth to full?'}
          confirmLabel={epic.strictMode ? 'Set proportional' : 'Set full'}
          onClose={() => setConfirming(false)}
          onConfirm={() => postMessage({
            type: 'setEpicStrictMode',
            epicId: epic.id,
            strict: !epic.strictMode,
          })}
          message={
            <div className="space-y-3">
              <p>
                {epic.strictMode
                  ? 'Phases will cover what this change actually needs and stop — no invented non-functional, risk or alternatives sections. Every heading stays, so the auto-reviewer and the traceability validator still pass.'
                  : 'Phases go back to working at full depth: the templates are written for the largest thing an epic can be, and each one will be filled out in full.'}
              </p>

              <div className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] text-warning/90">
                <div className="font-semibold">
                  Nothing already written changes.
                </div>
                <div className="mt-0.5">
                  Unlike <strong>Request update</strong>, this rewrites no artifact and rewinds no
                  step. It changes the prompt for work that has yet to run — the{' '}
                  {pending.length} step{pending.length === 1 ? '' : 's'} below. To reshape an
                  artifact that already exists, use Request update on its step.
                </div>
              </div>

              <div>
                <div className="mb-1 text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
                  Affected steps
                </div>
                <ul className="space-y-0.5 font-mono text-[11px] text-foreground/80">
                  {pending.map((s, i) => (
                    <li key={`${s.stepName ?? s.agent}-${i}`}>
                      {s.stepName ?? s.agent}
                      {s.status === 'in_progress' && (
                        <span className="ml-1.5 font-sans text-[10px] text-warning">
                          in progress — takes effect on its next run
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          }
        />
      )}
    </>
  );
}

/**
 * The epic's description, and the only place it can be changed after the
 * wizard captured it.
 *
 * It was read-only until now, which made a sentence typed in a hurry permanent:
 * every panel shows it, and the first phase's skill reads it out of the .md
 * brief. Editing writes both — see core `setEpicDescription` — and stops at a
 * brief somebody has since rewritten by hand.
 *
 * When the real requirement lives in an `init-requirement.md` artifact the card
 * links to that file instead of dumping its text inline; the one-liner behind
 * it is still editable, since that is what the list rows show.
 */
function EpicDescription({ epic }: { epic: EpicSummary }) {
  const reqFile = epic.existingArtifacts.find((f) =>
    /init.?requirements?.*.md$/i.test(f),
  );
  const saved = (epic.description ?? '').trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved);

  const open = () => { setDraft(saved); setEditing(true); };
  const save = () => {
    const next = draft.trim();
    // Nothing changed → no write, no refresh: a refresh re-renders every card
    // and costs the user their scroll position.
    if (next !== saved) {
      postMessage({ type: 'setEpicDescription', epicId: epic.id, description: next });
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="space-y-2 rounded-md border border-border bg-surface/40 p-2.5">
        <textarea
          autoFocus
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          }}
          placeholder="One-line summary of what this epic delivers"
          className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary/60"
        />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={save}
            className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            Save description
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded-md px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
          <span className="ml-auto text-[10px] text-muted-foreground">
            Also rewrites the lead of {epic.id}.md, unless it has been rewritten by hand
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-2">
      {reqFile ? (
        <button
          type="button"
          onClick={() =>
            postMessage({ type: 'openArtifactFile', epicDir: epic.epicDir, filename: reqFile })
          }
          className="inline-flex w-fit items-center gap-1.5 rounded border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary transition-colors hover:border-primary/50 hover:bg-primary/20"
          title={`Open ${reqFile}`}
        >
          <FileText className="h-3 w-3" />
          {reqFile}
        </button>
      ) : saved ? (
        <p className="min-w-0 flex-1 text-xs italic leading-relaxed text-muted-foreground">{saved}</p>
      ) : (
        <span className="text-[11px] text-muted-foreground">No description</span>
      )}
      <button
        type="button"
        onClick={open}
        title="Edit this epic's description — writes state.json and the lead of its .md brief"
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {saved ? 'Edit' : 'Add description'}
      </button>
    </div>
  );
}
function Frag({ keyName, value }: { keyName: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{keyName}</span>
      <span className="break-all text-foreground">{value}</span>
    </>
  );
}

function ExtraProjectsList({ raw }: { raw: string }) {
  let projects: Array<{ type: string; ref: string; label: string; mode?: string }> = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) { projects = parsed; }
  } catch { /* raw JSON string — try wrapping */ }
  if (projects.length === 0) { return null; }
  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        Extra Projects
      </div>
      <div className="space-y-1">
        {projects.map((p, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5 text-[11px]">
            {p.type === 'github'
              ? <Github className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              : <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <span className="font-mono text-[10.5px] text-foreground truncate" title={p.ref}>{p.ref}</span>
            <span className={cn(
              'ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase',
              p.mode === 'workspace' ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                : p.mode === 'clone' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                : 'bg-muted text-muted-foreground',
            )}>
              {p.mode === 'workspace' ? 'workspace' : p.mode === 'clone' ? 'cloned' : 'ref'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stepper({
  steps,
  currentStep,
  focusedIdx,
  onFocus,
  busySteps,
}: {
  steps: EpicStepDetailFull[];
  currentStep: number;
  focusedIdx: number;
  onFocus: (idx: number) => void;
  /** Indices with an agent this window dispatched still working on them. */
  busySteps: Set<number>;
}) {
  const isDag = steps.some((s) => (s.dependsOn?.length ?? 0) > 0);
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface/50 p-3">
      {isDag ? (
        <DagStepper steps={steps} currentStep={currentStep} focusedIdx={focusedIdx} onFocus={onFocus} busySteps={busySteps} />
      ) : (
        <LinearStepper steps={steps} currentStep={currentStep} focusedIdx={focusedIdx} onFocus={onFocus} busySteps={busySteps} />
      )}
    </div>
  );
}

/**
 * The dispatch that belongs to one step: its own entry, or the unattributed
 * one (`stepIdx: null`) when the host could not say which step a launch was
 * for. That fallback keeps the old whole-run behaviour for such entries, which
 * is the safe reading — better to over-report busy than to invite a second
 * agent onto work already under way.
 */
function activityForStep(activities: AgentActivity[], idx: number): AgentActivity | null {
  return (
    activities.find((a) => a.stepIdx === idx)
    ?? activities.find((a) => a.stepIdx === null)
    ?? null
  );
}

function LinearStepper({
  steps,
  currentStep,
  focusedIdx,
  onFocus,
  busySteps,
}: {
  steps: EpicStepDetailFull[];
  currentStep: number;
  focusedIdx: number;
  onFocus: (idx: number) => void;
  busySteps: Set<number>;
}) {
  return (
    <div className="flex min-w-max items-start justify-center gap-0">
      {steps.map((step, i) => (
        <div key={`${step.agent}-${i}`} className="flex items-center">
          {i > 0 && (
            <div
              className={cn(
                'h-0.5 w-10',
                step.status === 'done' || steps[i - 1].status === 'done'
                  ? 'bg-primary'
                  : 'bg-border',
              )}
            />
          )}
          <StepperNode
            step={step}
            idx={i}
            isCurrent={i === currentStep}
            isFocused={i === focusedIdx}
            isBusy={busySteps.has(i)}
            onFocus={() => onFocus(i)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * DAG stepper: same level-bucketed layout used in the Builder's PipelineCard
 * so the user sees the parallel branches their pipeline actually has. Each
 * column is one DAG level; column connectors are drawn between adjacent
 * columns. Steps at the same level stack vertically.
 */
function DagStepper({
  steps,
  currentStep,
  focusedIdx,
  onFocus,
  busySteps,
}: {
  steps: EpicStepDetailFull[];
  currentStep: number;
  focusedIdx: number;
  onFocus: (idx: number) => void;
  busySteps: Set<number>;
}) {
  const levels = computeEpicDagLevels(steps);
  // Level-based numbering: single occupant → "3", parallels → "2.1", "2.2".
  const labelByIdx = new Map<number, string>();
  levels.forEach((column, colIdx) => {
    const lvl = colIdx + 1;
    if (column.length === 1) {
      labelByIdx.set(column[0].idx, String(lvl));
    } else {
      column.forEach((entry, sub) => {
        labelByIdx.set(entry.idx, `${lvl}.${sub + 1}`);
      });
    }
  });
  return (
    <div className="flex min-w-max items-stretch justify-center gap-0">
      {levels.map((column, colIdx) => (
        <div key={colIdx} className="flex items-stretch">
          <div className="flex flex-col items-center justify-center gap-2 self-center">
            {column.map(({ step, idx }) => (
              <StepperNode
                key={`${step.agent}-${idx}`}
                step={step}
                idx={idx}
                label={labelByIdx.get(idx) ?? String(idx + 1)}
                isCurrent={idx === currentStep}
                isFocused={idx === focusedIdx}
                isBusy={busySteps.has(idx)}
                onFocus={() => onFocus(idx)}
              />
            ))}
          </div>
          {colIdx < levels.length - 1 && (
            <div className="flex flex-col justify-center px-1">
              <div className="h-0.5 w-8 bg-border" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function computeEpicDagLevels(
  steps: EpicStepDetailFull[],
): Array<Array<{ step: EpicStepDetailFull; idx: number }>> {
  // Same fix as PipelineCard.computeDagLevels — DAG edges reference phase
  // ids (step.name) when present, falling back to step.agent for legacy.
  const dagId = (s: EpicStepDetailFull): string => s.stepName ?? s.agent;
  const stepById = new Map<string, { step: EpicStepDetailFull; idx: number }>();
  steps.forEach((step, idx) => { stepById.set(dagId(step), { step, idx }); });

  const memo = new Map<string, number>();
  const computing = new Set<string>();
  const levelOf = (id: string): number => {
    if (memo.has(id)) { return memo.get(id)!; }
    if (computing.has(id)) { return 0; }
    computing.add(id);
    const entry = stepById.get(id);
    const deps = (entry?.step.dependsOn ?? []).filter((d) => stepById.has(d));
    const level = deps.length === 0 ? 0 : Math.max(...deps.map(levelOf)) + 1;
    computing.delete(id);
    memo.set(id, level);
    return level;
  };

  const buckets: Array<Array<{ step: EpicStepDetailFull; idx: number }>> = [];
  steps.forEach((step, idx) => {
    const lvl = levelOf(dagId(step));
    if (!buckets[lvl]) { buckets[lvl] = []; }
    buckets[lvl].push({ step, idx });
  });
  return buckets;
}

function StepperNode({
  step,
  idx,
  label,
  isCurrent,
  isFocused,
  isBusy,
  onFocus,
}: {
  step: EpicStepDetailFull;
  idx: number;
  /** Optional display label — DAG mode passes `<level>.<n>`, linear mode lets us fall back to `idx + 1`. */
  label?: string;
  isCurrent: boolean;
  isFocused: boolean;
  /** An agent this window dispatched is working this step right now. */
  isBusy?: boolean;
  onFocus: () => void;
}) {
  // Pending step that carries history was previously approved and got reset
  // by a downstream Request-Update — surface that as a warning-tinted state
  // separate from never-touched pending.
  const isAwaitingUpdate = step.status === 'pending' && (step.history ?? []).length > 0;
  // A spinner on the node is what makes the per-step banner findable: with
  // parallel steps open the user has to know *which* of them the running agent
  // is on before clicking the right one.
  const inner = isBusy
    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
    : step.status === 'done'
      ? <Check className="h-3.5 w-3.5" />
      : step.status === 'failed'
        ? <X className="h-3.5 w-3.5" />
        : (label ?? String(idx + 1));
  return (
    <button
      type="button"
      onClick={onFocus}
      className="group flex flex-col items-center gap-1 px-1"
      title={`${step.stepName ?? step.agent}${step.stepName && step.stepName !== step.agent ? ` · agent ${step.agent}` : ''} — ${isBusy ? 'agent running' : isAwaitingUpdate ? 'awaiting update' : STEP_LABEL[step.status]}${step.dirty ? ` · dirty: ${step.dirty.byStep} was rerun after this finished` : ''}${step.canRerun ? ' · click to open and rerun it' : ''}`}
    >
      <div
        className={cn(
          'relative flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold transition-all',
          step.status === 'done' && 'bg-primary text-primary-foreground',
          step.status === 'in_progress' &&
            'bg-warning text-warning-foreground shadow-[0_0_14px_color-mix(in_oklab,var(--color-warning)_40%,transparent)]',
          step.status === 'failed' && 'bg-destructive text-destructive-foreground',
          step.status === 'pending' && !isAwaitingUpdate &&
            'border-2 border-border bg-card text-muted-foreground',
          isAwaitingUpdate &&
            'border-2 border-warning/60 bg-warning/10 text-warning',
          isCurrent && 'scale-110',
          isFocused && 'ring-4 ring-primary/30',
        )}
      >
        {inner}
        {/* A dirty step is still `done`, so the node keeps its done styling —
            the mark has to ride on top of it or it would be invisible. */}
        {step.dirty && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-warning"
          />
        )}
      </div>
      <span
        className={cn(
          'max-w-[80px] truncate text-center text-[9px] font-bold uppercase tracking-wider',
          isFocused
            ? 'text-primary'
            : step.status === 'done' || step.status === 'in_progress'
              ? 'text-foreground'
              : 'text-muted-foreground',
        )}
      >
        {step.stepName ?? step.agent}
      </span>
    </button>
  );
}

function StepDetail({
  epic,
  focusedIdx,
  focused,
  meta,
  slashCommand,
  activity,
  otherActivities,
  stepLabel,
}: {
  epic: EpicSummary;
  focusedIdx: number;
  focused: EpicStepDetailFull;
  meta: AgentMeta | undefined;
  slashCommand: string | undefined;
  /** The dispatch on *this* step, if any. */
  activity: AgentActivity | null;
  /** Dispatches on the run's other steps — named here, never acted on. */
  otherActivities: AgentActivity[];
  /** Name of a step by index, for talking about the ones running elsewhere. */
  stepLabel: (idx: number) => string;
}) {
  const total = epic.stepDetails.length;
  const ui = (() => {
    if (focused.status === 'done') { return 'done' as const; }
    if (focused.status === 'in_progress') { return 'in_progress' as const; }
    if (focused.status === 'failed') { return 'rejected' as const; }
    // Pending step that carries history was previously approved and got
    // reset by a downstream Request-Update — flag it so the user can tell
    // it apart from a never-touched step.
    if ((focused.history ?? []).length > 0) { return 'awaiting_update' as const; }
    return 'pending' as const;
  })();
  const m = meta ?? { name: focused.agent, description: '', inputs: '', outputs: '', artifact: '' };
  // Step-level artifact (from `produces[0]` on the pipeline step) wins over
  // the persona's default — one persona handles multiple phases that each
  // emit different files, so the step is the authoritative source.
  const artifactName = focused.artifact || m.artifact || '';
  // The host resolves the step's `produces` path against the workspace root
  // and reports whether it is there, which is the same check `markStepDone`
  // makes. Fall back to the epic's own `artifacts/` listing only when the
  // step declares no path — a pipeline that writes outside the epic folder is
  // invisible to that listing, and the fallback used to keep *Mark step done*
  // disabled forever on one.
  const artifactExists = focused.artifact && focused.artifactExists !== undefined
    ? focused.artifactExists
    : artifactName ? epic.existingArtifacts.includes(artifactName) : false;
  // Several steps of a document pipeline can declare the same `produces`
  // file, so "it exists" does not mean "this step wrote it". The host
  // compares mtime against the step's startedAt and tells us which it is.
  const artifactStale = artifactExists && !!focused.artifactStale;
  // Annotron opens artifacts by `<epicId> <filename>` under the epic folder,
  // so its two entries only make sense for artifacts that actually live there.
  const artifactInEpicFolder = !!artifactName && epic.existingArtifacts.includes(artifactName);
  const [artifactMenuOpen, setArtifactMenuOpen] = useState(false);
  // A step may declare several `produces` entries. The first is the headline
  // artifact rendered above; the rest are listed beside it, because otherwise
  // the only way to reach them is to know their paths by heart.
  const extraArtifacts = (focused.artifacts ?? []).filter(
    (a) => a.path !== focused.artifactPath && a.label !== artifactName,
  );
  const artifactIsHtml = /\.html?$/i.test(artifactName);

  const accent = (() => {
    switch (focused.status) {
      case 'in_progress':
        return 'border-l-warning';
      case 'done':
        return 'border-l-success';
      case 'failed':
        return 'border-l-destructive';
      default:
        return 'border-l-border';
    }
  })();

  return (
    <div className={cn('rounded-md border border-border border-l-[3px] bg-surface/50 p-4', accent)}>
      <div className="flex items-baseline gap-2.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Step {focusedIdx + 1}/{total}
        </span>
        <span className="flex-1 truncate text-sm font-bold text-foreground">{focused.stepName ?? m.name}</span>
        <StatusBadge status={ui} />
      </div>

      {m.description && (
        <p className="mt-2 text-[11.5px] italic leading-relaxed text-muted-foreground">
          {m.description}
        </p>
      )}

      {focused.tokenUsage && focused.tokenUsage.calls > 0 && (
        <div
          className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
          title={`${fmtCost(focused.tokenUsage.cost)} API equivalent (subscription users don't pay this)`}
        >
          <span className="inline-flex items-center gap-1 font-medium tabular-nums text-foreground">
            <Zap className="h-3 w-3" />
            {fmtTokens(focused.tokenUsage.totalTokens)} tok
          </span>
          <span>· {focused.tokenUsage.calls} calls</span>
          <span>
            · in <strong className="text-foreground">{fmtTokens(focused.tokenUsage.inputTokens)}</strong>
          </span>
          <span>
            · out <strong className="text-foreground">{fmtTokens(focused.tokenUsage.outputTokens)}</strong>
          </span>
          <span>
            · cache rd <strong className="text-foreground">{fmtTokens(focused.tokenUsage.cacheReadTokens)}</strong>
          </span>
          <span>
            · cache wr <strong className="text-foreground">{fmtTokens(focused.tokenUsage.cacheWriteTokens)}</strong>
          </span>
        </div>
      )}

      <div className="mt-3 grid grid-cols-[110px_1fr] gap-x-4 gap-y-1.5 text-[11.5px]">
        <DetailLabel icon={<Inbox className="h-3 w-3" />} text="Input" />
        <DetailValue empty={!m.inputs}>{m.inputs || '—'}</DetailValue>

        <DetailLabel icon={<Outdent className="h-3 w-3" />} text="Output" />
        <DetailValue empty={!m.outputs}>{m.outputs || '—'}</DetailValue>

        <DetailLabel icon={<FileText className="h-3 w-3" />} text="Artifact" />
        {artifactName ? (
          artifactExists ? (
            <div className="relative w-fit">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setArtifactMenuOpen((v) => !v);
                }}
                className="inline-flex w-fit items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary transition-colors hover:border-primary/50 hover:bg-primary/20"
                title={
                  artifactStale
                    ? `Open ${artifactName} — unchanged since this step started, so it is an earlier step's output`
                    : `Open ${artifactName}`
                }
              >
                <span>{artifactName}</span>
                {artifactStale && (
                  <span className="text-[9.5px] font-sans uppercase tracking-wider opacity-70">· from earlier step</span>
                )}
                <ChevronDown className={cn('h-2.5 w-2.5 opacity-70 transition-transform', artifactMenuOpen && 'rotate-180')} />
              </button>
              {artifactMenuOpen && (
                <>
                  {/* click-away backdrop */}
                  <div
                    className="fixed inset-0 z-10"
                    onClick={(e) => { e.stopPropagation(); setArtifactMenuOpen(false); }}
                  />
                  <div className="absolute left-0 top-full z-20 mt-1 min-w-[210px] overflow-hidden rounded-md border border-border bg-card shadow-lg">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setArtifactMenuOpen(false);
                        postMessage({ type: 'openArtifactFile', epicDir: epic.epicDir, filename: artifactName, path: focused.artifactPath });
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
                    >
                      <FileText className="h-3 w-3 text-muted-foreground" />
                      {/* An .html artifact is rendered, not read as source —
                          the host branches on the extension. */}
                      <span>{artifactIsHtml ? 'Open rendered' : 'Open Markdown'}</span>
                    </button>
                    {artifactIsHtml ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setArtifactMenuOpen(false);
                          postMessage({ type: 'openArtifactExternally', epicDir: epic.epicDir, filename: artifactName, path: focused.artifactPath });
                        }}
                        className="flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
                        title="Open in your default browser — for printing, saving, or a second monitor."
                      >
                        <ExternalLink className="h-3 w-3 text-muted-foreground" />
                        <span>Open in browser</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setArtifactMenuOpen(false);
                          postMessage({ type: 'previewArtifactInVsCode', epicDir: epic.epicDir, filename: artifactName, path: focused.artifactPath });
                        }}
                        className="flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
                        title="Render in VS Code's own Markdown preview — no terminal, no browser. Mermaid diagrams need a Markdown-preview extension; use Preview below for those."
                      >
                        <Eye className="h-3 w-3 text-muted-foreground" />
                        <span>Preview (VS Code)</span>
                      </button>
                    )}
                    {artifactInEpicFolder && (
                      <>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setArtifactMenuOpen(false);
                        postMessage({ type: 'viewArtifact', epicDir: epic.epicDir, filename: artifactName });
                      }}
                      className="flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
                      title="Preview in annotron (browser) — renders diagrams as SVG, same view the Feedback loop uses. Read-only; no feedback loop."
                    >
                      <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      <span>Preview (annotron)</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setArtifactMenuOpen(false);
                        postMessage({ type: 'annotateArtifact', epicDir: epic.epicDir, filename: artifactName });
                      }}
                      className="flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
                      title="Open in annotron (renders the Markdown with diagrams) and start the feedback loop — edits land in the .md and each round is logged to this step's history"
                    >
                      <Highlighter className="h-3 w-3 text-primary" />
                      <span>Feedback</span>
                    </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div
              className="inline-flex w-fit items-center rounded border border-border bg-muted/50 px-2 py-0.5 font-mono text-[11px] italic text-muted-foreground opacity-70"
              title="File not produced yet — will land in artifacts/ when this step runs"
            >
              {artifactName} · not produced yet
            </div>
          )
        ) : (
          <div className="font-mono text-[11px] italic text-muted-foreground">—</div>
        )}

        {extraArtifacts.length > 0 && (
          <>
            <DetailLabel icon={<FolderOpen className="h-3 w-3" />} text="Also produced" />
            <div className="flex w-fit flex-wrap gap-1.5">
              {extraArtifacts.map((a) => (
                <button
                  key={a.path}
                  type="button"
                  disabled={!a.exists}
                  onClick={(e) => {
                    e.stopPropagation();
                    // A folder has nothing to open — reveal it instead.
                    postMessage(
                      a.isDirectory
                        ? { type: 'revealArtifactPath', epicDir: epic.epicDir, path: a.path }
                        : { type: 'openArtifactFile', epicDir: epic.epicDir, filename: a.label, path: a.path },
                    );
                  }}
                  title={a.exists
                    ? `${a.isDirectory ? 'Reveal' : 'Open'} ${a.path}`
                    : `${a.path} — not produced yet`}
                  className={cn(
                    'inline-flex w-fit items-center gap-1 rounded border px-2 py-0.5 font-mono text-[11px] transition-colors',
                    a.exists
                      ? 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-accent hover:text-foreground'
                      : 'border-border bg-muted/50 italic text-muted-foreground opacity-70',
                  )}
                >
                  {a.isDirectory
                    ? <Folder className="h-3 w-3 opacity-70" />
                    : <FileText className="h-3 w-3 opacity-70" />}
                  <span>{a.label}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {slashCommand && (
          <>
            <DetailLabel icon={<Terminal className="h-3 w-3" />} text="Command" />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                postMessage({ type: 'copyCommand', command: slashCommand });
              }}
              title="Click to copy — paste into Claude to run this step"
              className="inline-flex w-fit items-center gap-1.5 rounded border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary transition-colors hover:border-primary/50 hover:bg-primary/20"
            >
              <span>{slashCommand}</span>
              <Copy className="h-2.5 w-2.5 opacity-70" />
            </button>
          </>
        )}
      </div>

      <RunGate
        epic={epic}
        focused={focused}
        focusedIdx={focusedIdx}
        slashCommand={slashCommand}
        artifactName={artifactName}
        artifactExists={artifactExists}
        artifactStale={artifactStale}
        activity={activity}
        otherActivities={otherActivities}
        stepLabel={stepLabel}
      />
      <DirtyUpstreamWarning focused={focused} />
      <UndoDoneAction epic={epic} focused={focused} focusedIdx={focusedIdx} />
      <RequestUpdateAction epic={epic} focused={focused} focusedIdx={focusedIdx} />
      <RerunStepAction
        epic={epic}
        focused={focused}
        focusedIdx={focusedIdx}
        slashCommand={slashCommand}
        busy={!!activity}
      />
      <StepHistory step={focused} />
    </div>
  );
}

function DetailLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
      {icon}
      <span>{text}</span>
    </div>
  );
}

/**
 * The way back out of a "Mark step done" that approved this step and moved the
 * run on — `RunGate` has already gone quiet by then, so the offer has to live
 * out here beside Request update.
 *
 * The two are not the same thing, and the copy says so: Request update is for
 * a requirement that changed and costs a revision plus every downstream step;
 * this is for a button pressed by accident and costs nothing. The host decides
 * whether it is still safe (`canUndoDone`) — the moment a following step has
 * produced anything, this disappears and Request update is the only honest
 * option left.
 */
function UndoDoneAction({
  epic,
  focused,
  focusedIdx,
}: {
  epic: EpicSummary;
  focused: EpicStepDetailFull;
  focusedIdx: number;
}) {
  if (!epic.runId || focused.runStatus !== 'approved' || !focused.canUndoDone) { return null; }
  return (
    <div className="mt-3 flex items-center justify-between rounded-md border border-dashed border-border bg-secondary/20 px-3 py-2 text-[11px]">
      <div className="text-muted-foreground">
        Marked done by mistake?{' '}
        <span className="text-foreground/80">Undo</span> reopens it at the same revision — nothing
        downstream has started yet.
      </div>
      <button
        type="button"
        onClick={() =>
          postMessage({ type: 'undoStepDone', runId: epic.runId!, stepIdx: focusedIdx })
        }
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[10.5px] font-semibold text-muted-foreground hover:border-foreground/40 hover:text-foreground"
      >
        <Undo2 className="h-2.5 w-2.5" /> Undo mark done
      </button>
    </div>
  );
}

function RequestUpdateAction({
  epic,
  focused,
  focusedIdx,
}: {
  epic: EpicSummary;
  focused: EpicStepDetailFull;
  focusedIdx: number;
}) {
  const [open, setOpen] = useState(false);
  // Only show for steps the run-state machine considers "approved" — that's
  // what `requestStepUpdate` accepts. A done-from-state.json with no
  // matching run record can't be rewound by the runner.
  if (!epic.runId || focused.runStatus !== 'approved') { return null; }
  // Count downstream approved + in-flight steps so the modal can show the
  // blast radius accurately.
  const downstreamCount = epic.stepDetails
    .slice(focusedIdx + 1)
    .filter((s) => s.runStatus === 'approved' || s.isCurrentRunStep).length;
  return (
    <div className="mt-3 flex items-center justify-between rounded-md border border-dashed border-warning/40 bg-warning/5 px-3 py-2 text-[11px]">
      <div className="text-muted-foreground">
        Requirements changed?{' '}
        <span className="text-foreground/80">Reopen this step</span> to redo it
        {downstreamCount > 0 && (
          <> + reset {downstreamCount} downstream</>
        )}.
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/50 bg-warning/15 px-2 py-1 text-[10.5px] font-semibold text-warning hover:border-warning hover:bg-warning/25"
      >
        <RefreshCw className="h-2.5 w-2.5" /> Request update
      </button>
      {open && (
        <RequestUpdateModal
          agent={focused.agent}
          runId={epic.runId}
          stepIdx={focusedIdx}
          downstreamCount={downstreamCount}
          onSubmit={(feedback) =>
            postMessage({
              type: 'requestStepUpdate',
              runId: epic.runId!,
              stepIdx: focusedIdx,
              feedback,
            })
          }
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The risk warning for working a step that sits behind a dirty one.
 *
 * This is the whole payoff of the dirty mark: `dirty` deliberately does not
 * block anything, so the only thing standing between the user and building on
 * stale input is being told. It renders for any focused step with a dirty
 * ancestor, done or not — a step already finished behind a dirty one is just
 * as suspect as one about to start, and its own mark (if it has one) explains
 * a different fact.
 */
function DirtyUpstreamWarning({ focused }: { focused: EpicStepDetailFull }) {
  const upstream = focused.dirtyUpstream ?? [];
  if (upstream.length === 0) { return null; }
  return (
    <div className="mt-3 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-[11px]">
      <div className="flex items-center gap-1.5 font-semibold text-warning">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        Risk: this step builds on output that has changed underneath it
      </div>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        {upstream.map((u) => (
          <li key={u.stepIdx}>
            Step {u.stepIdx + 1} <span className="font-mono text-foreground/80">{u.step}</span> is
            dirty — <span className="font-mono text-foreground/80">{u.byStep}</span> was rerun after
            it finished.
          </li>
        ))}
      </ul>
      <div className="mt-1 text-muted-foreground/80">
        Nothing is blocked. Rerun the dirty step{upstream.length === 1 ? '' : 's'} first if the
        change matters here.
      </div>
    </div>
  );
}

/**
 * Rerun a step that already passed, keeping what was built on top of it.
 *
 * Its own row under Request update, styled the same way, because they answer
 * the same question differently and the choice is the user's — though Request
 * update is the usual answer, so it comes first. Request update says the change
 * invalidates the downstream work, this says it might not. The copy leads with
 * what survives, since that is the only difference visible after the click.
 */
function RerunStepAction({
  epic,
  focused,
  focusedIdx,
  slashCommand,
  busy,
}: {
  epic: EpicSummary;
  focused: EpicStepDetailFull;
  focusedIdx: number;
  /** The step's command; without one the step reopens and waits for a manual run. */
  slashCommand: string | undefined;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!epic.runId || !focused.canRerun) { return null; }
  const kept = keptOnRerun(epic, focusedIdx);
  const withClaude = !!slashCommand;
  return (
    <div className="mt-3 flex items-center justify-between rounded-md border border-dashed border-warning/40 bg-warning/5 px-3 py-2 text-[11px]">
      <div className="text-muted-foreground">
        Updated the prompt?{' '}
        <span className="text-foreground/80">Rerun it</span>
        {kept.length > 0
          ? <> — <span className="font-semibold text-warning">{kept.length} finished step{kept.length === 1 ? '' : 's'} after it</span> stay done, marked dirty.</>
          : <> and produce its artifacts again.</>}
      </div>
      <button
        type="button"
        disabled={busy}
        title={busy ? 'An agent is still working on this step — wait for it, or dismiss the banner above' : undefined}
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/50 bg-warning/15 px-2 py-1 text-[10.5px] font-semibold text-warning hover:border-warning hover:bg-warning/25',
          busy && 'cursor-not-allowed opacity-40 hover:!border-warning/50 hover:!bg-warning/15',
        )}
      >
        <RotateCcw className="h-2.5 w-2.5" /> {withClaude ? 'Rerun with Claude' : 'Rerun step'}
      </button>
      {open && (
        <RerunStepModal
          agent={focused.stepName ?? focused.agent}
          runId={epic.runId}
          stepIdx={focusedIdx}
          keptSteps={kept}
          confirmLabel={withClaude ? 'Rerun with Claude' : 'Rerun step'}
          onSubmit={(feedback) =>
            postMessage({
              type: 'rerunApprovedStep',
              runId: epic.runId!,
              stepIdx: focusedIdx,
              feedback,
              andRun: withClaude,
              slashCommand,
            })
          }
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The finished steps a rerun of `stepIdx` would keep and mark dirty, as
 * labels.
 *
 * An approximation of the host's descendant walk: the card has `dependsOn` by
 * agent id but not the resolved graph, so on a DAG it follows the edges it can
 * see and falls back to "every later step" when the pipeline declares none —
 * the same fallback the runner uses. Only approved steps count, because only
 * those can be marked.
 */
function keptOnRerun(epic: EpicSummary, stepIdx: number): string[] {
  const steps = epic.stepDetails;
  const usesDag = steps.some((st) => (st.dependsOn ?? []).length > 0);
  const label = (st: EpicStepDetailFull, i: number) => `${i + 1}. ${st.stepName ?? st.agent}`;

  if (!usesDag) {
    return steps
      .map((st, i) => ({ st, i }))
      .filter(({ st, i }) => i > stepIdx && st.runStatus === 'approved')
      .map(({ st, i }) => label(st, i));
  }

  const idOf = (st: EpicStepDetailFull) => st.stepName ?? st.agent;
  const reached = new Set<number>([stepIdx]);
  let changed = true;
  while (changed) {
    changed = false;
    steps.forEach((st, i) => {
      if (reached.has(i)) { return; }
      if ((st.dependsOn ?? []).some((dep) => steps.some((u, j) => reached.has(j) && idOf(u) === dep))) {
        reached.add(i);
        changed = true;
      }
    });
  }
  reached.delete(stepIdx);
  return steps
    .map((st, i) => ({ st, i }))
    .filter(({ st, i }) => reached.has(i) && st.runStatus === 'approved')
    .map(({ st, i }) => label(st, i));
}

function StepHistory({ step }: { step: EpicStepDetailFull }) {
  const [open, setOpen] = useState(false);
  const entries = step.history ?? [];
  if (entries.length === 0) { return null; }

  const rejectCount = step.rejectCount ?? 0;
  const rerunCount = entries.filter((e) => e.kind === 'rerun').length;
  const annotateCount = entries.filter((e) => e.kind === 'annotate').length;
  // Reads the live mark, not the history: a step can have been dirtied and
  // since redone, and the timeline keeps both while only one is still true.
  const isDirty = !!step.dirty;
  const lastReject = [...entries].reverse().find((e) => e.kind === 'reject') as
    | (StepHistoryEntry & { kind: 'reject' })
    | undefined;

  const summary = [
    rejectCount > 0 && `rejected ${rejectCount}×`,
    rerunCount > 0 && `rerun ${rerunCount}×`,
    annotateCount > 0 && `annotated ${annotateCount}×`,
    !rejectCount && entries.some((e) => e.kind === 'approve') && 'approved',
    isDirty && 'dirty',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="mt-3 rounded-md border border-border bg-secondary/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] hover:bg-accent/40"
      >
        {open ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        <History className="h-3 w-3 text-muted-foreground" />
        <span className="font-bold uppercase tracking-wider text-muted-foreground">
          History
        </span>
        <span className="text-muted-foreground/80">· {entries.length} entries</span>
        {summary && <span className="text-muted-foreground/80">· {summary}</span>}
        {lastReject?.reason && !open && (
          <span className="ml-auto truncate font-mono text-[10.5px] text-destructive/80 max-w-[55%]">
            ↳ {lastReject.reason}
          </span>
        )}
      </button>

      {open && (
        <ol className="border-t border-border/60 px-3 py-2 space-y-1.5 text-[10.5px]">
          {entries.map((e, i) => {
            const segUsage = step.tokenUsage?.history?.[i];
            return (
              <li key={i} className="flex items-start gap-2">
                <HistoryIcon kind={e.kind} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <HistoryLabel entry={e} />
                    <span className="text-[9.5px] text-muted-foreground tabular-nums">
                      rev {e.revision}
                    </span>
                    {segUsage && segUsage.calls > 0 && (
                      <span
                        className="inline-flex items-center gap-0.5 text-[9.5px] tabular-nums text-muted-foreground"
                        title={`${fmtTokens(segUsage.totalTokens)} tokens · ${segUsage.calls} calls · ${fmtCost(segUsage.cost)} API equiv — consumed in the segment leading to this event`}
                      >
                        <Zap className="h-2.5 w-2.5" />
                        {fmtTokens(segUsage.totalTokens)}
                      </span>
                    )}
                    <span className="ml-auto text-[9.5px] text-muted-foreground/80">
                      {fmtTime(e.at)}
                    </span>
                  </div>
                  <HistoryBody entry={e} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function HistoryIcon({ kind }: { kind: StepHistoryEntry['kind'] }) {
  switch (kind) {
    case 'reject':
      return <X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />;
    case 'rerun':
      return <RefreshCw className="mt-0.5 h-3 w-3 shrink-0 text-warning" />;
    case 'auto_review':
      return <Bot className="mt-0.5 h-3 w-3 shrink-0 text-info" />;
    case 'approve':
      return <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />;
    case 'undo':
      return <Undo2 className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />;
    case 'dirty':
      return <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />;
    case 'annotate':
      return <Highlighter className="mt-0.5 h-3 w-3 shrink-0 text-primary" />;
  }
}

function HistoryLabel({ entry }: { entry: StepHistoryEntry }) {
  switch (entry.kind) {
    case 'reject':
      return (
        <span className="font-semibold text-destructive">
          Rejected
          {entry.sentBackToIdx !== undefined && (
            <span className="ml-1 font-normal text-muted-foreground">
              → step {entry.sentBackToIdx + 1}
            </span>
          )}
        </span>
      );
    case 'rerun':
      return <span className="font-semibold text-warning">Rerun</span>;
    case 'auto_review':
      return (
        <span className={cn('font-semibold', entry.decision === 'pass' ? 'text-success' : 'text-destructive')}>
          Auto-review {entry.decision === 'pass' ? '✓ pass' : '✕ reject'}
        </span>
      );
    case 'approve':
      return <span className="font-semibold text-success">Approved</span>;
    case 'undo':
      return (
        <span className="font-semibold text-muted-foreground">
          Mark done undone
          <span className="ml-1 font-normal">from {entry.from}</span>
        </span>
      );
    case 'dirty':
      return (
        <span className="font-semibold text-warning">
          Marked dirty
          <span className="ml-1 font-normal text-muted-foreground">
            step {entry.byStepIdx + 1} ({entry.byStep}) was rerun
          </span>
        </span>
      );
    case 'annotate':
      return (
        <span className="font-semibold text-primary">
          Annotated
          <span className="ml-1 font-normal text-muted-foreground">.md edited</span>
        </span>
      );
  }
}

function HistoryBody({ entry }: { entry: StepHistoryEntry }) {
  switch (entry.kind) {
    case 'reject':
      return entry.reason ? (
        <div className="font-mono text-foreground/80">↳ {entry.reason}</div>
      ) : null;
    case 'rerun':
      return entry.feedback ? (
        <div className="font-mono text-muted-foreground">↳ {entry.feedback}</div>
      ) : null;
    case 'auto_review':
      return (
        <div className="font-mono text-foreground/80">
          ↳ {entry.reason}
        </div>
      );
    case 'approve':
    case 'undo':
    case 'dirty':
      return null;
    case 'annotate':
      return (
        <div className="space-y-0.5">
          {entry.note && <div className="font-mono text-foreground/80">↳ {entry.note}</div>}
          {entry.summary && <div className="text-muted-foreground">✎ {entry.summary}</div>}
          {entry.author && <div className="text-muted-foreground/70">by {entry.author}</div>}
        </div>
      );
  }
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) { return iso; }
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function DetailValue({ children, empty }: { children: React.ReactNode; empty?: boolean }) {
  return (
    <div className={cn('leading-relaxed', empty ? 'text-muted-foreground italic' : 'text-foreground')}>
      {children}
    </div>
  );
}

function RunGate({
  epic,
  focused,
  focusedIdx,
  slashCommand,
  artifactName,
  artifactExists,
  artifactStale,
  activity,
  otherActivities,
  stepLabel,
}: {
  epic: EpicSummary;
  focused: EpicStepDetailFull;
  focusedIdx: number;
  slashCommand: string | undefined;
  /** The file this step is supposed to write, from `produces[0]` or the persona. */
  artifactName: string;
  artifactExists: boolean;
  /** Artifact is on disk but older than this step — inherited from an earlier step. */
  artifactStale: boolean;
  /** The dispatch on this step — what its gate buttons wait for. */
  activity: AgentActivity | null;
  /** Dispatches on sibling steps — they gate the whole-run action only. */
  otherActivities: AgentActivity[];
  stepLabel: (idx: number) => string;
}) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [autoRunOpen, setAutoRunOpen] = useState(false);
  if (!epic.runId) { return null; }
  // DAG pipelines may have several active steps; instead of gating on a
  // single "current" cursor, accept any focused step that's in an actionable
  // status. runStatusUi already filters out pending / approved.
  const ui = runStatusUi(focused.runStatus);
  if (!ui) { return null; }

  const status = focused.runStatus!;
  // While an agent we launched is still on *this step*, its gate buttons are
  // answers to a question that has not been asked yet: there is nothing to
  // mark done, approve or reject until the agent stops writing. The banner
  // above them carries a dismiss for the case where it did stop and we were
  // not told.
  //
  // A sibling step's agent is not this step's business. Parallel steps are the
  // point of a DAG, and gating them on each other turned two open steps into a
  // queue of one: the second could not be run, only watched.
  const busy = !!activity;
  const busyTitle = 'An agent is still working on this step — wait for it, or dismiss the banner above';
  // Running to completion drives the run itself, so it waits for every agent
  // on it — this step's and the siblings'.
  const runBusy = busy || otherActivities.length > 0;
  const runBusyTitle = busy
    ? busyTitle
    : `An agent is still working on ${otherActivities.map((a) => stepLabel(a.stepIdx!)).join(', ')} — wait for it, or dismiss its banner on that step`;
  // Marking done with no artifact on disk is not a choice the user gets to
  // make: `markStepDone` in core validates `produces` and throws. Leaving the
  // button live only turns that into an error toast after the click, and on a
  // step nobody has run yet it reads as an invitation to skip the work. A step
  // that declares no artifact keeps the button — there is nothing to check.
  const artifactMissing = !!artifactName && !artifactExists;
  const doneBlocked = busy || artifactMissing;
  // A stale artifact does *not* block: `markStepDone` accepts it, and a UI
  // that refuses what core allows is a dead end. Warn instead, so the file
  // sitting there is not mistaken for this step's output.
  const doneTitle = busy
    ? busyTitle
    : artifactMissing
    ? `${artifactName} has not been written yet — run the agent first`
    : artifactStale
    ? `${artifactName} has not changed since this step started — marking done records an artifact this step did not write`
    : undefined;
  const labels: Record<string, string> = {
    awaiting_work: 'Awaiting work',
    awaiting_auto_review: 'Awaiting auto-review',
    awaiting_review: 'Awaiting human review',
    rejected: 'Rejected',
  };
  const messages: Record<string, string> = {
    awaiting_work: 'Run the agent externally, then mark this step done to advance.',
    awaiting_work_missing: 'Nothing written yet. Run the agent — Mark step done unlocks once its artifact exists.',
    awaiting_work_stale:
      'This step shares its output file with an earlier step, and the file has not changed since this step started. Run the agent before marking done.',
    awaiting_auto_review: 'Auto-reviewer pending. Run it to validate this step.',
    awaiting_review:
      'Step is paused for your approval. Approve to advance, reject to send back.',
    rejected: 'This step was rejected. Rerun to bump revision and try again.',
    rejected_auto:
      'The auto-reviewer rejected this step. Fix the artifact and re-verify — ' +
      'rerunning instead discards it and bumps the revision.',
  };

  const cls = (() => {
    if (status === 'awaiting_work') {
      return 'bg-primary/5 border-primary/30 text-primary';
    }
    if (status === 'awaiting_auto_review' || status === 'awaiting_review') {
      return 'bg-warning/10 border-warning/40 text-warning';
    }
    if (status === 'rejected') {
      return 'bg-destructive/5 border-destructive/40 text-destructive';
    }
    return 'bg-muted border-border text-muted-foreground';
  })();

  // A rejection the *validator* produced is one the validator can take back:
  // fix the artifact, run the check again. A human's rejection is not, and
  // neither is a step whose auto-review gate has since been turned off.
  const canReverify =
    status === 'rejected' &&
    focused.stepHasAutoReview &&
    focused.autoReviewVerdict?.decision === 'reject';

  const gates: string[] = [];
  if (focused.stepHasAutoReview) { gates.push('🤖 auto-review'); }
  if (focused.stepHasHumanReview) { gates.push('👤 human review'); }

  return (
    <div className={cn('mt-4 space-y-2 rounded-md border p-3 text-[11.5px]', cls)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[9.5px] font-bold uppercase tracking-wider">
          {labels[status] ?? status}
        </span>
        <span className="flex-1 text-foreground/80">
          {busy
            ? 'An agent is working on this step. Wait for it to finish before advancing.'
            : status === 'awaiting_work' && artifactMissing
            ? messages.awaiting_work_missing
            : status === 'awaiting_work' && artifactStale
            ? messages.awaiting_work_stale
            : canReverify
            ? messages.rejected_auto
            : messages[status]}
        </span>
      </div>

      {activity && <AgentRunningBanner activity={activity} />}

      {/* The siblings do not block this step, but the user is owed the reason
          *Run to completion* is disabled, and a pointer to where the work is. */}
      {otherActivities.length > 0 && (
        <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-70" />
          <span>
            Also running in parallel: {otherActivities.map((a) => stepLabel(a.stepIdx!)).join(', ')}
          </span>
        </div>
      )}

      {status === 'rejected' && focused.rejectReason && (
        <ClampedNote
          text={`↳ ${focused.rejectReason.trim()}`}
          className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-[10.5px] text-destructive"
        />
      )}

      {status === 'awaiting_work' && focused.feedback && (
        <ClampedNote
          text={`↳ ${focused.feedback.trim()}`}
          className="rounded border border-warning/40 bg-warning/10 px-2 py-1 font-mono text-[10.5px] text-warning"
        />
      )}

      {focused.autoReviewVerdict && (
        <div
          className={cn(
            'rounded border px-2 py-1.5 text-[11px]',
            focused.autoReviewVerdict.decision === 'pass'
              ? 'border-success/30 bg-success/10'
              : 'border-destructive/40 bg-destructive/10',
          )}
        >
          <div
            className={cn(
              'flex items-center gap-1 font-semibold',
              focused.autoReviewVerdict.decision === 'pass' ? 'text-success' : 'text-destructive',
            )}
          >
            {focused.autoReviewVerdict.decision === 'pass' ? (
              <Bot className="h-3 w-3" />
            ) : (
              <Bot className="h-3 w-3" />
            )}
            <span>
              Auto-review:{' '}
              {focused.autoReviewVerdict.decision === 'pass' ? '✓ pass' : '✕ reject'}
            </span>
          </div>
          {focused.autoReviewVerdict.reason && (
            <div className="text-foreground/80">{focused.autoReviewVerdict.reason}</div>
          )}
        </div>
      )}

      {gates.length > 0 ? (
        <div className="text-[10.5px] italic text-foreground/70">
          Gates after Mark done: {gates.join(' → ')}
        </div>
      ) : status === 'awaiting_work' ? (
        <div className="text-[10.5px] italic text-muted-foreground">
          No review gates configured — Mark done will auto-approve and advance.
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {status === 'awaiting_work' && (
          <>
            {slashCommand && (() => {
              const hasFeedback = !!focused.feedback;
              return (
                <GateButton
                  variant="approve"
                  disabled={busy}
                  title={busy ? busyTitle : undefined}
                  onClick={() => {
                    if (hasFeedback) {
                      setRunOpen(true);
                    } else {
                      postMessage({
                        type: 'runStepWithFeedback',
                        runId: epic.runId!,
                        slashCommand,
                        feedback: '',
                        // Names the step this launch belongs to, so its banner
                        // lands here and not on every open sibling.
                        stepIdx: focusedIdx,
                      });
                    }
                  }}
                >
                  <Play className="h-3 w-3" />
                  {hasFeedback ? 'Update with feedback' : 'Run with Claude'}
                </GateButton>
              );
            })()}
            <GateButton
              variant="primary"
              disabled={doneBlocked}
              title={doneTitle}
              onClick={() => postMessage({ type: 'markStepDone', runId: epic.runId!, stepIdx: focusedIdx })}
            >
              Mark step done
            </GateButton>
          </>
        )}
        {status === 'awaiting_auto_review' && (
          <GateButton
            variant="primary"
            disabled={busy}
            title={busy ? busyTitle : undefined}
            onClick={() => postMessage({ type: 'runAutoReview', runId: epic.runId!, stepIdx: focusedIdx })}
          >
            Run auto-review
          </GateButton>
        )}
        {/* The misclick's way out. Mark done is one button away from Run, and
            until now the only path back was Request update — which bumps the
            revision and resets everything downstream to undo a wrong click. */}
        {focused.canUndoDone && (
          <GateButton
            variant="quiet"
            title="Put this step back to awaiting work — same revision, no artifact touched"
            onClick={() => postMessage({ type: 'undoStepDone', runId: epic.runId!, stepIdx: focusedIdx })}
          >
            <Undo2 className="h-3 w-3" /> Undo mark done
          </GateButton>
        )}
        {status === 'awaiting_review' && (
          <>
            <GateButton
              variant="approve"
              disabled={busy}
              title={busy ? busyTitle : undefined}
              onClick={() => postMessage({ type: 'approveStep', runId: epic.runId!, stepIdx: focusedIdx })}
            >
              <Check className="h-3 w-3" /> Approve
            </GateButton>
            <GateButton
              variant="reject"
              disabled={busy}
              title={busy ? busyTitle : undefined}
              onClick={() => setRejectOpen(true)}
            >
              <X className="h-3 w-3" /> Reject
            </GateButton>
          </>
        )}
        {canReverify && (
          <GateButton
            variant="approve"
            disabled={busy}
            title={
              busy
                ? busyTitle
                : 'Run the auto-reviewer again on the artifact as it stands — keeps the revision and the work'
            }
            onClick={() => postMessage({ type: 'retryAutoReview', runId: epic.runId!, stepIdx: focusedIdx })}
          >
            <ShieldCheck className="h-3 w-3" /> Re-verify
          </GateButton>
        )}
        {status === 'rejected' && (
          <GateButton
            variant="primary"
            disabled={busy}
            title={
              busy
                ? busyTitle
                : canReverify
                ? 'Discard this artifact and redo the step from scratch'
                : undefined
            }
            onClick={() => setRerunOpen(true)}
          >
            Rerun
          </GateButton>
        )}
        {/* Not per-status: the loop starts from wherever the run stands and
            clears auto-review, rejection is the one thing it cannot resume
            from — a rejected step needs feedback before rerunning. */}
        {status !== 'rejected' && (
          <GateButton
            variant="primary"
            disabled={runBusy}
            title={runBusy ? runBusyTitle : 'Execute every remaining step back to back'}
            onClick={() => setAutoRunOpen(true)}
          >
            <Zap className="h-3 w-3" /> Run to completion
          </GateButton>
        )}
      </div>

      {rejectOpen && epic.runId && (
        <RejectModal
          runId={epic.runId}
          currentStepIdx={focusedIdx}
          stepAgents={epic.stepDetails.map((d) => d.agent)}
          onClose={() => setRejectOpen(false)}
        />
      )}
      {rerunOpen && epic.runId && (
        <RerunModal
          runId={epic.runId}
          agent={focused.agent}
          rejectReason={focused.rejectReason}
          onSubmit={(feedback) =>
            postMessage({ type: 'rerunStepInline', runId: epic.runId!, feedback, stepIdx: focusedIdx })
          }
          onClose={() => setRerunOpen(false)}
        />
      )}
      {runOpen && epic.runId && slashCommand && (
        <RunWithFeedbackModal
          agent={focused.agent}
          runId={epic.runId}
          slashCommand={slashCommand}
          carriedFeedback={focused.feedback}
          onSubmit={(feedback) =>
            postMessage({
              type: 'runStepWithFeedback',
              runId: epic.runId!,
              slashCommand,
              feedback,
              stepIdx: focusedIdx,
            })
          }
          onClose={() => setRunOpen(false)}
        />
      )}
      {autoRunOpen && epic.runId && (
        <AutoRunModal
          runId={epic.runId}
          steps={epic.stepDetails.map((d) => ({
            agent: d.agent,
            hasHumanReview: !!d.stepHasHumanReview,
          }))}
          currentStepIdx={epic.currentStep ?? 0}
          onClose={() => setAutoRunOpen(false)}
        />
      )}
    </div>
  );
}

function GateButton({
  children,
  variant,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  variant: 'primary' | 'approve' | 'reject' | 'quiet';
  onClick: () => void;
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
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10.5px] font-semibold transition-colors',
        disabled && 'cursor-not-allowed opacity-40 hover:!border-inherit hover:!bg-inherit',
        variant === 'primary' &&
          'border-primary/40 bg-primary/15 text-primary hover:border-primary/60 hover:bg-primary/25',
        variant === 'approve' &&
          'border-success/40 bg-success/15 text-success hover:border-success/60 hover:bg-success/25',
        variant === 'reject' &&
          'border-destructive/40 bg-destructive/15 text-destructive hover:border-destructive/60 hover:bg-destructive/25',
        // For the way out of a click, not a decision about the work — it sits
        // beside the gate buttons without competing with them for the eye.
        variant === 'quiet' &&
          'border-border bg-transparent text-muted-foreground hover:border-foreground/40 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Can this epic's workflow still be swapped wholesale?
 *
 * The host refuses once any step has moved — core's `epicWorkflowLock` is the
 * real decision — so this only decides whether to offer the button. It reads
 * the same signals: a step past `awaiting_work`, a history entry, or a
 * rejection means work happened and the new step list would have nowhere to
 * put its record.
 */
function workflowStillSwappable(epic: EpicSummary): boolean {
  if (epic.artifactsOnly || epic.status === 'done' || epic.status === 'failed') { return false; }
  return epic.stepDetails.every((s) =>
    (s.runStatus === null || s.runStatus === 'pending' || s.runStatus === 'awaiting_work')
    && (s.history?.length ?? 0) === 0
    && (s.rejectCount ?? 0) === 0,
  );
}

function EpicActions({
  epic,
  hasInputs,
  busy,
  followUpCount,
}: {
  epic: EpicSummary;
  hasInputs: boolean;
  /**
   * An agent this window dispatched is working *any* step of the run.
   *
   * Deleting an epic out from under one leaves it writing into a folder whose
   * run state no longer exists — half-written artifacts in a directory nothing
   * points at. The button stayed live through all of it.
   */
  busy: boolean;
  /** Epics opened from this one. */
  followUpCount: number;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
      {/* A finished epic is offered no start button. The run file is gitignored
          and gets cleaned up, so `!epic.runId` on its own reads a done epic as
          one that never ran — and starting resets state.json to all-pending.
          The way forward from a done epic is a follow-up, not a rerun. */}
      {!epic.runId && epic.pipeline && epic.status !== 'done' && (
        <button
          type="button"
          onClick={() =>
            postMessage({
              type: 'startPipelineRunForEpic',
              epicId: epic.id,
              pipelineId: epic.pipeline,
            })
          }
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary-foreground hover:bg-primary/90"
        >
          <Play className="h-3 w-3" />
          Start pipeline run
        </button>
      )}
      {/* Stage 6 → stage 1. Offered only once the diagnosis exists: a follow-up
          opened before `incident.md` is written would carry an intent derived
          from the raw signal alone, which is the 3am guess the human gate at
          stage 1 exists to catch — and here nobody has even looked yet. */}
      {epic.hasSignal && epic.existingArtifacts.includes('incident.md') && (
        <button
          type="button"
          onClick={() => postMessage({ type: 'openFollowUpEpic', epicId: epic.id })}
          title="Open the epic that fixes this incident — starts at stage 1 with its intent seeded from the signal, for a human to review."
          className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-[11px] font-semibold text-primary hover:border-primary/60 hover:bg-primary/20"
        >
          <GitBranchPlus className="h-3 w-3" />
          Open follow-up epic
        </button>
      )}
      {/* Any step can hand work forward by writing followups.json. Shown on a
          done epic too — that is where a closing step leaves it. */}
      {epic.hasFollowUps && (
        <button
          type="button"
          onClick={() => postMessage({ type: 'openManifestFollowUps', epicId: epic.id })}
          title="Open epics from the work this epic handed forward (followups.json) — pick which; each starts at stage 1 with its intent already written."
          className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-[11px] font-semibold text-primary hover:border-primary/60 hover:bg-primary/20"
        >
          <GitBranchPlus className="h-3 w-3" />
          Open follow-up epics
        </button>
      )}
      {/* A done epic cannot re-run the step that declared the hook, so this is
          the way to re-run it: after a failure, or after opening more children. */}
      {(epic.hasFollowUps || followUpCount > 0) && (
        <button
          type="button"
          onClick={() => postMessage({ type: 'syncFollowUps', epicId: epic.id })}
          title="Run on_followups_opened again over every follow-up epic of this one (found by from_epic)."
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px] font-semibold',
            (epic.followUpHookFailures?.length ?? 0) > 0
              ? 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20'
              : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <RefreshCw className="h-3 w-3" />
          Sync follow-ups
        </button>
      )}
      {epic.statePath && (
        <button
          type="button"
          onClick={() => postMessage({ type: 'openEpicState', path: epic.statePath })}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FileText className="h-3 w-3" />
          Open state.json
        </button>
      )}
      {/* The Domain picker hides epic-owned pipelines, so this is the way in to
          the one this epic runs — Builder opens with it unhidden and selected.
          Which steps are still editable is the card's call: a run pins the ones
          it has locked. */}
      {epic.pipeline && (
        <button
          type="button"
          onClick={() =>
            postMessage({ type: 'openBuilderPipeline', pipelineId: epic.pipeline })
          }
          title={`Edit ${epic.pipeline} in the Builder — this epic's own workflow. Steps a run has already locked stay read-only.`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Workflow className="h-3 w-3" />
          Edit workflow
        </button>
      )}
      {/* Editing the steps is one thing; picking a different recipe altogether
          is another, and only possible while the run has nothing to lose. The
          host opens the same picker the Start Epic wizard uses. */}
      {workflowStillSwappable(epic) && (
        <button
          type="button"
          onClick={() => postMessage({ type: 'changeEpicWorkflow', epicId: epic.id })}
          title="Swap the recipe or pipeline this epic runs. Offered only until its first step moves — after that, add or remove steps instead."
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <GitBranchPlus className="h-3 w-3" />
          Change workflow
        </button>
      )}
      {hasInputs && (
        <button
          type="button"
          onClick={() => postMessage({ type: 'openInputsJson', epicDir: epic.epicDir })}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FileText className="h-3 w-3" />
          Open inputs.json
        </button>
      )}
      {/* Send the paths this epic's steps actually produce: a pipeline that
          writes outside the epic folder (docs/cr/...) has nothing in
          <epic>/artifacts, which is all this button used to reveal. */}
      <button
        type="button"
        onClick={() => postMessage({
          type: 'revealArtifacts',
          epicDir: epic.epicDir,
          paths: epic.stepDetails.flatMap((s) => (s.artifacts ?? []).filter((a) => a.exists).map((a) => a.path)),
        })}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Folder className="h-3 w-3" />
        Reveal artifacts
      </button>
      <button
        type="button"
        onClick={() => postMessage({ type: 'openEpicMemory', epicDir: epic.epicDir })}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        title="View this epic's memory digest (decisions, constraints, reflections) — shared context to continue the epic cheaply"
      >
        <Brain className="h-3 w-3" />
        Memory
      </button>
      <button
        type="button"
        onClick={() => setDeleteOpen(true)}
        disabled={busy}
        className={cn(
          'ml-auto inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-[11px] text-destructive',
          busy
            ? 'cursor-not-allowed opacity-40'
            : 'hover:border-destructive/60 hover:bg-destructive/15',
        )}
        title={
          busy
            ? 'An agent is still working on this epic — deleting it now would strand the work in progress'
            : 'Delete this epic — removes the run state, optionally the docs/epics folder too'
        }
      >
        <Trash2 className="h-3 w-3" />
        Delete
      </button>
      {deleteOpen && (
        <DeleteEpicModal
          epicId={epic.id}
          epicDir={epic.epicDir}
          hasRun={!!epic.runId}
          artifacts={epic.existingArtifacts}
          doneSteps={epic.stepDetails.filter((s) => s.status === 'done').length}
          onConfirm={(deleteFolder) =>
            postMessage({
              type: 'deleteEpic',
              epicId: epic.id,
              runId: epic.runId ?? undefined,
              deleteFolder,
              confirmed: true,
            })
          }
          onClose={() => setDeleteOpen(false)}
        />
      )}
    </div>
  );
}

// Suppress unused-import warnings for icons that are conditionally referenced.
const _ICONS = { ChevronDown, User };
void _ICONS;
