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
 * channel, progress to a cancellable notification, and every transition
 * refreshes the panel so the stepper moves as the run does.
 */

import * as vscode from 'vscode';
import { runExecLoop, type ExecOutcome } from '@aidlc/core';
import { agentActivity } from './agentActivity';

let channel: vscode.OutputChannel | undefined;
function log(line: string): void {
  if (!channel) { channel = vscode.window.createOutputChannel('AIDLC Autopilot'); }
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

  if (!channel) { channel = vscode.window.createOutputChannel('AIDLC Autopilot'); }
  channel.show(true);
  log(`\n─── ${new Date().toLocaleTimeString()}  ${runId}  (${label}) ───`);

  let outcome: ExecOutcome = { kind: 'error' };
  try {
    outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AIDLC · ${runId}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'starting…' });
        return runExecLoop(
          root,
          runId,
          { autoApprove: opts.autoApprove, untilIdx: opts.untilIdx ?? -1, shouldCancel: () => token.isCancellationRequested },
          {
            onOutput: (chunk) => channel!.append(chunk),
            onErrorOutput: (chunk) => channel!.append(chunk),
            onStepStart: (e) => {
              progress.report({ message: `step ${e.stepIdx + 1} · ${e.agent}` });
              log(`\n▶ step ${e.stepIdx + 1} · ${e.agent}${e.model ? ` (${e.model})` : ''}`);
              // The step index moved before the agent produced anything; the
              // panel should say which step is being worked, not the last one
              // that finished.
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
              log(`✔ step ${e.stepIdx + 1} · ${e.agent} → ${e.status}${cost}`);
              onChange();
            },
            onStepFailed: (e) => {
              log(`✖ step ${e.stepIdx + 1} · ${e.agent} — ${e.missing?.length
                ? `missing artifact(s): ${e.missing.join(', ')}`
                : e.message ?? 'failed'}`);
              onChange();
            },
            onAutoReviewStart: (e) => {
              progress.report({ message: `auto-review · ${e.agent}` });
              log(`🤖 auto-review · ${e.agent}`);
            },
            onAutoReviewResult: (e) => {
              log(`🤖 auto-review · ${e.agent} → ${e.decision}${e.reason ? ` — ${e.reason}` : ''}`);
              onChange();
            },
            onAutoApproved: (e) => { log(`👤 auto-approved · ${e.agent}`); onChange(); },
            onAwaitingReview: (e) => { log(`⏸ paused for your review · ${e.agent}`); },
            onRejected: (e) => { log(`⏸ step rejected · ${e.agent}`); },
            onBudget: (e) => {
              log(`💰 $${e.spent.toFixed(4)} of $${e.limit.toFixed(2)}${e.ok ? '' : ` — ${e.exceeded} ceiling crossed`}`);
            },
            onCancelled: () => { log('⏹ cancelled at a step boundary'); },
            onUntilStop: (e) => { log(`⏹ stopped after step ${e.untilIdx + 1} (--until)`); },
            onRunCompleted: () => { log('✅ run completed'); },
            onRunFailed: (reason) => { log(`✖ ${reason}`); },
          },
        );
      },
    );
  } catch (err) {
    log(`✖ ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    agentActivity.end(runId);
    inFlight.delete(runId);
    onChange();
  }

  reportOutcome(runId, outcome);
}

/** Turn the stop reason into the one notification the user gets. */
function reportOutcome(runId: string, outcome: ExecOutcome): void {
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
    case 'awaiting_review':
      show(`${runId} is paused for your review. Approve the step to carry on.`, 'warn');
      return;
    case 'rejected':
      show(`${runId} stopped: a step was rejected. Rerun it with feedback.`, 'warn');
      return;
    case 'budget_pause':
      show(`${runId} paused on its budget ceiling. Raise \`budget\` in the pipeline to continue.`, 'warn');
      return;
    case 'cancelled':
      show(`${runId} stopped after the step that was running finished.`, 'warn');
      return;
    default:
      show(`${runId} stopped on an error — see the AIDLC Autopilot log.`, 'error');
  }
}
