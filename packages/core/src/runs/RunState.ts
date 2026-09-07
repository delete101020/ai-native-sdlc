/**
 * Persistent state for an in-flight pipeline run.
 *
 * One run = one execution of one pipeline against one "subject" (typically an
 * epic key like `EPIC-2100`, but the runner is agnostic — `runId` is just a
 * filesystem-safe identifier). State files live at
 * `<workspace>/.aidlc/runs/<runId>.json` and act as the single source of
 * truth for what step the user is on, which steps passed/failed, and what
 * feedback the human supplied on rejected steps.
 *
 * The state machine is intentionally simple in phase 1:
 *
 *   awaiting_work  → user runs the slash command externally, comes back to
 *                    "Mark step done"
 *   awaiting_review → step produced its artifacts; pause for human approve
 *                     / reject
 *   approved       → step passed; runner advances currentStepIdx
 *   rejected       → step rejected by human; user can rerun (revision++)
 *
 * Phase 2 will add: gate-check on `requires` paths, hooks (before/after
 * step), reject-to-upstream cascade, automatic worker dispatch via the
 * runner registry.
 */

export type StepStatus =
  | 'pending'                // not yet reached
  | 'awaiting_work'          // current step, user is doing the work externally
  | 'awaiting_auto_review'   // produces validated, auto-reviewer pending (auto_review=true)
  | 'awaiting_review'        // auto-review passed (or skipped), paused for human approve/reject
  | 'approved'               // human approved (or auto-approved when human_review=false)
  | 'rejected';              // human or auto-reviewer rejected; can rerun

export type RunStatus =
  | 'running'           // a step is awaiting_work or awaiting_review
  | 'completed'         // all steps approved
  | 'failed';           // produces validation failed and not recoverable

export interface StepRecord {
  /** Index into pipeline.steps[]. */
  stepIdx: number;
  /** Agent id for this step (resolved from pipeline.steps[stepIdx]). */
  agent: string;
  /**
   * The pipeline step's `name`, when it has one. Together with `agent` this
   * is the step's identity — see {@link stepIdentity} — and it is what lets a
   * run be checked against its pipeline by *which* step rather than by
   * position. Absent on runs written before schema 2, and on steps whose
   * pipeline entry carries no name; both fall back to `agent`.
   */
  name?: string;
  /** Bumps each time the user reruns this step after a rejection. Starts at 1. */
  revision: number;
  status: StepStatus;
  /** ISO timestamp when this step first transitioned to awaiting_work. */
  startedAt?: string;
  /** ISO timestamp when this step transitioned to approved. */
  finishedAt?: string;
  /**
   * Resolved produces paths (placeholders substituted from run context).
   * Filled in when the step transitions to awaiting_review or approved.
   */
  artifactsProduced: string[];
  /**
   * LLM cost (USD) of the most recent runner execution for this step, when the
   * runner reported it. Summed across steps by the `run exec` budget guard.
   */
  costUsd?: number;
  /**
   * True when `costUsd` came from `usage` × a declared rate rather than from a
   * cost the CLI itself reported. Carried so the report can print `~$0.12 est.`
   * instead of `$0.12` — the difference between the two is the difference
   * between a fact and an arithmetic guess (P0/D5).
   */
  costEstimated?: boolean;
  /** Token counts the CLI reported, when it reported any. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Runner id this step actually executed on (`default`, `codex`, …). */
  runner?: string;
  /**
   * Concrete model the runner was told to use, after alias resolution. Empty
   * when the provider CLI was left to pick its own default — which is itself
   * worth recording, since it is the case where the run's provenance is
   * incomplete.
   */
  model?: string;
  /** Optional human feedback supplied at rerun time. Carried forward. */
  feedback?: string;
  /** Reason supplied with the most recent rejection. Cleared on rerun. */
  rejectReason?: string;
  /**
   * Verdict from the most recent auto-reviewer run for this step. Persists
   * across the human gate so the human reviewer can see what the validator
   * said. Cleared on rerun.
   */
  autoReviewVerdict?: AutoReviewVerdict;
  /**
   * Append-only timeline of significant state transitions for this step.
   * Survives reruns (each rerun adds an entry) so the user can review what
   * happened, when, why — even after the run completes. Optional for
   * backward compat with state files written before this field existed.
   */
  history?: StepHistoryEntry[];
}

/**
 * One entry in a step's append-only history. The discriminated `kind` tells
 * the UI which fields to expect; `at` and `revision` are always present.
 */
