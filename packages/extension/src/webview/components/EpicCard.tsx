import { useEffect, useRef, useState } from 'react';
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
  Zap,
  AlertTriangle,
  ShieldCheck,
  ClipboardList,
  Trash2,
  Gauge,
  Workflow,
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
import { RejectModal } from './RejectModal';
import { RerunModal } from './RerunModal';
import { RunWithFeedbackModal } from './RunWithFeedbackModal';
import { RequestUpdateModal } from './RequestUpdateModal';
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
   * Set while an agent this window dispatched for the epic's run is still
   * working. Null covers both "idle" and "running somewhere we cannot see" —
   * the UI adds a busy state from this, it never infers an idle one.
   */
  activity?: AgentActivity | null;
  /** The incident this epic was opened from (`from_epic` in inputs.json). */
  fromEpic?: string | null;
  /** Epics opened from this one. Non-empty only on an incident epic. */
  followUps?: string[];
  /** Jump the list to another epic — expands it, scrolls to it, highlights it. */
  onNavigate?: (epicId: string) => void;
}

export function EpicCard({
  epic,
  agentMeta,
  slashCommandsByAgent,
  focusNonce = 0,
  activity = null,
  fromEpic = null,
  followUps = [],
  onNavigate,
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
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex items-center gap-1.5">
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
            />
          )}

          {focused && (
            <StepDetail
              epic={epic}
              focusedIdx={focusedIdx}
              focused={focused}
              meta={agentMeta[focused.agent]}
              activity={activity}
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

          <EpicActions epic={epic} hasInputs={inputKeys.length > 0} activity={activity} />
        </div>
      )}
    </div>
  );
}

/**
 * Epic description. When the full requirement lives in an `init-requirement.md`
 * (or similarly named) artifact, keep the card concise by showing a link to
 * open that file instead of dumping the text inline. Falls back to the plain
 * description when no such file exists.
 */
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

function EpicDescription({ epic }: { epic: EpicSummary }) {
  const reqFile = epic.existingArtifacts.find((f) =>
    /init.?requirements?.*\.md$/i.test(f),
  );
  if (reqFile) {
    return (
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
    );
  }
  const desc = (epic.description ?? '').trim();
  if (!desc) { return null; }
  return (
    <p className="text-xs italic leading-relaxed text-muted-foreground">{desc}</p>
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
}: {
  steps: EpicStepDetailFull[];
  currentStep: number;
  focusedIdx: number;
  onFocus: (idx: number) => void;
}) {
  const isDag = steps.some((s) => (s.dependsOn?.length ?? 0) > 0);
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface/50 p-3">
      {isDag ? (
        <DagStepper steps={steps} currentStep={currentStep} focusedIdx={focusedIdx} onFocus={onFocus} />
      ) : (
        <LinearStepper steps={steps} currentStep={currentStep} focusedIdx={focusedIdx} onFocus={onFocus} />
      )}
    </div>
  );
}

function LinearStepper({
  steps,
  currentStep,
  focusedIdx,
  onFocus,
}: {
  steps: EpicStepDetailFull[];
  currentStep: number;
  focusedIdx: number;
  onFocus: (idx: number) => void;
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
}: {
  steps: EpicStepDetailFull[];
  currentStep: number;
  focusedIdx: number;
  onFocus: (idx: number) => void;
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
  onFocus,
}: {
  step: EpicStepDetailFull;
  idx: number;
  /** Optional display label — DAG mode passes `<level>.<n>`, linear mode lets us fall back to `idx + 1`. */
  label?: string;
  isCurrent: boolean;
  isFocused: boolean;
  onFocus: () => void;
}) {
  // Pending step that carries history was previously approved and got reset
  // by a downstream Request-Update — surface that as a warning-tinted state
  // separate from never-touched pending.
  const isAwaitingUpdate = step.status === 'pending' && (step.history ?? []).length > 0;
  const inner =
    step.status === 'done'
      ? <Check className="h-3.5 w-3.5" />
      : step.status === 'failed'
        ? <X className="h-3.5 w-3.5" />
        : (label ?? String(idx + 1));
  return (
    <button
      type="button"
      onClick={onFocus}
      className="group flex flex-col items-center gap-1 px-1"
      title={`${step.stepName ?? step.agent}${step.stepName && step.stepName !== step.agent ? ` · agent ${step.agent}` : ''} — ${isAwaitingUpdate ? 'awaiting update' : STEP_LABEL[step.status]}`}
    >
      <div
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold transition-all',
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
}: {
  epic: EpicSummary;
  focusedIdx: number;
  focused: EpicStepDetailFull;
  meta: AgentMeta | undefined;
  slashCommand: string | undefined;
  activity: AgentActivity | null;
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
  const artifactExists = artifactName ? epic.existingArtifacts.includes(artifactName) : false;
  const [artifactMenuOpen, setArtifactMenuOpen] = useState(false);

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
                title={`Open ${artifactName}`}
              >
                <span>{artifactName}</span>
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
                        postMessage({ type: 'openArtifactFile', epicDir: epic.epicDir, filename: artifactName });
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
                    >
                      <FileText className="h-3 w-3 text-muted-foreground" />
                      <span>Open Markdown</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setArtifactMenuOpen(false);
                        postMessage({ type: 'previewArtifactInVsCode', epicDir: epic.epicDir, filename: artifactName });
                      }}
                      className="flex w-full items-center gap-2 border-t border-border px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-accent"
                      title="Render in VS Code's own Markdown preview — no terminal, no browser. Mermaid diagrams need a Markdown-preview extension; use Preview below for those."
                    >
                      <Eye className="h-3 w-3 text-muted-foreground" />
                      <span>Preview (VS Code)</span>
                    </button>
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
        activity={activity}
      />
      <RequestUpdateAction epic={epic} focused={focused} focusedIdx={focusedIdx} />
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

