/**
 * Epic scaffolding — the single source of truth for "start an epic on disk".
 *
 * Both the extension ("Start epic" modal) and the CLI (`aidlc epic start`)
 * call {@link scaffoldEpic} so they produce *byte-identical* folder layouts:
 *
 *   <state.root>/<epicId>/
 *     ├─ state.json      epic-level mirror of the run (status, stepStates, …)
 *     ├─ inputs.json     capability inputs captured at start time
 *     └─ artifacts/      empty; every file in it is agent output
 *   .aidlc/runs/<epicId>.json   the RunState machine (via RunStateStore)
 *
 * Keeping this in core (next to RunStateStore / startRun) means the two front
 * doors can never drift on what files get written or what the state shape is.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { PipelineConfig } from '../schema/WorkspaceSchema';
import type { RunState, StepStatus } from './RunState';
import { startRun } from './PipelineRunner';
import { RunStateStore } from './RunStateStore';
import { EPIC_PIPELINE_FILENAME } from '../loader/EpicPipelineStore';
import { collectContext } from '../epics/ContextCollector';
import { generatePlan, renderPlanMarkdown } from '../epics/PlanGenerator';

/** Epic-level status as persisted in `<epic>/state.json`. */
export type EpicStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export class EpicScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpicScaffoldError';
  }
}

/**
 * Resolve the absolute epics directory from a workspace root + doc.
 * Reads `state.root` (default `docs/epics`). Accepts any object with an
 * optional `state` so both the raw YAML doc and a validated config work.
 */
export function epicsRoot(workspaceRoot: string, doc: { state?: unknown } | null): string {
  const state = doc?.state as Record<string, unknown> | undefined;
  const stateRoot = state && typeof state.root === 'string' && state.root.trim()
    ? state.root
    : 'docs/epics';
  return path.resolve(workspaceRoot, stateRoot);
}

/** Map a run-step status onto the coarser epic-step status. */
export function mapStepStatusToEpic(status: StepStatus): EpicStatus {
  switch (status) {
    case 'approved':
      return 'done';
    case 'rejected':
      return 'failed';
    case 'awaiting_work':
    case 'awaiting_auto_review':
    case 'awaiting_review':
      return 'in_progress';
    case 'pending':
    default:
      return 'pending';
  }
}

/**
 * Mirror the live {@link RunState} back into the epic's `state.json` so the
 * on-disk epic view reflects the run machine (status, current step, per-step
 * detail). No-op when the epic's `state.json` is missing or unparseable — the
 * RunState file remains the source of truth and we re-mirror on the next
 * transition.
 */
