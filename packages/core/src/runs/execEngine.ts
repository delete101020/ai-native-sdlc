/**
 * aidlc-autopilot: unattended pipeline execution engine.
 *
 * The loop that drives a run to completion by spawning the agent runner for
 * each `awaiting_work` step, marking it done, running auto-review, and
 * auto-advancing — pausing at human-review / rejection / budget ceilings.
 *
 * Ported out of the CLI (`aidlc run exec`) so BOTH the CLI and the VS Code
 * extension can drive a run with their own presentation. All I/O — the claude
 * stream, decorative logging, progress — flows through {@link ExecHooks}, so
 * this module stays pure (no chalk, no console, no process.exit) and unit-
 * testable. The CLI maps the hooks back to its chalk output; the extension
 * maps them to a progress panel.
 */

import * as path from 'path';

import { WorkspaceLoader } from '../loader/WorkspaceLoader';
import { RunStateStore } from './RunStateStore';
import {
  markStepDone,
  approveStep,
  submitAutoReviewVerdict,
  dirtyUpstreamOf,
  PipelineRunError,
} from './PipelineRunner';
import { runAutoReview } from './AutoReviewer';
import { commitApprovedArtifacts, resolveArtifactCommitConfig } from './EpicArtifactCommit';
import { epicsRoot, mirrorRunStateToEpic } from './EpicScaffold';
import { isActiveStatus, isStepOptional } from './runProgress';
import { checkBudget, type CostAccounting } from './budget';
import { snapshotProduces, unchangedProduces } from './producesSnapshot';
import { revisionFeedback } from './revisionFeedback';
import { acquireRunLock } from './runLock';
import { codeFingerprint } from './codeFingerprint';
import { readBatchStatusFile } from './batchStatus';
import { autopilotPreflight, AUTOPILOT_ENV } from './autopilotPreflight';
import { STOP_GRACE_MS } from '../runner/processTree';
import { estimateCostUsd, ratesFromConfig, providerAliases } from './pricing';
import { pickAgentModel, resolveProviderModel, stepModelOptions } from '../presets/models';
import type { RunState, StepRecord } from './RunState';
import type { PipelineConfig, AgentConfig } from '../schema/WorkspaceSchema';
import { normalizeStep, resolveStepSkills, stepSkillAlternatives, DEFAULT_MAX_SEND_BACKS } from '../schema/WorkspaceSchema';
import { resolvePath } from './RunState';
import { resolveArtifactLanguage } from '../loader/artifactLanguage';
import { resolveEpicStrictMode } from '../loader/strictMode';
import { inheritedContextNote } from '../loader/inheritedContext';
import { composeAgentPrompt, type ComposedPrompt } from '../loader/promptComposer';
import { findProjectInstructions } from '../loader/projectInstructions';
import { harnessCapabilities, type AidlcRunner, type RunnerResult } from '../runner/types';

/**
 * Why the loop stopped. Callers map this to an exit code (CLI) or a final
 * status message (extension). `completed` / `until` are clean stops; the rest
 * are gates a human must clear.
 */
export type ExecOutcome =
  | { kind: 'completed' }
  | { kind: 'until' }
  | { kind: 'dry_run' }
  | { kind: 'awaiting_review' }
  | { kind: 'rejected' }
  | { kind: 'stalled' }
  | { kind: 'budget_pause' }
  | { kind: 'batch_pause' }
  | { kind: 'cancelled' }
  | { kind: 'error' };

/** Options controlling one exec loop. Mirrors the CLI's `run exec` flags. */
export interface ExecOptions {
  /** Stop after this step index completes; -1 (default) = run to the end. */
  untilIdx?: number;
  /** Auto-approve human_review steps instead of pausing at them. */
  autoApprove?: boolean;
  /** Override the user message sent to claude (default: context pairs). */
  message?: string;
  /** Preview the current step's prompt without spawning claude, then stop. */
  dryRun?: boolean;
  /**
   * Polled between steps; true stops the loop cleanly with `cancelled`, after
   * the step that is running has finished. This is the gentle stop: the step
   * in flight ends with its work done and transitioned, not cut off halfway
   * through an edit. For a step that has to stop now, see {@link signal}.
   */
  shouldCancel?: () => boolean;
  /**
   * Aborting it stops the running step now: the runner kills the agent's
   * whole process tree, the step stays `awaiting_work` on the same revision
   * with an `interrupted` history entry, and the loop returns `cancelled`.
   * Whatever the agent half-wrote stays in the working tree — the `produces`
   * snapshot keeps it from passing as the next attempt's output, and an
   * autopilot run will not start again until the tree is clean.
   */
  signal?: AbortSignal;
  /**
   * Skill to run on a step whose `skills` are alternatives (`default_skill`
   * set), in place of the one remembered on the step or the default. Applies
   * to every step that offers it, and is ignored by steps that do not.
   */
  skill?: string;
}

/**
 * Presentation callbacks. All optional — a caller implements only what it
 * renders. The engine calls these instead of writing to a console, so the
 * same loop backs the CLI (chalk) and the extension (panel).
 */
