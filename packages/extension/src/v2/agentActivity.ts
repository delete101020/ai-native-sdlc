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

/**
 * Serialisable form handed to the webviews: every live entry for a run, keyed
 * by run id.
 *
 * A list, not a single entry, because a DAG pipeline opens its parallel steps
 * together — `spec` and `test-plan` can each have an agent on them at the same
 * moment, and a per-run slot made the second dispatch erase the first. The UI
 * then reported one banner for both: focusing the idle sibling still said
 * "agent running" and kept its Run button disabled.
 */
export type AgentActivityMap = Record<string, AgentActivity[]>;

/**
 * Identity of one entry: a run plus the step it was dispatched for. A dispatch
 * that named no step (`null`) gets its own slot — "an agent is on this run, we
 * do not know which step" is a different fact from "an agent is on step 3",
 * and must not overwrite it.
 */
function keyOf(runId: string, stepIdx: number | null): string {
  return `${runId}\u0000${stepIdx === null ? '*' : stepIdx}`;
}

export class AgentActivityRegistry {
  private readonly entries = new Map<string, AgentActivity>();
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
   * Record a dispatch. One entry per run *and step*: a second dispatch for the
   * same step replaces the first, which is the honest reading — the user
   * re-launched, and it is the newer command we are waiting on. A dispatch for
   * a sibling step is a separate entry and leaves this one alone.
   */
  begin(activity: AgentActivity): void {
    this.entries.set(keyOf(activity.runId, activity.stepIdx), activity);
    this.emit();
  }

  /**
   * Note that the terminal for this dispatch reported shell integration, so
   * its end will be observed. No-op once the entry is gone.
   */
  markTracked(runId: string, stepIdx: number | null = null): void {
    const key = keyOf(runId, stepIdx);
    const found = this.entries.get(key);
    if (!found || found.tracked) { return; }
    this.entries.set(key, { ...found, tracked: true });
    this.emit();
  }

  /**
   * Drop entries for `runId`. With a `stepIdx` — including an explicit `null`,
   * the unattributed slot — only that one goes; without one, every entry the
   * run has, which is what a run-wide signal such as the exec loop finishing
   * actually means. Silent when there is nothing to drop.
   */
  end(runId: string, stepIdx?: number | null): void {
    if (stepIdx !== undefined) {
      if (!this.entries.delete(keyOf(runId, stepIdx))) { return; }
      this.emit();
      return;
    }
    let dropped = false;
    for (const [key, entry] of [...this.entries]) {
      if (entry.runId !== runId) { continue; }
      this.entries.delete(key);
      dropped = true;
    }
    if (!dropped) { return; }
    this.emit();
  }

  /** Drop everything — used when the workspace folder changes underneath us. */
  clear(): void {
    if (this.entries.size === 0) { return; }
    this.entries.clear();
    this.emit();
  }

  /**
   * A live entry for the run, or undefined when it is idle. The unattributed
   * one first, else its oldest step's — what a whole-run question (may this
   * epic be deleted? may the exec loop start?) is asking about.
   *
   * `stepIdx` is deliberately not a parameter here: it would sit where every
   * existing caller passes `now`, and a wrong answer about who is busy is
   * exactly the bug this registry exists to prevent. Ask { getStep}.
   */
  get(runId: string, now: number = Date.now()): AgentActivity | undefined {
    return this.live(this.entries.get(keyOf(runId, null)), now) ?? this.forRun(runId, now)[0];
  }

  /**
   * The live entry for one step: its own, falling back to the unattributed
   * entry for the run — a dispatch we could not pin to a step might be this
   * one, and the UI would rather over-report busy than invite a second agent
   * onto work already under way.
   */
  getStep(runId: string, stepIdx: number, now: number = Date.now()): AgentActivity | undefined {
    return (
      this.live(this.entries.get(keyOf(runId, stepIdx)), now)
      ?? this.live(this.entries.get(keyOf(runId, null)), now)
    );
  }

  private live(entry: AgentActivity | undefined, now: number): AgentActivity | undefined {
    return entry && now - entry.startedAt < MAX_AGE_MS ? entry : undefined;
  }

  /** Every live entry for a run, oldest dispatch first. */
  forRun(runId: string, now: number = Date.now()): AgentActivity[] {
    const out: AgentActivity[] = [];
    for (const entry of this.entries.values()) {
      if (entry.runId !== runId) { continue; }
      if (now - entry.startedAt < MAX_AGE_MS) { out.push(entry); }
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** True when an agent we started is still working anywhere on this run. */
  isBusy(runId: string, now: number = Date.now()): boolean {
    return this.get(runId, now) !== undefined;
  }

  /** True when one is still working this particular step. */
  isStepBusy(runId: string, stepIdx: number, now: number = Date.now()): boolean {
    return this.getStep(runId, stepIdx, now) !== undefined;
  }

  /**
   * Everything still live, for the webview payload. Expired entries are
   * dropped here rather than on a timer: nothing needs them gone until
   * somebody asks, and a timer would be one more thing to dispose.
   */
  snapshot(now: number = Date.now()): AgentActivityMap {
    const out: AgentActivityMap = {};
    for (const [key, activity] of [...this.entries]) {
      if (now - activity.startedAt >= MAX_AGE_MS) {
        this.entries.delete(key);
        continue;
      }
      (out[activity.runId] ??= []).push(activity);
    }
    for (const list of Object.values(out)) {
      list.sort((a, b) => a.startedAt - b.startedAt);
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