export type StepHistoryEntry =
  | {
      kind: 'reject';
      at: string;
      revision: number;
      /** Reason supplied by the human (free-form, optional). */
      reason?: string;
      /**
       * Step index the rejection sent the work back to. Equals the rejected
       * step's idx for an in-place rerun; lower idx for a cascade.
       */
      sentBackToIdx: number;
    }
  | {
      kind: 'rerun';
      at: string;
      /** Revision the step is now on after the rerun bump. */
      revision: number;
      /** Optional feedback the user kept on the step at rerun time. */
      feedback?: string;
    }
  | {
      kind: 'auto_review';
      at: string;
      revision: number;
      decision: 'pass' | 'reject';
      reason: string;
      runner: string;
    }
  | {
      kind: 'approve';
      at: string;
      revision: number;
    }
  | {
      /**
       * A round of the /annotate-artifact review loop that edited the .md.
       * Sourced from the artifacts folder's `.annotation-history.json` and
       * merged into the owning step's history at read time (never written to
       * the run-state machine).
       */
      kind: 'annotate';
      at: string;
      revision: number;
      /** Who made the edit — git user (name <email>) or hostname fallback. */
      author?: string;
      /** The human's annotation note(s) for this round. */
      note?: string;
      /** What the agent changed in the .md in response. */
      summary?: string;
    };

/**
 * Outcome of an auto-reviewer (validator script) run for a step. Produced
 * by the AutoReviewer module and applied to RunState via
 * `submitAutoReviewVerdict`.
 */
export interface AutoReviewVerdict {
  decision: 'pass' | 'reject';
  /** Human-readable rationale (failed checks, summary, etc.). */
  reason: string;
  /** ISO timestamp the verdict was produced. */
  at: string;
  /** Identifier of the runner that produced the verdict — usually the resolved script path. */
  runner: string;
}

export interface RunState {
  /**
   * Always {@link RUN_STATE_SCHEMA_VERSION} for state this process holds:
   * {@link migrateRunState} raises an older file to it at read time, and every
   * writer stamps the current value.
   */
  schemaVersion: number;
  /** Unique within the workspace; used as the .json filename. */
  runId: string;
  /** Pipeline id this run is executing. Must exist in workspace.yaml. */
  pipelineId: string;
  /**
   * Free-form context map used for placeholder substitution in artifact
   * paths. Convention: `epic` → epic key, but any key can be used.
   */
  context: Record<string, string>;
  startedAt: string;
  updatedAt: string;
  /** Index of the step currently being worked / reviewed / rejected. */
  currentStepIdx: number;
  status: RunStatus;
  /** One entry per pipeline step, length === pipeline.steps.length. */
  steps: StepRecord[];
}

/**
 * Current on-disk schema for `.aidlc/runs/<id>.json`.
 *
 * 1 → 2 added {@link StepRecord.name}. The field itself is additive, but the
 * bump is not cosmetic: from 2 on, a run can be checked against its pipeline
 * by step identity, and `aidlc epic step add|remove` may legitimately leave
 * the run's step list a different length than it started. An older build has
 * no way to know that and would resolve every index positionally, so it
 * should decline to read the file rather than act on it — which is exactly
 * what a version it does not recognise makes it do.
 */
export const RUN_STATE_SCHEMA_VERSION = 2;

/**
 * A step's identity: its `name`, falling back to its `agent` id.
 *
 * The same rule `stepDagId` applies to the pipeline side and the runner
 * applies to `depends_on`, so the two ends of a run agree on what a step
 * *is* without either of them consulting an index.
 */
export function stepIdentity(step: Pick<StepRecord, 'agent' | 'name'>): string {
  return step.name ?? step.agent;
}

/**
 * Raise a parsed run file to {@link RUN_STATE_SCHEMA_VERSION}, or return null
 * when it is not a run file this build can read.
 *
 * A version-1 file needs no field changes — `name` is optional and its
 * absence already means "identified by agent alone", which is what version 1
 * assumed. Migrating is therefore just re-stamping the version, and it
 * happens on read so no separate migration pass has to be run against a
 * workspace. Names are filled in later, from the pipeline, by
 * `withBackfilledStepNames`; that needs a pipeline and this does not.
 *
 * Never throws — an unreadable file is a null, the same as a missing one.
 */
export function migrateRunState(parsed: unknown): RunState | null {
  if (!parsed || typeof parsed !== 'object') { return null; }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.runId !== 'string' || !Array.isArray(obj.steps)) { return null; }
  const version = obj.schemaVersion;
  if (version !== 1 && version !== RUN_STATE_SCHEMA_VERSION) { return null; }
  if (version === RUN_STATE_SCHEMA_VERSION) { return obj as unknown as RunState; }
  return { ...obj, schemaVersion: RUN_STATE_SCHEMA_VERSION } as unknown as RunState;
}

/**
 * Substitute `{key}` placeholders in an artifact path with values from the
 * run's context map. Unknown placeholders are left intact so the missing
 * key shows up in the produces validation error rather than silently
 * resolving to empty string.
 */
export function resolvePath(template: string, context: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (match, key) => {
    const value = context[key];
    return typeof value === 'string' && value.length > 0 ? value : match;
  });
}
