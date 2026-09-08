import { useEffect, useState } from 'react';
import { X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { postMessage } from '@/lib/bridge';

export interface AutoRunStep {
  agent: string;
  /** Whether this step pauses for a person once its artifact is written. */
  hasHumanReview: boolean;
}

interface Props {
  runId: string;
  steps: AutoRunStep[];
  /** Where the run is standing now — the first step the loop will execute. */
  currentStepIdx: number;
  onClose: () => void;
}

/**
 * Options for "Run to completion" — the unattended loop that executes every
 * remaining step without a click between them.
 *
 * Two decisions, and both are about where it stops: whether human-review gates
 * pause it, and whether it runs to the end or halts at a step you name. The
 * gates it cannot be told to ignore — auto-review rejecting an artifact, a
 * budget ceiling, a runner exiting non-zero — are listed rather than offered,
 * because they are what makes leaving the loop alone reasonable.
 */
export function AutoRunModal({ runId, steps, currentStepIdx, onClose }: Props) {
  const [autoApprove, setAutoApprove] = useState(false);
  const [until, setUntil] = useState<'end' | number>('end');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const remaining = steps
    .map((s, idx) => ({ ...s, idx }))
    .filter((s) => s.idx >= currentStepIdx);
  const gated = remaining.filter((s) => s.hasHumanReview);
  const firstGate = gated[0];

  const submit = () => {
    postMessage({
      type: 'execRun',
      runId,
      autoApprove,
      ...(until === 'end' ? {} : { untilIdx: until }),
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-popover p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="autorun-modal-title"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2
              id="autorun-modal-title"
              className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
            >
              <Zap className="h-3.5 w-3.5 text-primary" />
              Run to completion
            </h2>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              Executes {remaining.length} remaining step{remaining.length === 1 ? '' : 's'} of{' '}
              <span className="font-mono text-foreground/80">{runId}</span> back to back —
              spawning each agent, checking its artifact, advancing.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Cancel (Esc)"
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
          Human review
        </div>
        {gated.length === 0 ? (
          <p className="rounded-md border border-border bg-card/50 px-2.5 py-2 text-[11.5px] text-muted-foreground">
            No remaining step is gated on a person — the loop runs to the end either way.
          </p>
        ) : (
          <label
            className={cn(
              'flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-[11.5px] transition-colors',
              autoApprove
                ? 'border-warning/50 bg-warning/10'
                : 'border-border bg-card/50 hover:border-border/80',
            )}
          >
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-warning"
            />
            <span>
              <span className="font-medium text-foreground">Approve gated steps for me</span>
              <span className="mt-0.5 block text-muted-foreground">
                {autoApprove ? (
                  <>
                    {gated.length} step{gated.length === 1 ? '' : 's'} (
                    <span className="font-mono">{gated.map((s) => s.agent).join(', ')}</span>) will
                    be approved unread. Auto-review still has to pass first.
                  </>
                ) : (
                  <>
                    Leave it off and the loop stops at{' '}
                    <span className="font-mono text-foreground/80">{firstGate.agent}</span> for you
                    to read. Approve there and press this again to carry on.
                  </>
                )}
              </span>
            </span>
          </label>
        )}

        <div className="mb-1.5 mt-4 text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
          Stop after
        </div>
        <select
          value={until === 'end' ? 'end' : String(until)}
          onChange={(e) => setUntil(e.target.value === 'end' ? 'end' : Number(e.target.value))}
          className="w-full rounded-md border border-border bg-input/50 px-2.5 py-1.5 text-[12px] text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
        >
          <option value="end">The last step — run the pipeline out</option>
          {remaining.map((s) => (
            <option key={s.idx} value={s.idx}>
              Step {s.idx + 1} · {s.agent}
            </option>
          ))}
        </select>

        <p className="mt-4 text-[10.5px] leading-relaxed text-muted-foreground">
          It stops on its own if auto-review rejects an artifact, a step's agent exits non-zero,
          or the pipeline's budget ceiling is crossed. Output goes to{' '}
          <span className="font-mono text-foreground/80">Output → AIDLC Autopilot</span>, and the
          progress notification carries a Cancel that takes effect once the step in flight
          finishes.
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-[11.5px] font-medium text-muted-foreground hover:border-border/80 hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-md border border-primary/50 bg-primary/15 px-3 py-1.5 text-[11.5px] font-semibold text-primary hover:border-primary hover:bg-primary/25"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
