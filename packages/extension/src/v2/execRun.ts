/**
 * "Run to completion" — the unattended exec loop, driven from the panel.
 *
 * `runExecLoop` was extracted into `@aidlc/core` precisely so both front ends
 * could drive a run with their own presentation, and then only the CLI ever
 * called it: from the editor the user had to advance a pipeline one button at
 * a time, or leave for a terminal. This is the extension's half of that split.
 *
 * The loop spawns each step's runner in the extension host, so unlike
 * `Run with Claude` there is no terminal to read. Output goes to an output
 * channel, progress to a status bar item and a notification that can be
 * closed and reopened from it (`execRunProgress`), and every transition
 * refreshes the panel so the stepper moves as the run does.
 */

import * as vscode from 'vscode';
import { runExecLoop, type ExecOutcome } from '@aidlc/core';
import { agentActivity } from './agentActivity';
import { ExecRunProgress, stepProgressMessage } from './execRunProgress';

let channel: vscode.OutputChannel | undefined;
function log(line: string): void {
  if (!channel) { channel = vscode.window.createOutputChannel('AIDLC Native Autopilot'); }
  channel.appendLine(line);
}

/**
 * Runs with a loop already in flight in this window. A second dispatch for the
 * same run would have two loops racing on one `state.json`, each reloading the
 * other's writes mid-step.
 */
const inFlight = new Set<string>();

/** True while this window is driving `runId` to completion. */
export function isExecRunning(runId: string): boolean {
  return inFlight.has(runId);
}

/**
 * VS Code launched from the Dock (macOS) inherits a minimal PATH with no
 * nvm/homebrew bin on it, so the `claude` the runner spawns is not found.
 * The terminal path augments PATH the same way; the loop spawns in-process,
 * so it has to be done here. Idempotent, and a no-op on Windows where these
 * directories do not exist.
 */