export interface ExecHooks {
  /** Live claude stdout stream. */
  onOutput?(chunk: string): void;
  /** Live claude stderr stream. */
  onErrorOutput?(chunk: string): void;
  /** Run reached `completed` — every step approved. */
  onRunCompleted?(): void;
  /** Terminal failure (run failed / disappeared / unexpected step status). */
  onRunFailed?(reason: string): void;
  /** A step is about to execute. */
  onStepStart?(e: {
    stepIdx: number; agent: string; revision: number;
    skills: string[]; model?: string; context?: string;
    /**
     * Approved-but-suspect steps this one depends on — see `dirtyUpstreamOf`.
     * Empty in the ordinary case. Non-empty means the step is about to be
     * built on an input that was regenerated under it, which is a risk worth
     * naming *before* the work rather than after.
     */
    dirtyUpstream?: Array<{ stepIdx: number; step: string; byStep: string }>;
  }): void;
  /** A step finished `markStepDone` and transitioned. */
  onStepResult?(e: {
    stepIdx: number; agent: string; status: string; costUsd?: number;
    /** True when costUsd came from tokens × a declared rate, not from the CLI. */
    costEstimated?: boolean;
    runner?: string; model?: string;
  }): void;
  /** The runner exited non-zero, or `markStepDone` rejected the artifacts. */
  onStepFailed?(e: {
    stepIdx: number; agent: string; missing?: string[]; message?: string;
  }): void;
  /** Loop paused at a human_review gate. */
  onAwaitingReview?(e: { agent: string; runId: string }): void;
  /**
   * The running step was stopped through {@link ExecOptions.signal}. It is
   * left `awaiting_work`; the loop returns `cancelled` next.
   */
  onStepStopped?(e: { stepIdx: number; agent: string; revision: number; runId: string }): void;
  /**
   * A session of a `batches: true` step ended on `Status: continue`. The step
   * stays `awaiting_work`, and the loop starts the next session unless it
   * stops for {@link onBatchPause} or the batch ceiling.
   */
  onBatchDone?(e: {
    stepIdx: number; agent: string; revision: number; batch: number;
    costUsd?: number; costEstimated?: boolean; runId: string;
  }): void;
  /** `pause_between_batches`: the loop stopped after a batch, for a person to look first. */
  onBatchPause?(e: { stepIdx: number; agent: string; batch: number; report: string; runId: string }): void;
  /** Loop paused because the current step was rejected. */
  onRejected?(e: { agent: string; runId: string }): void;
  /**
   * A step the run sent work back to came back with the code unchanged, so
   * the loop stopped rather than have it reviewed into the same reject again.
   * Also a batch that asked for another session without changing any code,
   * and a step that hit `max_batches` still asking for more. The step is left
   * `awaiting_work` on the same revision.
   */
  onStalled?(e: { stepIdx: number; agent: string; revision: number; reason: string; runId: string }): void;
  /**
   * A rejected step the loop walked past — `optional: true`, or a pipeline
   * with `on_failure: continue` — naming where it went instead.
   */
  onStepSkipped?(e: {
    stepIdx: number; agent: string; reason: string; nextStepIdx: number; runId: string;
  }): void;
  /** Auto-review validator is about to run. */
  onAutoReviewStart?(e: { agent: string }): void;
  /**
   * Auto-review verdict landed. On a reject, `reason` is what the run
   * recorded — the validator's reason plus why the run did not send the work
   * back, when it did not — and `sentBackTo` is set when it did.
   */
  onAutoReviewResult?(e: {
    agent: string; decision: 'pass' | 'reject'; reason: string; runId: string;
    sentBackTo?: { stepIdx: number; agent: string; revision: number; count: number; max: number };
  }): void;
  /** A human_review step was auto-approved (--auto-approve). */
  onAutoApproved?(e: { agent: string }): void;
  /** Budget verdict after a step ran. */
  onBudget?(e: {
    spent: number; limit: number; ok: boolean;
    exceeded?: 'step' | 'total'; onExceed?: string; runId: string;
    /** How much of `spent` is measured vs. estimated, and how many steps are blind. */
    measured?: number; estimated?: number; blindSteps?: number;
  }): void;
  /** The caller's `shouldCancel` returned true at a step boundary. */
  onCancelled?(): void;
  /** Stopped at the --until boundary. */
  onUntilStop?(e: { untilIdx: number }): void;
  /** Dry-run: assembled prompt preview (no claude spawned). */
  onDryRunPreview?(e: {
    skills: string; skillText: string; userMessage: string;
    env: Record<string, string>;
    /** Which layers the composer inlined for this runner's harness. */
    inlined: { persona: boolean; instructions: boolean };
  }): void;
}

