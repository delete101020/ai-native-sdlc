/**
 * Where a "Run to completion" shows its progress: a status bar item that lives
 * as long as the run, and a notification that can be closed and brought back.
 *
 * A `withProgress` notification the user hides cannot be reopened from code,
 * and one that stays open sits over the editor for the whole run. So the run
 * owns the status bar item, and the notification is only a view of it: "Show
 * progress" ends the current one (hidden or not) and opens a fresh one at the
 * same message, so there is never more than one per run.
 */

import * as vscode from 'vscode';

export const MENU_COMMAND = 'aidlcNative.execRun.menu';

/** What the user can ask of a run in flight. */
export interface ExecRunControls {
  /** Stop at the next step boundary. */
  stopAfterStep(): void;
  /** Kill the running step. */
  stopNow(): void;
  showLog(): void;
}

/** One step-start's worth of what the run says about itself. */
export interface StepProgress {
  /** Steps started by this run so far, this one included. */
  loop: number;
  stepIdx: number;
  total: number;
  label: string;
  revision: number;
  rejections: number;
}

/**
 * "loop 5 · step 4/7 · cr-review · rev 3 (rejected 2×)". The revision part
 * only on a rerun; the first pass at a step is the ordinary case and the line
 * is kept short for it.
 */
export function stepProgressMessage(p: StepProgress): string {
  const head = `loop ${p.loop} · step ${p.stepIdx + 1}/${p.total} · ${p.label}`;
  if (p.revision <= 1) { return head; }
  return `${head} · rev ${p.revision}${p.rejections > 0 ? ` (rejected ${p.rejections}×)` : ''}`;
}

const live = new Map<string, ExecRunProgress>();

export class ExecRunProgress implements vscode.Disposable {
  private message = 'starting…';
  private readonly item: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<string>();
  /** Ends the notification currently open, if any. */
  private closeNotification?: () => void;

  constructor(private readonly runId: string, private readonly controls: ExecRunControls) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 47);
    this.item.command = { command: MENU_COMMAND, title: 'Autopilot', arguments: [runId] };
    this.render();
    this.item.show();
    live.set(runId, this);
    if (vscode.workspace.getConfiguration('aidlcNative.autopilot')
      .get<string>('progressLocation', 'notification') !== 'statusBar') {
      this.showNotification();
    }
  }

  report(message: string): void {
    this.message = message;
    this.render();
    this.changed.fire(message);
  }

  showNotification(): void {
    this.closeNotification?.();
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `AIDLC · ${this.runId}`, cancellable: true },
      (progress, token) => new Promise<void>((resolve) => {
        progress.report({ message: this.message });
        const sub = this.changed.event((m) => progress.report({ message: m }));
        // Cancel stays what it always was here: the gentle stop.
        token.onCancellationRequested(() => this.controls.stopAfterStep());
        const close = () => {
          sub.dispose();
          if (this.closeNotification === close) { this.closeNotification = undefined; }
          resolve();
        };
        this.closeNotification = close;
      }),
    );
  }

  async menu(): Promise<void> {
    const items: Array<vscode.QuickPickItem & { run: () => void }> = [
      { label: '$(bell) Show progress', run: () => this.showNotification() },
      { label: '$(output) Show log', run: () => this.controls.showLog() },
      { label: '$(debug-pause) Stop after this step', run: () => this.controls.stopAfterStep() },
      { label: '$(debug-stop) Stop now', description: 'kills the running step', run: () => this.controls.stopNow() },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `AIDLC · ${this.runId} — ${this.message}` });
    pick?.run();
  }

  dispose(): void {
    this.closeNotification?.();
    this.changed.dispose();
    this.item.dispose();
    if (live.get(this.runId) === this) { live.delete(this.runId); }
  }

  private render(): void {
    this.item.text = `$(sync~spin) ${this.runId} · ${this.message}`;
    this.item.tooltip = `AIDLC autopilot · ${this.runId}\n${this.message}\n\nClick for progress, log and stop.`;
  }
}

export function registerExecRunProgress(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(MENU_COMMAND, async (runId?: string) => {
      const runs = [...live.values()];
      const target = (runId && live.get(runId))
        ?? (runs.length === 1 ? runs[0] : undefined)
        ?? await pickRun();
      if (!target) {
        if (live.size === 0) { void vscode.window.showInformationMessage('No autopilot run is in progress.'); }
        return;
      }
      await target.menu();
    }),
  );
}

async function pickRun(): Promise<ExecRunProgress | undefined> {
  if (live.size === 0) { return undefined; }
  const pick = await vscode.window.showQuickPick([...live.keys()], { title: 'Which autopilot run?' });
  return pick ? live.get(pick) : undefined;
}