export function mirrorRunStateToEpic(
  workspaceRoot: string,
  runState: RunState,
  doc: { state?: unknown } | null,
): void {
  const epicDir = path.join(epicsRoot(workspaceRoot, doc), runState.runId);
  const stateFile = path.join(epicDir, 'state.json');
  if (!fs.existsSync(stateFile)) { return; }

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) ?? {};
    if (typeof parsed !== 'object' || parsed === null) { parsed = {}; }
  } catch {
    return;
  }

  const epicStatus: EpicStatus =
    runState.status === 'completed'
      ? 'done'
      : runState.steps.some((s) => s.status === 'rejected')
        ? 'failed'
        : 'in_progress';

  const stepStates = runState.steps.map((s) => ({
    agent: s.agent,
    // The step's identity, mirrored alongside its agent so state.json says
    // *which* step each entry is about. Two steps can share a persona — the
    // agent alone does not tell them apart, and the index no longer has to.
    name: s.name,
    status: mapStepStatusToEpic(s.status),
    revision: s.revision,
    runStatus: s.status,
    startedAt: s.startedAt ?? null,
    finishedAt: s.finishedAt ?? null,
    rejectReason: s.rejectReason,
    feedback: s.feedback,
    autoReviewVerdict: s.autoReviewVerdict,
    history: s.history ?? [],
    artifactsProduced: s.artifactsProduced,
  }));

  const next = {
    ...parsed,
    status: epicStatus,
    currentStep: runState.currentStepIdx,
    pipeline: typeof parsed.pipeline === 'string' ? parsed.pipeline : runState.pipelineId,
    agents: stepStates.map((s) => s.agent),
    stepStates,
    updatedAt: runState.updatedAt,
  };

  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export interface ScaffoldEpicArgs {
  workspaceRoot: string;
  /** Raw workspace doc (for `state.root`). Pass null to default `docs/epics`. */
  doc: { state?: unknown } | null;
  epicId: string;
  title: string;
  description: string;
  /** `pipeline` runs a multi-step run; `agent` is a single-agent epic. */
  target: { kind: 'pipeline' | 'agent'; id: string };
  /** Resolved agent ids (pipeline step agents, or `[agentId]`). */
  agents: string[];
  inputs: Record<string, string>;
  /** Extra projects attached to the epic (local folders / GitHub repos). */
  extraProjects?: Array<{ type: 'local' | 'github'; ref: string; label: string; mode?: string }>;
  /** Required when `target.kind === 'pipeline'` — used to start the run. */
  pipeline?: PipelineConfig;
  /**
   * Artifact files to seed into `<epic>/artifacts/`, keyed by filename
   * (`intent.md` → its markdown body). The only way a file lands in a new
   * epic's artifacts/ — everything else there is written by an agent.
   *
   * This is how stage 6 closes the loop: `maintain` diagnoses a signal and hands
   * the next epic a real `intent.md` instead of a blank one, so the spec phase
   * has something to read on the very first run. Nothing about it is
   * playbook-specific — any caller that already knows an artifact's content can
   * pass it here.
   *
   * Filenames only: a key containing a path separator (or `..`) is rejected, so
   * a seed can never escape `artifacts/`.
   */
  seedArtifacts?: Record<string, string>;
  /**
   * aidlc-autopilot (experimental / "coming soon"): when true, collect epic
   * context and generate a recommended plan (`context.json` +
   * `autopilot-plan.{json,md}`) at scaffold time. Defaults to **false** so the
   * feature stays dark until it's been tested — callers flip it on via the
   * `aidlc.autopilot.enabled` setting.
   */
  enableAutopilot?: boolean;
  /**
   * How deep the phases of this epic go — `strict_mode` in its `state.json`.
   * Defaults to `true`, which is the depth every epic worked at before the
   * setting existed. See `loader/strictMode.ts`.
   */
  strictMode?: boolean;
}

export interface ScaffoldEpicResult {
  epicDir: string;
  artifactsDir: string;
  /** Set when a pipeline run was started. */
  runState?: RunState;
}

/**
 * Create the on-disk epic. Throws {@link EpicScaffoldError} when the epic dir
 * already exists or required inputs are missing — callers surface the message
 * however suits them (toast / stderr).
 */