function StepHistory({ step }: { step: EpicStepDetailFull }) {
  const [open, setOpen] = useState(false);
  const entries = step.history ?? [];
  if (entries.length === 0) { return null; }

  const rejectCount = step.rejectCount ?? 0;
  const rerunCount = entries.filter((e) => e.kind === 'rerun').length;
  const annotateCount = entries.filter((e) => e.kind === 'annotate').length;
  const lastReject = [...entries].reverse().find((e) => e.kind === 'reject') as
    | (StepHistoryEntry & { kind: 'reject' })
    | undefined;

  const summary = [
    rejectCount > 0 && `rejected ${rejectCount}×`,
    rerunCount > 0 && `rerun ${rerunCount}×`,
    annotateCount > 0 && `annotated ${annotateCount}×`,
    !rejectCount && entries.some((e) => e.kind === 'approve') && 'approved',
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
  activity,
}: {
  epic: EpicSummary;
  focused: EpicStepDetailFull;
  focusedIdx: number;
  slashCommand: string | undefined;
  /** The file this step is supposed to write, from `produces[0]` or the persona. */
  artifactName: string;
  artifactExists: boolean;
  activity: AgentActivity | null;
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
  // While an agent we launched is still on this run, the gate buttons are
  // answers to a question that has not been asked yet: there is nothing to
  // mark done, approve or reject until the agent stops writing. The banner
  // above them carries a dismiss for the case where it did stop and we were
  // not told.
  const busy = !!activity;
  const busyTitle = 'An agent is still working on this run — wait for it, or dismiss the banner above';
  // Marking done with no artifact on disk is not a choice the user gets to
  // make: `markStepDone` in core validates `produces` and throws. Leaving the
  // button live only turns that into an error toast after the click, and on a
  // step nobody has run yet it reads as an invitation to skip the work. A step
  // that declares no artifact keeps the button — there is nothing to check.
  const artifactMissing = !!artifactName && !artifactExists;
  const doneBlocked = busy || artifactMissing;
  const doneTitle = busy
    ? busyTitle
    : artifactMissing
    ? `${artifactName} has not been written yet — run the agent first`
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
    awaiting_auto_review: 'Auto-reviewer pending. Run it to validate this step.',
    awaiting_review:
      'Step is paused for your approval. Approve to advance, reject to send back.',
    rejected: 'This step was rejected. Rerun to bump revision and try again.',
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
            : messages[status]}
        </span>
      </div>

      {activity && <AgentRunningBanner activity={activity} />}

      {status === 'rejected' && focused.rejectReason && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-[10.5px] text-destructive">
          ↳ {focused.rejectReason}
        </div>
      )}

      {status === 'awaiting_work' && focused.feedback && (
        <div className="rounded border border-warning/40 bg-warning/10 px-2 py-1 font-mono text-[10.5px] text-warning">
          ↳ {focused.feedback}
        </div>
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
        {status === 'rejected' && (
          <GateButton
            variant="primary"
            disabled={busy}
            title={busy ? busyTitle : undefined}
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
            disabled={busy}
            title={busy ? busyTitle : 'Execute every remaining step back to back'}
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
  variant: 'primary' | 'approve' | 'reject';
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
      )}
    >
      {children}
    </button>
  );
}

function EpicActions({
  epic,
  hasInputs,
  activity,
}: {
  epic: EpicSummary;
  hasInputs: boolean;
  activity: AgentActivity | null;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Deleting an epic out from under a running agent leaves the agent writing
  // into a folder whose run state no longer exists — half-written artifacts in
  // a directory nothing points at. The button stayed live through all of it.
  const busy = !!activity;
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
      <button
        type="button"
        onClick={() => postMessage({ type: 'revealArtifacts', epicDir: epic.epicDir })}
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
