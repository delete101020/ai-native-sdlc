/**
 * Which run steps have an agent actually running right now.
 *
 * Until this existed the UI had exactly two facts about a step: what the run
 * JSON said, and nothing else. `awaiting_work` covers both "nobody has started
 * this yet" and "Claude has been writing the PRD for the last four minutes",
 * so the panel looked identical either way — it told the user to click *Mark
 * step done* the instant the step opened, and left Delete enabled while an
 * agent was mid-write. That is the gap this closes.
 *
 * ## What can and cannot be observed
 *
 * The extension only knows about work it dispatched itself. `Run with Claude`
 * spawns a terminal and runs `claude '<slash> <runId>'` in it, and *that*
 * process is observable: VS Code's shell integration reports when the command
 * ends, and the terminal reports when it closes. A step the user runs by
 * copying the slash command into their own Claude window is invisible to us
 * and always will be — nothing in the editor is party to that conversation.
 * So this registry is deliberately honest about its scope: it says "an agent
 * we started is still running", never "no agent is running".
 *
 * ## Why it expires
 *
 * A terminal without shell integration (an unusual shell, a remote that never
 * installs the hooks) gives us no end signal at all — only the close of the
 * terminal, which the user may never do. A busy flag that can get stuck is
 * worse than no busy flag, because it disables buttons. So every entry has an
 * age limit, applied lazily on read: past {@link MAX_AGE_MS} the entry simply
 * stops counting. The UI also offers a manual dismiss, because six hours is a
 * backstop, not a user experience.
 *
 * No `vscode` import here on purpose — the registry is a plain state machine
 * so it can be unit-tested, and the terminal events that drive it are wired up
 * at the one place that creates those terminals.
 */

/** One dispatched, not-yet-finished agent run. */
export interface AgentActivity {
  /** The run whose step is being worked. */
  runId: string;
  /** Step index within the run, when the dispatch named one. */
  stepIdx: number | null;
  /** What was sent to the terminal — shown in the tooltip. */
  command: string;
  /** `Date.now()` at dispatch. Drives the elapsed-time label and expiry. */
  startedAt: number;
  /**
   * True when the terminal came up with shell integration, i.e. we will be
   * told when the command finishes. False means the only end signals are the
   * terminal closing, the step transitioning, or expiry — the UI says so
   * rather than implying a precision it does not have.
   */
  tracked: boolean;
}

/**
 * How long an entry counts for. Long enough that a genuinely slow agent —
 * a full implement step on a large repo — is never cut off mid-flight, short
 * enough that a missed end signal clears itself within a working day.
 */
export const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Serialisable form handed to the webviews, keyed by run id. */
export type AgentActivityMap = Record<string, AgentActivity>;

export class AgentActivityRegistry {
  private readonly byRun = new Map<string, AgentActivity>();
  private readonly listeners = new Set<() => void>();

  /**
   * Subscribe to begin/end. Shaped like a VS Code event so callers can push
   * the result straight onto `context.subscriptions`.
   */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /**
   * Record a dispatch. One entry per run: a second dispatch for the same run
   * replaces the first, which is the honest reading — the user re-launched,
   * and it is the newer command we are waiting on.
   */
  begin(activity: AgentActivity): void {
    this.byRun.set(activity.runId, activity);
    this.emit();
  }

  /**
   * Note that the terminal for `runId` reported shell integration, so its end
   * will be observed. No-op once the entry is gone.
   */
  markTracked(runId: string): void {
    const found = this.byRun.get(runId);
    if (!found || found.tracked) { return; }
    this.byRun.set(runId, { ...found, tracked: true });
    this.emit();
  }

  /** Drop the entry for `runId`. Silent when there is nothing to drop. */
  end(runId: string): void {
    if (!this.byRun.delete(runId)) { return; }
    this.emit();
  }

  /** Drop everything — used when the workspace folder changes underneath us. */
  clear(): void {
    if (this.byRun.size === 0) { return; }
    this.byRun.clear();
    this.emit();
  }

  /** The live entry for `runId`, or undefined when idle or expired. */
  get(runId: string, now: number = Date.now()): AgentActivity | undefined {
    const found = this.byRun.get(runId);
    if (!found) { return undefined; }
    return now - found.startedAt < MAX_AGE_MS ? found : undefined;
  }

  /** True when an agent we started is still working this run. */
  isBusy(runId: string, now: number = Date.now()): boolean {
    return this.get(runId, now) !== undefined;
  }

  /**
   * Everything still live, for the webview payload. Expired entries are
   * dropped here rather than on a timer: nothing needs them gone until
   * somebody asks, and a timer would be one more thing to dispose.
   */
  snapshot(now: number = Date.now()): AgentActivityMap {
    const out: AgentActivityMap = {};
    for (const [runId, activity] of this.byRun) {
      if (now - activity.startedAt < MAX_AGE_MS) {
        out[runId] = activity;
      } else {
        this.byRun.delete(runId);
      }
    }
    return out;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A broken subscriber must not stop the others, and must never stop
        // an agent dispatch from being recorded.
      }
    }
  }
}

/** Process-wide registry — one VS Code window, one set of terminals. */
export const agentActivity = new AgentActivityRegistry();