function ensureRunnerPath(): void {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME ?? ''}/.local/bin`]
    .filter((p) => p && !(process.env.PATH ?? '').split(':').includes(p));
  if (extra.length === 0) { return; }
  process.env.PATH = `${process.env.PATH ?? ''}:${extra.join(':')}`;
}

export interface ExecRunOptions {
  /** Clear human_review gates without pausing. */
  autoApprove: boolean;
  /** Stop after this step index; omitted runs to the end. */
  untilIdx?: number;
  /**
   * Start on top of uncommitted changes. Never set up front: only offered
   * after the preflight refused on them, by the button on that refusal.
   */
  allowDirty?: boolean;
}

/**
 * Drive `runId` to completion (or to the first gate it cannot clear).
 *
 * `onChange` fires after every transition the loop makes so the caller can
 * redraw — the run's `state.json` is written by core, and nothing else in the
 * editor is watching it closely enough to keep a stepper honest.
 */
export async function execRunToCompletion(
  root: string,
  runId: string,
  opts: ExecRunOptions,
  onChange: () => void,
): Promise<void> {
  if (inFlight.has(runId)) {
    void vscode.window.showWarningMessage(`${runId} is already running to completion.`);
    return;
  }
  ensureRunnerPath();
  inFlight.add(runId);

  const label = opts.autoApprove ? 'run exec --auto-approve' : 'run exec';
  agentActivity.begin({
    runId,
    stepIdx: null,
    command: `aidlc ${label} ${runId}`,
    startedAt: Date.now(),
    // The loop spawns in this process and we await it: unlike a terminal, an
    // end signal is guaranteed. The finally below always clears the entry.
    tracked: true,
  });
  onChange();

  if (!channel) { channel = vscode.window.createOutputChannel('AIDLC Native Autopilot'); }
  channel.show(true);
  log(`\n─── ${new Date().toLocaleTimeString()}  ${runId}  (${label}) ───`);

  let outcome: ExecOutcome = { kind: 'error' };
  // Why the loop gave up, for the notification — the log has it too, but an
  // autopilot preflight refusal is the user's to fix and should not need it.
  let failure: string | undefined;
  // The gentle stop (Cancel on the notification, or the status bar menu) lets
  // the running step finish; "Stop now" kills it.
  const stopNow = new AbortController();
  let stopRequested = false;
  const killStep = () => {
    if (stopNow.signal.aborted) { return; }
    log('⏹ stopping the running step now');
    stopNow.abort();
  };
  const status = new ExecRunProgress(runId, {
    stopAfterStep: () => {
      if (!stopRequested) {
        stopRequested = true;
        log('⏹ stopping after the running step finishes');
      }
      void vscode.window.showWarningMessage(
        `${runId} will stop after the running step finishes.`,
        'Stop now',
      ).then((pick) => { if (pick) { killStep(); } });
    },
    stopNow: killStep,
    showLog: () => channel?.show(),
  });
  // Steps this run has started — a step sent back and run again counts each
  // time, so a run going round in circles shows it.
  let loop = 0;
  try {
    outcome = await runExecLoop(
      root,
      runId,
      {
        autoApprove: opts.autoApprove,
        allowDirty: opts.allowDirty,
        untilIdx: opts.untilIdx ?? -1,
        shouldCancel: () => stopRequested,
        signal: stopNow.signal,
      },
      {
        onOutput: (chunk) => channel!.append(chunk),
        onErrorOutput: (chunk) => channel!.append(chunk),
        onStepStart: (e) => {
          const message = stepProgressMessage({ ...e, loop: ++loop });
          status.report(message);
          log(`\n▶ ${message}${e.model ? ` (${e.model})` : ''}`);
          // The step index moved before the agent produced anything; the
          // panel should say which step is being worked, not the last one
          // that finished. The loop runs one step at a time, so its own
          // earlier entries — the run-wide one from launch, the previous
          // step's — are all stale now that this step has started.
          agentActivity.end(runId);
          agentActivity.begin({
            runId, stepIdx: e.stepIdx, command: `aidlc ${label} ${runId}`,
            startedAt: Date.now(), tracked: true,
          });
          onChange();
        },
        onStepResult: (e) => {
          const cost = typeof e.costUsd === 'number'
            ? ` · $${e.costUsd.toFixed(4)}${e.costEstimated ? ' (est)' : ''}`
            : '';
          log(`✔ step ${e.stepIdx + 1} · ${e.label} → ${e.status}${cost}`);
          onChange();
        },
        onStepFailed: (e) => {
          log(`✖ step ${e.stepIdx + 1} · ${e.label} — ${e.missing?.length
            ? `missing artifact(s): ${e.missing.join(', ')}`
            : e.message ?? 'failed'}`);
          onChange();
        },
        onAutoReviewStart: (e) => {
          status.report(`loop ${loop} · auto-review · ${e.label}`);
          log(`🤖 auto-review · ${e.label}`);
        },
        onAutoReviewResult: (e) => {
          const back = e.sentBackTo
            ? `, sent back to ${e.sentBackTo.label} (rev ${e.sentBackTo.revision}, ${e.sentBackTo.count} of ${e.sentBackTo.max})`
            : '';
          log(`🤖 auto-review · ${e.label} → ${e.decision}${back}${e.reason ? ` — ${e.reason}` : ''}`);
          onChange();
        },
        onAutoApproved: (e) => { log(`👤 auto-approved · ${e.label}`); onChange(); },
        onAwaitingReview: (e) => { log(`⏸ paused for your review · ${e.label}`); },
        onRejected: (e) => { log(`⏸ step rejected · ${e.label}`); },
        onStalled: (e) => { log(`⏸ ${e.reason}`); onChange(); },
        onBatchDone: (e) => {
          const cost = typeof e.costUsd === 'number' ? ` · $${e.costUsd.toFixed(4)}` : '';
          log(`↻ step ${e.stepIdx + 1} · ${e.label} — batch ${e.batch} done, next batch in a fresh session${cost}`);
          onChange();
        },
        onBatchPause: (e) => {
          log(`⏸ batch ${e.batch} of ${e.label} done — pausing between batches${e.report ? ` (progress: ${e.report})` : ''}`);
          onChange();
        },
        onStepStopped: (e) => {
          log(`⏹ stopped ${e.label} mid-step (rev ${e.revision}) — still awaiting work; check git status for what it left`);
          onChange();
        },
        onStepSkipped: (e) => {
          log(`⤳ step rejected but optional · ${e.label} — moving to step ${e.nextStepIdx + 1}`);
          onChange();
        },
        onStepBypassed: (e) => {
          log(`⤳ not running ${e.label} — not needed on the way — moving to step ${e.nextStepIdx + 1} · ${e.nextLabel}`);
          onChange();
        },
        onBudget: (e) => {
          log(`💰 $${e.spent.toFixed(4)} of $${e.limit.toFixed(2)}${e.ok ? '' : ` — ${e.exceeded} ceiling crossed`}`);
        },
        onCancelled: () => { log('⏹ cancelled at a step boundary'); },
        onUntilStop: (e) => { log(`⏹ stopped after step ${e.untilIdx + 1} (--until)`); },
        onAttendedStep: (e) => { log(`⏹ stopped before step ${e.stepIdx + 1} · ${e.label} — a person runs it`); },
        onRunCompleted: () => { log('✅ run completed'); },
        onRunFailed: (reason) => { failure = reason; log(`✖ ${reason}`); },
        onPreflightNote: (message) => log(`⚠ ${message}`),
      },
    );
  } catch (err) {
    log(`✖ ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    status.dispose();
    agentActivity.end(runId);
    inFlight.delete(runId);
    onChange();
  }

  if (outcome.kind === 'error' && outcome.dirty) {
    offerAllowDirty(root, runId, opts, onChange, outcome.dirty);
    return;
  }
  reportOutcome(runId, outcome, failure);
}

