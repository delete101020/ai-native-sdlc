/**
 * Why a step is being run again, as the block appended to a headless step's
 * user message.
 *
 * The interactive path always passed it: "Run with Claude" puts the feedback in
 * the prompt, and the slash command's structural contract says to read the
 * epic's history. A headless run sent only the context pairs, so after a Send
 * back, "Run to completion" ran revision 2 with revision 1's prompt and no word
 * of what had been rejected. See AUTOPILOT_READINESS.md §G3.
 *
 * Kept short on purpose (D3): labels and content only, each piece once.
 */

import type { RunState, StepHistoryEntry } from './RunState';

export function revisionFeedback(state: RunState, stepIdx: number): string | null {
  const step = state.steps[stepIdx];
  if (!step || step.revision <= 1) { return null; }
  const history = step.history ?? [];
  const prev = step.revision - 1;

  // An in-place rejection lands on the step's own history. A send-back from a
  // later step does not — its reason arrives here as `feedback` instead.
  const reject = findLast(history, (h) => h.kind === 'reject' && h.revision === prev && h.sentBackToIdx === stepIdx);
  const reason = reject?.kind === 'reject' ? reject.reason?.trim() : undefined;

  // `feedback` is carried forward across reruns, so after a second rejection it
  // may still hold the first one's text. Only feedback that is new at this
  // revision is news; the older ones stay in the history.
  const carried = findLast(history, (h) => h.kind === 'rerun' && h.revision === prev);
  const fbRaw = step.feedback?.trim();
  const fb = fbRaw && !(carried?.kind === 'rerun' && carried.feedback?.trim() === fbRaw) ? fbRaw : undefined;

  const lines: string[] = [];
  if (reason && !fb?.includes(reason)) {
    lines.push(`Rejected at step ${stepIdx + 1} (${step.agent}): ${reason}`);
  }
  if (fb && !reason?.includes(fb)) { lines.push(fb); }
  if (lines.length === 0) { return null; }

  return [`Revision ${step.revision}. Address before anything else:`, ...lines.map((l) => `- ${l}`)].join('\n');
}

function findLast(
  entries: readonly StepHistoryEntry[],
  pred: (h: StepHistoryEntry) => boolean,
): StepHistoryEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (pred(entries[i])) { return entries[i]; }
  }
  return undefined;
}
