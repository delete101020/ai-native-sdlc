import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import { postMessage } from '@/lib/bridge';
import { cn } from '@/lib/utils';
import type { AgentActivity } from '@/lib/types';

/**
 * "An agent is working on this step right now."
 *
 * Shown wherever a run's step controls are, on both the sidebar card and the
 * epic card, so the two surfaces cannot disagree about whether a step is busy.
 *
 * The banner exists because `awaiting_work` says nothing about whether anyone
 * is working. It covered both "you have not started this" and "Claude is four
 * minutes into writing the PRD", and the panel rendered the second case as an
 * invitation to click *Mark step done* — on work that did not exist yet.
 *
 * Two honest limits are built into the wording:
 *
 *  - It only ever appears. Its absence means "we did not launch an agent for
 *    this", not "nothing is running" — a step run from the user's own Claude
 *    window is not visible to the extension at all.
 *  - When `tracked` is false the host has no completion signal (the terminal
 *    came up without shell integration), so it says "started" rather than
 *    "running" and leans on the dismiss button.
 */
export function AgentRunningBanner({
  activity,
  className,
}: {
  activity: AgentActivity;
  className?: string;
}) {
  const elapsed = useElapsed(activity.startedAt);

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5 text-[11px] text-primary',
        className,
      )}
      title={activity.command}
    >
      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      <span className="font-semibold">
        {activity.tracked ? 'Agent running' : 'Agent started'}
      </span>
      <span className="tabular-nums text-primary/70">{elapsed}</span>
      {!activity.tracked && (
        <span className="truncate text-[10px] text-primary/70">
          — no completion signal from this shell
        </span>
      )}
      <button
        type="button"
        onClick={() => postMessage({ type: 'clearAgentActivity', runId: activity.runId })}
        title="The agent has finished — clear this and re-enable the step controls"
        className="ml-auto shrink-0 rounded p-0.5 text-primary/70 hover:bg-primary/20 hover:text-primary"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * `m:ss` since `startedAt`, re-rendered every second.
 *
 * A static "agent running" badge is indistinguishable from a stuck one; a
 * number that moves is the cheapest possible proof that the panel is still
 * alive, and it is also the thing the user actually wants to know when they
 * are deciding whether to wait or intervene.
 */
function useElapsed(startedAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mins = Math.floor(secs / 60);
  if (mins >= 60) {
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  }
  return `${mins}:${String(secs % 60).padStart(2, '0')}`;
}