/** Load the pipeline backing a run, or null if the workspace/pipeline is gone. */
function loadPipelineForRun(root: string, state: RunState): PipelineConfig | null {
  try {
    const ws = WorkspaceLoader.load(root);
    return ws.config.pipelines.find((p) => p.id === state.pipelineId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Run the exec loop for `runId` until it completes or hits a gate. Pure over
 * I/O — everything observable goes through `hooks`; the return value is the
 * reason it stopped.
 */
export async function runExecLoop(
  root: string,
  runId: string,
  opts: ExecOptions,
  hooks: ExecHooks = {},
): Promise<ExecOutcome> {
  // A preview spawns nothing and writes nothing, so it needs no lock.
  if (opts.dryRun) { return execLoop(root, runId, opts, hooks); }
  const lock = acquireRunLock(root, runId);
  if ('heldBy' in lock) {
    hooks.onRunFailed?.(
      `Run "${runId}" is already being executed (pid ${lock.heldBy}). ` +
      'Stop that one first, or wait for it to finish.',
    );
    return { kind: 'error' };
  }
  try {
    return await execLoop(root, runId, opts, hooks);
  } finally {
    lock.release();
  }
}

async function execLoop(
  root: string,
  runId: string,
  opts: ExecOptions,
  hooks: ExecHooks,
): Promise<ExecOutcome> {
  const untilIdx = opts.untilIdx ?? -1;

  const initialState = RunStateStore.load(root, runId);
  if (!initialState) {
    hooks.onRunFailed?.(`Run "${runId}" not found.`);
    return { kind: 'error' };
  }

  // Cost ceiling resolved once — only the autopilot loop enforces it (manual
  // mark-done is never gated).
  const initialPipeline = loadPipelineForRun(root, initialState);
  if (!initialPipeline) {
    hooks.onRunFailed?.(`Pipeline "${initialState.pipelineId}" not found in workspace.yaml.`);
    return { kind: 'error' };
  }
  const budget = initialPipeline.budget;
  // Batches each step has run in this loop, by `stepIdx:revision`; the
  // `max_batches` ceiling counts these, so running exec again lifts it.
  const batchesRun = new Map<string, number>();

  if (initialPipeline.autopilot && !opts.dryRun) {
    let problems: string[];
    try {
      const ws = WorkspaceLoader.load(root);
      problems = autopilotPreflight({ root, state: initialState, pipeline: initialPipeline, config: ws.config });
    } catch (err) {
      problems = [`Could not check the workspace: ${errMsg(err)}`];
    }
    if (problems.length > 0) {
      hooks.onRunFailed?.(
        `Pipeline "${initialPipeline.id}" is an autopilot pipeline, and it is not safe to leave this run alone yet:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
      );
      return { kind: 'error' };
    }
  }

  while (true) {
    // Checked before anything is spawned, so a cancel that arrived while the
    // previous step was running stops here rather than starting one more.
    if (opts.shouldCancel?.() || opts.signal?.aborted) {
      hooks.onCancelled?.();
      return { kind: 'cancelled' };
    }

    // Reload fresh state each iteration so concurrent edits (extension, other
    // CLI) are picked up.
    const state = RunStateStore.load(root, runId);
    if (!state) {
      hooks.onRunFailed?.(`Run "${runId}" disappeared.`);
      return { kind: 'error' };
    }

    if (state.status === 'completed') {
      hooks.onRunCompleted?.();
      return { kind: 'completed' };
    }
    if (state.status === 'failed') {
      hooks.onRunFailed?.('Run failed.');
      return { kind: 'error' };
    }

    const step = state.steps[state.currentStepIdx];

    // Auto-review gate: run the step's auto_review_runner validator headlessly.
    if (step.status === 'awaiting_auto_review') {
      const proceed = await runAutoReviewStep(root, runId, hooks);
      if (!proceed) { return { kind: 'error' }; }
      continue;
    }

    // Human review — pause unless auto-approving.
    if (step.status === 'awaiting_review') {
      if (opts.autoApprove) {
        await autoApproveStep(root, state, hooks);
        continue;
      }
      hooks.onAwaitingReview?.({ agent: step.agent, runId });
      return { kind: 'awaiting_review' };
    }

    if (step.status === 'rejected') {
      // A rejection the pipeline said it can live with — an `optional` step,
      // or any step under `on_failure: continue` — is not a reason to stop
      // while other work is open. `on_failure` was declared in the schema and
      // read by nothing until now; the loop stopped at every rejection either
      // way. Moving the cursor is all it takes: the rejected step keeps its
      // status and reason, so a human can still come back and rerun it.
      const skippable = isStepOptional(initialPipeline, state.currentStepIdx)
        || initialPipeline.on_failure === 'continue';
      const openElsewhere = state.steps.findIndex(
        (s, i) => i !== state.currentStepIdx && isActiveStatus(s.status),
      );
      if (skippable && openElsewhere >= 0) {
        hooks.onStepSkipped?.({
          stepIdx: state.currentStepIdx,
          agent: step.agent,
          reason: step.rejectReason ?? step.autoReviewVerdict?.reason ?? 'rejected',
          nextStepIdx: openElsewhere,
          runId,
        });
        RunStateStore.save(root, { ...state, currentStepIdx: openElsewhere });
        continue;
      }
      hooks.onRejected?.({ agent: step.agent, runId });
      return { kind: 'rejected' };
    }

    // Cursor on a finished step. Reachable once a rejection can be carried
    // past: the run is not `completed` (something was skipped), so say where
    // it actually stands instead of reporting a broken state machine.
    if (step.status === 'approved') {
      const openElsewhere = state.steps.findIndex((s) => isActiveStatus(s.status));
      if (openElsewhere >= 0) {
        RunStateStore.save(root, { ...state, currentStepIdx: openElsewhere });
        continue;
      }
      const parked = state.steps.find((s) => s.status === 'rejected');
      if (parked) {
        hooks.onRejected?.({ agent: parked.agent, runId });
        return { kind: 'rejected' };
      }
    }

    if (step.status !== 'awaiting_work') {
      hooks.onRunFailed?.(`Unexpected step status "${step.status}" — cannot exec.`);
      return { kind: 'error' };
    }

    // Execute the current step.
    const ran = await execStep(root, state, runId, opts, hooks);
    if (ran === 'failed') { return { kind: 'error' }; }
    if (ran === 'stalled') { return { kind: 'stalled' }; }
    if (ran === 'stopped') { return { kind: 'cancelled' }; }

    // One session of a batched step, with more to come: the same step runs
    // again from the top of the loop, after the checks a finished step gets.
    if (ran === 'batch') {
      const overBudget = checkRunBudget(root, runId, state.currentStepIdx, budget, hooks);
      if (overBudget) { return overBudget; }
      const idx = state.currentStepIdx;
      const cfg = initialPipeline.steps[idx] ? normalizeStep(initialPipeline.steps[idx]).batches : undefined;
      const key = `${idx}:${step.revision}`;
      const n = (batchesRun.get(key) ?? 0) + 1;
      batchesRun.set(key, n);
      const after = RunStateStore.load(root, runId);
      const batchNo = after ? batchesOf(after.steps[idx]).length : n;
      if (cfg && n >= cfg.max) {
        hooks.onStalled?.({
          stepIdx: idx, agent: step.agent, revision: step.revision, runId,
          reason: `"${step.agent}" ran ${n} batch${n === 1 ? '' : 'es'} (\`max_batches: ${cfg.max}\`) and still ` +
            'says `Status: continue`. Read its progress before letting it carry on: running exec again allows ' +
            `${cfg.max} more.`,
        });
        return { kind: 'stalled' };
      }
      if (cfg?.pause) {
        hooks.onBatchPause?.({
          stepIdx: idx, agent: step.agent, batch: batchNo, runId,
          report: batchReport(initialPipeline, after ?? state, idx) ?? '',
        });
        return { kind: 'batch_pause' };
      }
      continue;
    }

    // Dry-run previews a single step's prompt and never advances.
    if (opts.dryRun) { return { kind: 'dry_run' }; }

    // Budget guard — sum per-step cost from the just-saved state.
    const overBudget = checkRunBudget(root, runId, state.currentStepIdx, budget, hooks);
    if (overBudget) { return overBudget; }

    // --until boundary. `state.currentStepIdx` is the step that just ran.
    if (untilIdx >= 0 && state.currentStepIdx >= untilIdx) {
      hooks.onUntilStop?.({ untilIdx });
      return { kind: 'until' };
    }
  }
}

/**
 * Check the run's spend after a step (or one batch of it) ran. Returns the
 * outcome to stop on, or null to carry on.
 */
function checkRunBudget(
  root: string,
  runId: string,
  stepIdx: number,
  budget: PipelineConfig['budget'],
  hooks: ExecHooks,
): ExecOutcome | null {
  if (!budget) { return null; }
  const after = RunStateStore.load(root, runId);
  const stepCosts = after ? after.steps.map((s) => s.costUsd) : [];
  // Only steps that actually ran can be blind; a step still queued has no
  // cost because it has no execution, which is not the same thing.
  const stepAccounting: Array<CostAccounting | undefined> = after
    ? after.steps.map((s) => {
        if (typeof s.costUsd === 'number') { return s.costEstimated ? 'estimated' : 'measured'; }
        return s.startedAt ? 'blind' : undefined;
      })
    : [];
  const lastStepCost = after?.steps[stepIdx]?.costUsd;
  const verdict = checkBudget({ stepCosts, stepAccounting, budget, lastStepCost });
  if (!verdict.ok) {
    hooks.onBudget?.({
      spent: verdict.spent, limit: verdict.limit, ok: false,
      exceeded: verdict.exceeded, onExceed: budget.on_exceed, runId,
      measured: verdict.measured, estimated: verdict.estimated, blindSteps: verdict.blindSteps,
    });
    return budget.on_exceed === 'fail'
      ? { kind: 'error' }
      : { kind: 'budget_pause' };
  }
  hooks.onBudget?.({
    spent: verdict.spent, limit: budget.max_usd, ok: true, runId,
    measured: verdict.measured, estimated: verdict.estimated, blindSteps: verdict.blindSteps,
  });
  return null;
}

/** Skill text for a step — concatenated when it runs several skills. */
function loadSkills(ws: ReturnType<typeof WorkspaceLoader.load>, skillIds: readonly string[]): string {
  return skillIds.map((id) => ws.skills.load(id)).join('\n\n---\n\n');
}

/**
 * Full system prompt for a step: persona + project instructions + skills, minus
 * whatever the runner's own harness already supplies.
 *
 * The skills alone used to be the whole prompt, with the persona and the
 * project's conventions reaching the model only as *file paths written in prose*
 * — which assumes a harness that has a read tool and Claude's directory layout.
 * Composing them here makes the prompt self-contained, and makes "which agent
 * runs this phase" a wiring question instead of a quality question.
 * See MULTI_PROVIDER_ALIGNMENT.md §4c.
 */
function buildStepPrompt(
  ws: ReturnType<typeof WorkspaceLoader.load>,
  agent: AgentConfig,
  /** What the step runs — see {@link resolveStepSkills}. */
  skillIds: readonly string[],
  runner: AidlcRunner,
  root: string,
  /** Epic whose depth setting applies. Runs are keyed by epic id. */
  epicId: string,
  /** The step being run, for the pointer to its history on a rerun. */
  stepRec: { revision: number },
  stepIdx: number,
): ComposedPrompt {
  const harness = harnessCapabilities(runner);
  return composeAgentPrompt({
    skills: loadSkills(ws, skillIds),
    persona: ws.personas.load(agent.id),
    instructions: harness.projectInstructions
      ? null
      : findProjectInstructions(root, harness.instructionFile),
    harness,
    artifactLanguage: resolveArtifactLanguage(ws.config),
    // Per epic, not per workspace: how deep a phase goes is a property of the
    // work item. An epic that never set it reads as strict.
    strictMode: resolveEpicStrictMode(epicsRoot(root, ws.config), epicId),
    runHistory: stepRec.revision > 1
      ? { file: path.relative(root, RunStateStore.file(root, epicId)).split(path.sep).join('/'), stepIdx }
      : null,
  });
}

/**
 * Execute one `awaiting_work` step: spawn the runner, then mark it done.
 * `stalled` = the run sent work back to this step and it changed no code;
 * `stopped` = {@link ExecOptions.signal} cut it short; `batch` = one session
 * of a `batches: true` step ended on `Status: continue`, and the step is
 * still `awaiting_work`.
 */
async function execStep(
  root: string,
  state: RunState,
  runId: string,
  opts: ExecOptions,
  hooks: ExecHooks,
): Promise<'done' | 'failed' | 'stalled' | 'stopped' | 'batch'> {
  const stepIdx = state.currentStepIdx;
  const stepRec = state.steps[stepIdx];
  const agentId = stepRec.agent;

  let ws;
  try {
    ws = WorkspaceLoader.load(root);
  } catch (err) {
    hooks.onStepFailed?.({ stepIdx, agent: agentId, message: `Failed to load workspace: ${errMsg(err)}` });
    return 'failed';
  }

  const pipeline = ws.config.pipelines.find((p) => p.id === state.pipelineId);
  if (!pipeline) {
    hooks.onStepFailed?.({ stepIdx, agent: agentId, message: `Pipeline "${state.pipelineId}" not found in workspace.yaml.` });
    return 'failed';
  }

  const agent = ws.config.agents.find((a) => a.id === agentId);
  if (!agent) {
    hooks.onStepFailed?.({ stepIdx, agent: agentId, message: `Agent "${agentId}" not found in workspace.yaml.` });
    return 'failed';
  }

  // The step's own `skills` narrow the agent's, and a step with alternatives
  // runs exactly one of them: the one asked for, else the one last launched,
  // else its default. Loading all of them would have the model run every
  // procedure, or blend them.
  const stepCfg = pipeline.steps[stepIdx];
  const norm = stepCfg ? normalizeStep(stepCfg) : undefined;
  const alternatives = norm ? stepSkillAlternatives(norm) : undefined;
  const chosen = opts.skill && alternatives?.options.includes(opts.skill) ? opts.skill : stepRec.skill;
  const skillIds = norm ? resolveStepSkills(norm, agent.skills, chosen) : [...agent.skills];
  // An agent (or step) offering several models runs the one picked on the card.
  const modelOpts = stepModelOptions(agent, norm?.model);
  const agentModel = pickAgentModel(modelOpts, stepRec.chosenModel);

  // Resolved before the prompt because the prompt depends on what this
  // runner's harness already supplies.
  let runner: AidlcRunner;
  let prompt: ComposedPrompt;
  try {
    runner = ws.runners.resolve(agent);
  } catch (err) {
    hooks.onStepFailed?.({ stepIdx, agent: agentId, message: `Failed to resolve runner for agent "${agentId}": ${errMsg(err)}` });
    return 'failed';
  }
  try {
    prompt = buildStepPrompt(ws, agent, skillIds, runner, root, state.runId, stepRec, stepIdx);
  } catch (err) {
    hooks.onStepFailed?.({ stepIdx, agent: agentId, message: `Failed to load skills for agent "${agentId}": ${errMsg(err)}` });
    return 'failed';
  }
  const skillText = prompt.text;

  const env = ws.envResolver.resolveLayered(ws.config.environment ?? {}, agent.env ?? {});
  // Read by the approval-gate hook, which blocks on its own errors only when
  // nobody is watching.
  if (pipeline.autopilot) { env[AUTOPILOT_ENV] = '1'; }

  // claude --print always needs a non-empty prompt: explicit message → context
  // pairs → agent name fallback.
  const contextStr = Object.entries(state.context).map(([k, v]) => `${k}=${v}`).join(' ');
  // A follow-up reads the epics it follows — the slash-command bodies say so in
  // their inputs step; a headless step only ever sees these pairs.
  const epicRoot = path.relative(root, epicsRoot(root, ws.config)).split(path.sep).join('/');
  const inherited = state.context.from_epic ? `\n\nAbout these inputs: ${inheritedContextNote(epicRoot)}` : '';
  const baseMessage = opts.message ?? (contextStr ? contextStr + inherited : `Execute step: ${agentId}`);
  // A rerun leads with why — the only place a headless agent is guaranteed to
  // look. Appended to an explicit --message too: it overrides the context, not
  // the reason the step is running again.
  const feedback = revisionFeedback(state, stepIdx);
  // A batched step: which session this is, and where it reports. The plan
  // says how the work is sliced; the loop only says which slice comes next.
  const report = norm?.batches ? batchReport(pipeline, state, stepIdx) : null;
  if (norm?.batches && !report) {
    hooks.onStepFailed?.({
      stepIdx, agent: agentId,
      message: `Step "${agentId}" has \`batches: true\` but no \`produces\` file to write its \`Status:\` line in.`,
    });
    return 'failed';
  }
  const batchNo = report ? batchesOf(stepRec).length + 1 : 0;
  const batchNote = report ? batchInstructions(report, batchNo, stepRec.revision) : null;
  const userMessage = [baseMessage, feedback, batchNote].filter(Boolean).join('\n\n');

  if (opts.dryRun) {
    hooks.onDryRunPreview?.({
      skills: skillIds.join(', '),
      skillText,
      userMessage,
      env,
      inlined: prompt.included,
    });
    return 'done';
  }

  hooks.onStepStart?.({
    stepIdx, agent: agentId, revision: stepRec.revision,
    skills: skillIds, model: agentModel, context: userMessage,
    dirtyUpstream: dirtyUpstreamOf({ state, pipeline, stepIdx })
      .map((d) => ({ stepIdx: d.stepIdx, step: d.step, byStep: d.dirty.byStep })),
  });

  // Model + rates are per-provider facts the user declares (P3); resolving the
  // model here rather than inside the runner means the concrete id can be
  // recorded on the step, so a finished run says which model wrote each
  // artifact instead of only which tier was asked for.
  const aliases = providerAliases(ws.config.providers, agent.runner);
  const resolvedModel = resolveProviderModel(agent.runner, agentModel, aliases);

  // Fingerprinted before the runner starts: on a rerun the previous
  // revision's artifact would otherwise pass the `produces` check unchanged.
  const producedBefore = snapshotProduces({ state, pipeline, workspaceRoot: root, stepIdx });
  // Only where the run itself sent the work back: a person who reran the step
  // is there to judge whether nothing changing was the right answer.
  const codeExclude = [
    path.relative(root, path.join(epicsRoot(root, ws.config), state.runId)),
    '.aidlc',
  ];
  const sentBackHere = isAutoSendBackTarget(state, stepIdx);
  // A batch that asks for another session has to have changed something, so
  // a batched step is always fingerprinted.
  const codeBefore = sentBackHere || report ? codeFingerprint(root, codeExclude) : null;

  // One controller for both ways a step is cut short: its own time limit, and
  // the caller's "stop now".
  const stop = new AbortController();
  const minutes = norm?.timeout_minutes;
  let timedOut = false;
  const timer = minutes
    ? setTimeout(() => { timedOut = true; stop.abort(); }, minutes * 60_000)
    : undefined;
  const onStopNow = (): void => stop.abort();
  opts.signal?.addEventListener('abort', onStopNow, { once: true });

  let result: RunnerResult | null;
  try {
    result = await settledOrAbandoned(runner.run({
      skill: skillText,
      env,
      args: userMessage ? [userMessage] : [],
      workspaceRoot: root,
      model: agentModel,
      modelAliases: aliases,
      extraArgs: ws.config.providers[agent.runner]?.args,
      signal: stop.signal,
      onOutput: (chunk) => hooks.onOutput?.(chunk),
      onError: (chunk) => hooks.onErrorOutput?.(chunk),
      claude: null,
    }), stop.signal);
  } finally {
    if (timer) { clearTimeout(timer); }
    opts.signal?.removeEventListener('abort', onStopNow);
  }

  if (stop.signal.aborted) {
    recordInterrupted(root, runId, stepIdx, timedOut ? { why: 'timeout', minutes } : { why: 'stopped' });
    if (timedOut) {
      hooks.onStepFailed?.({
        stepIdx, agent: agentId,
        message: `Step "${agentId}" ran past its ${minutes}-minute limit (\`timeout_minutes\`) and was stopped. ` +
          `It is still awaiting work on revision ${stepRec.revision}; nothing was sent back. Whatever it ` +
          'half-wrote is still in the working tree.',
      });
      return 'failed';
    }
    hooks.onStepStopped?.({ stepIdx, agent: agentId, revision: stepRec.revision, runId });
    return 'stopped';
  }

  if (!result || !result.success) {
    hooks.onStepFailed?.({ stepIdx, agent: agentId, message: `Step "${agentId}" failed (non-zero exit).` });
    return 'failed';
  }

  const codeUnchanged = codeBefore !== null && codeFingerprint(root, codeExclude) === codeBefore;
  // Of a batched step's sessions, only the first answers the send-back: the
  // later ones were started because an earlier one changed code.
  if (sentBackHere && codeUnchanged && batchNo <= 1) {
    hooks.onStalled?.({
      stepIdx, agent: agentId, revision: stepRec.revision, runId,
      reason: `Revision ${stepRec.revision} of "${agentId}" changed no code — the working tree is what it was ` +
        `before it ran (its report aside). Sent back ${state.sendBacks} time${state.sendBacks === 1 ? '' : 's'}; ` +
        'stopping rather than have the same code reviewed again.',
    });
    return 'stalled';
  }

  const stale = unchangedProduces(producedBefore, root);
  if (stale.length > 0) {
    hooks.onStepFailed?.({
      stepIdx, agent: agentId,
      message: `Step "${agentId}" reported success but left its artifacts unchanged: ${stale.join(', ')}. `
        + 'The agent may have failed to write them. Check its output, then rerun the step.',
    });
    return 'failed';
  }

  if (report) {
    const read = readBatchStatusFile(root, report);
    if ('error' in read) {
      hooks.onStepFailed?.({
        stepIdx, agent: agentId,
        message: `Step "${agentId}" runs in batches and its report cannot say whether it is done: ${read.error} ` +
          'Add the line, then run exec again.',
      });
      return 'failed';
    }
    if (read.status === 'continue') {
      if (codeUnchanged) {
        hooks.onStalled?.({
          stepIdx, agent: agentId, revision: stepRec.revision, runId,
          reason: `Batch ${batchNo} of "${agentId}" asked for another session but changed no code — the working ` +
            'tree is what it was before it ran (its report aside). Stopping rather than start the same batch again.',
        });
        return 'stalled';
      }
      const fresh = RunStateStore.load(root, runId);
      const rec = fresh?.steps[stepIdx];
      if (!fresh || !rec) {
        hooks.onStepFailed?.({ stepIdx, agent: agentId, message: `Run "${runId}" disappeared.` });
        return 'failed';
      }
      recordProvenance(rec, { agent, resolvedModel, agentModel, skillIds, alternatives, modelOpts });
      const cost = addBatchCost(rec, batchNo, result, batchCost(result, ws, agent.runner, resolvedModel ?? agentModel));
      rec.history = [...(rec.history ?? []), {
        kind: 'batch', at: new Date().toISOString(), revision: rec.revision, batch: batchNo,
        ...(cost !== undefined ? { costUsd: cost } : {}),
      }];
      persist(root, fresh);
      hooks.onBatchDone?.({
        stepIdx, agent: agentId, revision: rec.revision, batch: batchNo,
        costUsd: cost, costEstimated: rec.costEstimated, runId,
      });
      return 'batch';
    }
  }

  // markStepDone validates produces paths, then transitions.
  let next: RunState;
  // Hoisted out of the try so it is still in scope as the "before" snapshot for
  // persist(): the mutations below touch cost fields only, never step status.
  let freshState: RunState;
  try {
    freshState = RunStateStore.load(root, runId)!;
    // Record cost before the transition so the budget guard can sum it and it
    // survives the reload-each-iteration loop.
    // Provenance of the step, recorded whether or not a cost came back.
    const rec = freshState.steps[stepIdx];
    recordProvenance(rec, { agent, resolvedModel, agentModel, skillIds, alternatives, modelOpts });
    addBatchCost(rec, batchNo, result, batchCost(result, ws, agent.runner, resolvedModel ?? agentModel));
    next = markStepDone({ state: freshState, pipeline, workspaceRoot: root });
  } catch (err) {
    if (err instanceof PipelineRunError && err.missing?.length) {
      hooks.onStepFailed?.({ stepIdx, agent: agentId, missing: err.missing });
    } else {
      hooks.onStepFailed?.({ stepIdx, agent: agentId, message: errMsg(err) });
    }
    return 'failed';
  }

  persist(root, next, freshState);

  const doneStep = next.steps[stepIdx];
  hooks.onStepResult?.({
    stepIdx, agent: agentId, status: doneStep.status, costUsd: doneStep.costUsd,
    costEstimated: doneStep.costEstimated, runner: agent.runner, model: resolvedModel,
  });
  return 'done';
}

/** The `batch` entries of the step's current revision, oldest first. */
function batchesOf(rec: StepRecord | undefined): Array<Extract<NonNullable<StepRecord['history']>[number], { kind: 'batch' }>> {
  if (!rec) { return []; }
  return (rec.history ?? []).flatMap((h) => (h.kind === 'batch' && h.revision === rec.revision ? [h] : []));
}

/** Where a batched step writes its `Status:` line: its first required `produces` path. */
function batchReport(pipeline: PipelineConfig, state: RunState, stepIdx: number): string | null {
  const cfg = pipeline.steps[stepIdx];
  if (!cfg) { return null; }
  const norm = normalizeStep(cfg);
  const first = norm.produces.find((p) => !norm.produces_optional.includes(p));
  return first ? resolvePath(first, state.context) : null;
}

/** What a batched step's session is told about the session it is. */
function batchInstructions(report: string, batchNo: number, revision: number): string {
  const lines = [
    `This step runs in batches: this is batch ${batchNo} of revision ${revision}, in a fresh session.`,
    batchNo === 1 && revision > 1
      ? `Make this batch the fixes the feedback above asks for. Keep the progress table ${report} already has ` +
        'from the earlier revision, so you know what is done, and add the fixes to it.'
      : batchNo === 1
        ? 'Start with the first batch in the plan.'
        : `${report} records what earlier batches did. Read it first, then do the next batch in the plan.`,
    `Do that one batch only, then update ${report}: its progress table, and as its last line ` +
      '`Status: continue` if any of the step\'s work is left, or `Status: done` when all of it is finished. ' +
      'A batch may be split smaller if it does not fit; never do two in one session.',
  ];
  return lines.join(' ');
}

/** Which runner, model and skill produced the step's current revision. */
function recordProvenance(rec: StepRecord, p: {
  agent: AgentConfig;
  resolvedModel: string | undefined;
  agentModel: string | undefined;
  skillIds: readonly string[];
  alternatives: unknown;
  modelOpts: { models?: unknown };
}): void {
  rec.runner = p.agent.runner;
  rec.model = p.resolvedModel;
  if (p.alternatives) { rec.skill = p.skillIds[0]; }
  if (p.modelOpts.models) { rec.chosenModel = p.agentModel; }
}

/** What one runner execution cost, or nothing when it is not known. */
function batchCost(
  result: RunnerResult,
  ws: ReturnType<typeof WorkspaceLoader.load>,
  provider: string,
  model: string | undefined,
): { usd: number; estimated: boolean } | undefined {
  // A cost the CLI reported always wins: it knows about cache hits and the
  // account's actual plan, and we do not.
  if (typeof result.costUsd === 'number') { return { usd: result.costUsd, estimated: false }; }
  const est = estimateCostUsd({
    table: ratesFromConfig(ws.config.providers),
    provider,
    model,
    usage: result.usage,
  });
  return est ? { usd: est.usd, estimated: true } : undefined;
}

/**
 * Put one execution's cost and usage on the step. The first session of a
 * revision replaces what the last revision recorded; a later batch adds to
 * the sessions before it, so a batched step's figures are the whole
 * revision's. Returns this execution's cost.
 */
function addBatchCost(
  rec: StepRecord,
  batchNo: number,
  result: RunnerResult,
  cost: { usd: number; estimated: boolean } | undefined,
): number | undefined {
  const carry = batchNo > 1;
  rec.usage = carry ? addUsage(rec.usage, result.usage) : result.usage;
  if (!cost) { return undefined; }
  if (carry && typeof rec.costUsd === 'number') {
    rec.costUsd += cost.usd;
    rec.costEstimated = rec.costEstimated || cost.estimated || undefined;
  } else {
    rec.costUsd = cost.usd;
    rec.costEstimated = cost.estimated || undefined;
  }
  return cost.usd;
}

function addUsage(a: StepRecord['usage'], b: StepRecord['usage']): StepRecord['usage'] {
  if (!a) { return b; }
  if (!b) { return a; }
  const sum = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return { inputTokens: sum(a.inputTokens, b.inputTokens), outputTokens: sum(a.outputTokens, b.outputTokens) };
}

/**
 * The runner's result, or null once `signal` has aborted and the runner has
 * had the grace period plus a little to wind down. A builtin runner kills its
 * process tree and resolves well inside that; a custom runner that ignores
 * the signal is left running rather than allowed to hold the loop forever.
 */
async function settledOrAbandoned(run: Promise<RunnerResult>, signal: AbortSignal): Promise<RunnerResult | null> {
  let timer: NodeJS.Timeout | undefined;
  const abandoned = new Promise<null>((resolve) => {
    const giveUp = (): void => { timer = setTimeout(() => resolve(null), STOP_GRACE_MS + 5_000); };
    if (signal.aborted) { giveUp(); } else { signal.addEventListener('abort', giveUp, { once: true }); }
  });
  try {
    return await Promise.race([run, abandoned]);
  } finally {
    if (timer) { clearTimeout(timer); }
  }
}

/** Note on the step that its agent was stopped before it finished. */
function recordInterrupted(
  root: string,
  runId: string,
  stepIdx: number,
  what: { why: 'timeout'; minutes?: number } | { why: 'stopped' },
): void {
  const fresh = RunStateStore.load(root, runId);
  const rec = fresh?.steps[stepIdx];
  if (!fresh || !rec) { return; }
  rec.history = [...(rec.history ?? []), {
    kind: 'interrupted', at: new Date().toISOString(), revision: rec.revision, ...what,
  }];
  RunStateStore.save(root, fresh);
}

/** Run the auto-review validator for the current step and submit its verdict. */
async function runAutoReviewStep(root: string, runId: string, hooks: ExecHooks): Promise<boolean> {
  const state = RunStateStore.load(root, runId);
  if (!state) {
    hooks.onRunFailed?.(`Run "${runId}" disappeared.`);
    return false;
  }
  const pipeline = loadPipelineForRun(root, state);
  if (!pipeline) {
    hooks.onRunFailed?.(`Pipeline "${state.pipelineId}" not found in workspace.yaml.`);
    return false;
  }
  const step = state.steps[state.currentStepIdx];
  hooks.onAutoReviewStart?.({ agent: step.agent });

  let verdict;
  try {
    verdict = await runAutoReview({ workspaceRoot: root, state, pipeline });
  } catch (err) {
    // Config-level failure (missing/unloadable runner). Validator errors are
    // already converted to a reject verdict inside runAutoReview.
    hooks.onStepFailed?.({ stepIdx: state.currentStepIdx, agent: step.agent, message: `Auto-review could not run: ${errMsg(err)}` });
    return false;
  }

  let next: RunState;
  try {
    next = submitAutoReviewVerdict({ state, pipeline, verdict });
  } catch (err) {
    hooks.onStepFailed?.({ stepIdx: state.currentStepIdx, agent: step.agent, message: errMsg(err) });
    return false;
  }

  persist(root, next, state);
  const idx = state.currentStepIdx;
  const sentBack = verdict.decision === 'reject' && next.currentStepIdx !== idx
    && next.steps[idx].status === 'pending';
  hooks.onAutoReviewResult?.({
    agent: step.agent,
    decision: verdict.decision,
    reason: next.steps[idx].rejectReason ?? verdict.reason,
    runId,
    ...(sentBack ? {
      sentBackTo: {
        stepIdx: next.currentStepIdx,
        agent: next.steps[next.currentStepIdx].agent,
        revision: next.steps[next.currentStepIdx].revision,
        count: next.sendBacks ?? 0,
        max: pipeline.max_send_backs ?? DEFAULT_MAX_SEND_BACKS,
      },
    } : {}),
  });
  return true;
}

/**
 * True when `stepIdx` is where the run last sent work back on its own, and no
 * person has acted on the run since (which clears {@link RunState.sendBacks}).
 */
function isAutoSendBackTarget(state: RunState, stepIdx: number): boolean {
  if (!state.sendBacks) { return false; }
  let latest: { at: string; to: number } | null = null;
  for (const s of state.steps) {
    for (const h of s.history ?? []) {
      if (h.kind === 'reject' && h.source && (!latest || h.at >= latest.at)) {
        latest = { at: h.at, to: h.sentBackToIdx };
      }
    }
  }
  return latest?.to === stepIdx;
}

/** Auto-approve a human_review step (--auto-approve). */
async function autoApproveStep(root: string, state: RunState, hooks: ExecHooks): Promise<void> {
  const ws = WorkspaceLoader.load(root);
  const pipeline = ws.config.pipelines.find((p) => p.id === state.pipelineId)!;
  // --auto-approve is the loop approving, not a person: the send-back count
  // that approveStep clears for a human carries on.
  const next = { ...approveStep({ state, pipeline }), sendBacks: state.sendBacks };
  persist(root, next, state);
  hooks.onAutoApproved?.({ agent: state.steps[state.currentStepIdx].agent });
}

/**
 * Save a transitioned run, and commit the epic's artifacts when the workspace
 * asked for that (`artifact_commit: on_approve`).
 *
 * The exec loop runs unattended, which is exactly when artifacts are most
 * likely to be left dirty and unclaimed: nobody is watching the working tree.
 * Everything here is best-effort — {@link commitApprovedArtifacts} reports
 * failures rather than throwing, and a git problem must never abort a run whose
 * state has already been persisted.
 */
function persist(root: string, next: RunState, before?: RunState): void {
  RunStateStore.save(root, next);
  if (!before) { return; }

  let doc: unknown;
  try {
    doc = WorkspaceLoader.load(root).config;
  } catch {
    return;
  }
  const cfgDoc = doc as { state?: unknown; artifact_commit?: unknown };
  if (resolveArtifactCommitConfig(cfgDoc).mode !== 'on_approve') { return; }

  // state.json is part of the commit, so it has to carry the approval first.
  try { mirrorRunStateToEpic(root, next, cfgDoc); } catch { /* snapshot only */ }
  commitApprovedArtifacts({ workspaceRoot: root, before, after: next, doc: cfgDoc });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