export function scaffoldEpic(args: ScaffoldEpicArgs): ScaffoldEpicResult {
  const {
    workspaceRoot, doc, epicId, title, description, target, agents, inputs, extraProjects, pipeline,
    seedArtifacts, enableAutopilot = false, strictMode = true,
  } = args;

  if (!epicId.trim()) { throw new EpicScaffoldError('Epic id is required.'); }
  if (agents.length === 0) {
    throw new EpicScaffoldError(`Target "${target.id}" has no agents.`);
  }

  const epicDir = path.join(epicsRoot(workspaceRoot, doc), epicId);
  // The guard is against scaffolding over an epic that already exists, and
  // what makes a directory an epic is `state.json`. `pipeline.yaml` alone is
  // allowed because we put it there ourselves moments ago: both front doors
  // assemble the epic's pipeline and write the workspace *before* scaffolding,
  // and writing the workspace routes an epic-owned pipeline to this very
  // directory. Anything else in here — an empty leftover included — is not
  // ours to interpret, and still stops us.
  if (fs.existsSync(epicDir)) {
    const entries = fs.readdirSync(epicDir);
    if (entries.length !== 1 || entries[0] !== EPIC_PIPELINE_FILENAME) {
      throw new EpicScaffoldError(
        `Epic dir already exists at ${path.relative(workspaceRoot, epicDir) || epicDir}. Delete it first.`,
      );
    }
  }

  fs.mkdirSync(epicDir, { recursive: true });
  const artifactsDir = path.join(epicDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  // `artifacts/` is created empty and stays empty until an agent writes into
  // it. Blank templates used to be copied here from
  // `.aidlc/aidlc-templates/<pipelineId>/`, and that quietly cost more than it
  // gave:
  //
  //   - `canStartStep` and `markStepDone` gate on `fs.existsSync` alone, so a
  //     pre-seeded file satisfied every `requires` / `produces` check from the
  //     moment the epic was created. "Mark step done" lit up on step 1 of a
  //     brand-new epic, and the gate meant nothing.
  //   - The copy took the whole template dir, keyed by `derived_from` — the
  //     *source* pipeline — so an epic assembled from a recipe that drops the
  //     spec and maintain stages still received `spec.md` and `incident.md`,
  //     and the agents downstream had to explain in prose why files sitting in
  //     their own artifacts/ were not theirs.
  //
  // The templates are still provisioned and still worth reading: the command
  // bodies point each agent at `.aidlc/aidlc-templates/` for the shape (see
  // `builtinClaudeCommand`). Nothing is lost by leaving the copy out, and
  // existence recovers its meaning.

  // A caller-supplied artifact is real content, not a blank template — stage 6
  // handing the next epic its `intent.md` — so it is still written here.
  for (const [fileName, content] of Object.entries(seedArtifacts ?? {})) {
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..') || !fileName.trim()) {
      throw new EpicScaffoldError(`Seed artifact name must be a plain filename, got "${fileName}".`);
    }
    fs.writeFileSync(path.join(artifactsDir, fileName), content, 'utf8');
  }

  const initialState = {
    id: epicId,
    title,
    description,
    pipeline: target.kind === 'pipeline' ? target.id : null,
    agent: target.kind === 'agent' ? target.id : null,
    agents,
    currentStep: 0,
    status: 'pending' as const,
    // Written even when true, and written next to the fields a person reads,
    // because the point of a per-epic knob is that it can be found and flipped
    // by hand on an epic that turns out bigger or smaller than it looked.
    strict_mode: strictMode,
    createdAt: new Date().toISOString(),
    stepStates: agents.map((a) => ({
      agent: a,
      status: 'pending' as const,
      startedAt: null,
      finishedAt: null,
    })),
  };
  fs.writeFileSync(
    path.join(epicDir, 'state.json'),
    JSON.stringify(initialState, null, 2) + '\n',
    'utf8',
  );

  // `<epicId>.md` is what the first phase's skill opens for context — the
  // AI-Native intent skill's step 1 is literally "read the epic doc at
  // docs/epics/$0/$0.md". state.json is machine state and no skill reads it,
  // so without this the title and description the user just typed reach no
  // agent at all: the run starts from an empty brief and asks for everything
  // back. Markdown, because the agent reads it as prose.
  const epicDoc =
    `# ${epicId}${title ? ` — ${title}` : ''}\n` +
    (description ? `\n${description}\n` : '');
  fs.writeFileSync(path.join(epicDir, `${epicId}.md`), epicDoc, 'utf8');

  const persistedInputs: Record<string, unknown> = { ...inputs };
  if (extraProjects && extraProjects.length > 0) {
    persistedInputs.extra_projects = extraProjects;
  }
  fs.writeFileSync(
    path.join(epicDir, 'inputs.json'),
    JSON.stringify(persistedInputs, null, 2) + '\n',
    'utf8',
  );

  // aidlc-autopilot (experimental — off by default, "coming soon"): collect
  // context and generate a plan. Gated so it stays dark until tested; when
  // disabled the epic scaffolds exactly as it did pre-autopilot.
  if (enableAutopilot) {
    const context = collectContext(
      workspaceRoot,
      epicDir,
      epicId,
      description || title || epicId,
    );
    fs.writeFileSync(
      path.join(epicDir, 'context.json'),
      JSON.stringify(context, null, 2) + '\n',
      'utf8',
    );

    if (target.kind === 'pipeline' && pipeline && Array.isArray(pipeline.steps) && pipeline.steps.length > 0) {
      const plan = generatePlan(
        epicId,
        context,
        pipeline,
        (doc as { agents?: { id: string; skills?: string[] }[] } | null) || {},
      );
      fs.writeFileSync(
        path.join(epicDir, 'autopilot-plan.json'),
        JSON.stringify(plan, null, 2) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(epicDir, 'autopilot-plan.md'),
        renderPlanMarkdown(plan) + '\n',
        'utf8',
      );
    }
  }

  // Start the pipeline run machine + mirror it into the epic's state.json.
  let runState: RunState | undefined;
  if (target.kind === 'pipeline' && pipeline
    && Array.isArray(pipeline.steps) && pipeline.steps.length > 0
    && !RunStateStore.load(workspaceRoot, epicId)) {
    runState = startRun({
      runId: epicId,
      pipeline,
      context: { epic: epicId, ...inputs },
    });
    RunStateStore.save(workspaceRoot, runState);
    mirrorRunStateToEpic(workspaceRoot, runState, doc);
  }

  return { epicDir, artifactsDir, runState };
}