/**
 * The preflight refused only because the tree has uncommitted changes nobody
 * can vouch for — typically a step that died before this run recorded what it
 * left. Whether they are this run's own unfinished work is the user's call, so
 * the panel's answer to `--allow-dirty` is a button on that refusal rather
 * than a setting that could be left on.
 */
function offerAllowDirty(
  root: string,
  runId: string,
  opts: ExecRunOptions,
  onChange: () => void,
  dirty: string[],
): void {
  const carryOn = 'Carry on with them';
  const shown = dirty.length <= 3
    ? dirty.join(', ')
    : `${dirty.slice(0, 3).join(', ')} and ${dirty.length - 3} more`;
  void vscode.window.showWarningMessage(
    `${runId} did not start: the working tree has uncommitted changes (${shown}). ` +
    'Commit or stash them, or — if they are this run\'s own unfinished work — carry on with them.',
    carryOn,
    'Show log',
  ).then((pick) => {
    if (pick === carryOn) {
      void execRunToCompletion(root, runId, { ...opts, allowDirty: true }, onChange);
    } else if (pick) {
      channel?.show();
    }
  });
}

/** Turn the stop reason into the one notification the user gets. */
function reportOutcome(runId: string, outcome: ExecOutcome, failure?: string): void {
  const show = (msg: string, kind: 'info' | 'warn' | 'error' = 'info') => {
    const fn = kind === 'error'
      ? vscode.window.showErrorMessage
      : kind === 'warn'
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;
    void fn(msg, 'Show log').then((pick) => { if (pick) { channel?.show(); } });
  };
  switch (outcome.kind) {
    case 'completed':
      show(`${runId} completed — every step approved.`);
      return;
    case 'until':
      show(`${runId} stopped at the step you asked for.`);
      return;
    case 'attended':
      show(`${runId} ran everything it can alone. The next step is yours to run.`);
      return;
    case 'awaiting_review':
      show(`${runId} is paused for your review. Approve the step to carry on.`, 'warn');
      return;
    case 'rejected':
      show(`${runId} stopped: a step was rejected. Rerun it with feedback.`, 'warn');
      return;
    case 'stalled':
      show(`${runId} stopped: a step needs you to look before it goes round again. The log says why.`, 'warn');
      return;
    case 'budget_pause':
      show(`${runId} paused on its budget ceiling. Raise \`budget\` in the pipeline to continue.`, 'warn');
      return;
    case 'batch_pause':
      show(`${runId} paused between batches. Read the progress, then run it to completion again for the next batch.`, 'warn');
      return;
    case 'cancelled':
      show(`${runId} stopped. Run it to completion again to carry on.`, 'warn');
      return;
    default:
      show(failure
        ? `${runId}: ${failure.replace(/\s*\n\s*/g, ' ')}`
        : `${runId} stopped on an error — see the AIDLC Autopilot log.`, 'error');
  }
}
