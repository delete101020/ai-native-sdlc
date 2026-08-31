/**
 * Closing the loop — stage 6 back to stage 1.
 *
 * The AI-Native SDLC Playbook's sixth stage is not "watch dashboards"; it is the
 * return path. A signal from production becomes a diagnosis (`incident.md`), and
 * when the fix is real work the diagnosis becomes the `intent.md` of a *new*
 * epic, which re-enters the pipeline at stage 1 and is reviewed by a human there
 * like any other intent.
 *
 * That last step is the only part that needs engine support: an epic normally
 * starts with blank artifact templates, and the follow-up epic must start with a
 * written intent instead. {@link openFollowUpEpic} is a thin wrapper over
 * `scaffoldEpic` that seeds it.
 *
 * What deliberately does *not* live here: any decision about whether a signal is
 * worth an epic, and any diagnosis. Those are the Operator agent's judgment,
 * made against the code and the epic's own artifacts. This module only writes
 * down what it is handed — a rendering function is a bad place to decide whether
 * to page someone at 3am.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { PipelineConfig } from '../schema/WorkspaceSchema';
import { stepAgentId } from '../schema/WorkspaceSchema';
import { scaffoldEpic, epicsRoot, EpicScaffoldError } from '../runs/EpicScaffold';
import type { ScaffoldEpicResult } from '../runs/EpicScaffold';
import type { Signal } from './Signal';

/** The playbook's stage-1 artifact — what stage 6 hands forward. */
export const FOLLOW_UP_ARTIFACT = 'intent.md';

/**
 * Derive an epic id from a signal's symptom: `<prefix>-<SLUG>`, e.g.
 * `INC-CHECKOUT-RETURNS-500`.
 *
 * Readable on purpose. This id shows up in a branch name, a folder, and every
 * later reference to the incident, and `INC-7` tells a reader nothing six weeks
 * later. When `taken` already contains the id, a `-2`, `-3`, … suffix is added:
 * the same symptom recurring is exactly when you most want the two epics side by
 * side rather than one silently refusing to open.
 */
export function followUpEpicId(
  signal: Signal,
  opts: { prefix?: string; taken?: Iterable<string> } = {},
): string {
  const prefix = (opts.prefix ?? 'INC').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'INC';
  const slug = signal.symptom
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .slice(0, 24)
    .replace(/-+$/g, '');
  const base = slug ? `${prefix}-${slug}` : prefix;
  const taken = new Set(opts.taken ?? []);
  if (!taken.has(base)) { return base; }
  for (let n = 2; n < 1000; n++) {
    if (!taken.has(`${base}-${n}`)) { return `${base}-${n}`; }
  }
  throw new EpicScaffoldError(`Could not derive a free epic id from "${base}".`);
}

/** Epic ids already on disk — the `taken` set for {@link followUpEpicId}. */
export function existingEpicIds(workspaceRoot: string, doc: { state?: unknown } | null): string[] {
  const root = epicsRoot(workspaceRoot, doc);
  if (!fs.existsSync(root)) { return []; }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export interface RenderIntentOptions {
  /** The epic whose `maintain` phase produced this signal. Cited as provenance. */
  fromEpicId?: string;
  /** Prose the Operator wrote: the problem in the user's terms, not the stack's. */
  problem?: string;
  /** The specific role doing the specific task. */
  whoHurts?: string;
  /** What it costs them. Defaults to the signal's `scope`. */
  cost?: string;
  /** The observable condition that says this cannot recur. */
  doneLooksLike?: string;
  /** Everything the Operator would have asked a human, had one been awake. */
  openQuestions?: string[];
  /** ISO date for the header. Defaults to now. */
  now?: Date;
}

/**
 * Render the follow-up `intent.md`.
 *
 * Two rules shape this output, both inherited from stage 1 rather than invented
 * here:
 *
 * 1. **No solution language.** Even when the Operator is fairly sure which line
 *    is at fault, that belongs in `incident.md`. An intent that names the fix has
 *    pre-decided the spec, and the next four stages become theatre.
 * 2. **Never invent evidence.** Anything the caller did not supply is written as
 *    an explicit open question, not filled with a plausible sentence. A gap a
 *    human can see gets answered; a fabricated line gets believed.
 */
export function renderIntentMarkdown(signal: Signal, opts: RenderIntentOptions = {}): string {
  const now = opts.now ?? new Date();
  const created = now.toISOString().slice(0, 10);
  const unknown = '_Not established by the signal — answer before this epic leaves stage 1._';

  const questions = [...(opts.openQuestions ?? [])];
  if (!opts.problem) { questions.push('Is the observed symptom the problem, or a side effect of one?'); }
  if (!opts.whoHurts) { questions.push('Which specific role, doing which task, is affected?'); }
  if (!opts.doneLooksLike) { questions.push('What observable condition tells us this cannot recur?'); }

  const lines: string[] = [
    `# Intent — ${signal.symptom}`,
    '',
    `**Originator:** Operator (stage 6, signal from \`${signal.source}\`)`,
    '**Status:** Draft',
    `**Created:** \`${created}\``,
    `**Observed:** \`${signal.observedAt}\``,
  ];
  if (opts.fromEpicId) {
    lines.push(`**Follows:** \`${opts.fromEpicId}\``);
  }
  lines.push(
    '',
    '---',
    '',
    '## 1. Problem',
    '',
    opts.problem ?? unknown,
    '',
    `> Observed: ${signal.symptom}`,
    '',
    '## 2. Who hurts',
    '',
    opts.whoHurts ?? unknown,
    '',
    '## 3. Cost',
    '',
    opts.cost ?? signal.scope,
    '',
    '## 4. Evidence',
    '',
    `Signal from \`${signal.source}\`, observed \`${signal.observedAt}\`.`,
    '',
    signal.evidence.trim()
      ? ['```', signal.evidence.trim(), '```'].join('\n')
      : '_No evidence attached to the signal._',
    '',
    '## 5. Done looks like',
    '',
    opts.doneLooksLike ?? unknown,
    '',
    '## 6. Not this',
    '',
    '- Repairing the symptom without establishing the cause.',
    '',
    '## 7. Open questions',
    '',
    '| # | Question | Who can answer |',
    '|---|---|---|',
  );
  questions.forEach((q, i) => { lines.push(`| ${i + 1} | ${q} |  |`); });
  if (questions.length === 0) { lines.push('| 1 | _None outstanding._ |  |'); }
  lines.push(
    '',
    '---',
    '',
    '*Emitted by stage 6 (`maintain`) and reviewed at stage 1 like any other intent.',
    'No solution language: the diagnosis lives in `incident.md`, and what to do',
    'about it is the spec phase\'s decision.*',
    '',
  );
  return lines.join('\n');
}

export interface OpenFollowUpEpicArgs {
  workspaceRoot: string;
  /** Raw workspace doc (for `state.root`). Pass null to default `docs/epics`. */
  doc: { state?: unknown } | null;
  /** The signal that opened this. */
  signal: Signal;
  /** Pipeline the follow-up epic runs on — normally the same one that shipped the change. */
  pipeline: PipelineConfig;
  /** The epic whose `maintain` phase produced the signal. */
  fromEpicId?: string;
  /** Override the derived id. Defaults to {@link followUpEpicId} against the epics on disk. */
  epicId?: string;
  /** Override the rendered intent. Defaults to {@link renderIntentMarkdown}. */
  intentMarkdown?: string;
  /** Passed through to {@link renderIntentMarkdown} when `intentMarkdown` is not given. */
  intent?: RenderIntentOptions;
  /** Override the `.aidlc` dir artifact templates are read from. */
  aidlcDir?: string;
}

export interface OpenFollowUpEpicResult extends ScaffoldEpicResult {
  epicId: string;
  /** Absolute path of the seeded `intent.md`. */
  intentPath: string;
}

/**
 * Open the follow-up epic: scaffold it on `pipeline` with `intent.md` already
 * written, so the spec phase has something to read on its first run.
 *
 * The epic starts at stage 1 with a human gate, not at stage 2 — an intent
 * written by an agent at 3am from a single alert is exactly the kind of document
 * that deserves a person's eyes before anything is specified from it.
 */
export function openFollowUpEpic(args: OpenFollowUpEpicArgs): OpenFollowUpEpicResult {
  const { workspaceRoot, doc, signal, pipeline, fromEpicId, aidlcDir } = args;

  const steps = Array.isArray(pipeline.steps) ? pipeline.steps : [];
  const agents = steps.map((s) => stepAgentId(s)).filter(Boolean);
  if (agents.length === 0) {
    throw new EpicScaffoldError(`Pipeline "${pipeline.id}" has no steps to run the follow-up epic on.`);
  }

  const epicId = args.epicId
    ?? followUpEpicId(signal, { taken: existingEpicIds(workspaceRoot, doc) });

  const intentMarkdown = args.intentMarkdown
    ?? renderIntentMarkdown(signal, { fromEpicId, ...(args.intent ?? {}) });

  const result = scaffoldEpic({
    workspaceRoot,
    doc,
    epicId,
    title: signal.symptom,
    description: `Opened by stage 6 from a \`${signal.source}\` signal observed ${signal.observedAt}.`,
    target: { kind: 'pipeline', id: pipeline.id },
    agents,
    // Provenance, so the epic can be traced back to what opened it without
    // re-reading the prose.
    inputs: {
      signal_source: signal.source,
      signal_observed_at: signal.observedAt,
      signal_symptom: signal.symptom,
      signal_scope: signal.scope,
      ...(fromEpicId ? { from_epic: fromEpicId } : {}),
    },
    pipeline,
    seedArtifacts: { [FOLLOW_UP_ARTIFACT]: intentMarkdown },
    aidlcDir,
  });

  return {
    ...result,
    epicId,
    intentPath: path.join(result.artifactsDir, FOLLOW_UP_ARTIFACT),
  };
}

// ── Stage 6 itself: registering the signal ───────────────────────────────────

/**
 * Where the raw signal is parked inside the incident epic.
 *
 * The `native-maintain` skill reads `docs/epics/<epic>/signal.json` when no path
 * is passed to it, so writing the file here is what lets a front door hand an
 * unattended agent its input without a flag.
 */
export const SIGNAL_FILE = 'signal.json';

export interface OpenIncidentEpicArgs {
  workspaceRoot: string;
  /** Raw workspace doc (for `state.root`). Pass null to default `docs/epics`. */
  doc: { state?: unknown } | null;
  signal: Signal;
  /** Pipeline the incident epic runs on — normally a single `maintain` step. */
  pipeline: PipelineConfig;
  /** Override the derived id. Defaults to {@link followUpEpicId} against the epics on disk. */
  epicId?: string;
  /** Id prefix when deriving. Defaults to `INC`. */
  prefix?: string;
  /** Override the `.aidlc` dir artifact templates are read from. */
  aidlcDir?: string;
}

export interface OpenIncidentEpicResult extends ScaffoldEpicResult {
  epicId: string;
  /** Absolute path of the written `signal.json`. */
  signalPath: string;
}

/**
 * Register a production signal as an epic: scaffold it on `pipeline` with the
 * signal written to `signal.json`, so the Operator has somewhere to write
 * `incident.md` and something to read when it gets there.
 *
 * This deliberately stops at *registering*. Whether the incident is worth a
 * follow-up epic is a diagnosis, and a diagnosis is the Operator's judgment made
 * against the code — a front door that decided it from five JSON fields would be
 * guessing. {@link openFollowUpEpic} is the separate step that runs after.
 */
export function openIncidentEpic(args: OpenIncidentEpicArgs): OpenIncidentEpicResult {
  const { workspaceRoot, doc, signal, pipeline, aidlcDir } = args;

  const steps = Array.isArray(pipeline.steps) ? pipeline.steps : [];
  const agents = steps.map((s) => stepAgentId(s)).filter(Boolean);
  if (agents.length === 0) {
    throw new EpicScaffoldError(`Pipeline "${pipeline.id}" has no steps to run the incident epic on.`);
  }

  const epicId = args.epicId
    ?? followUpEpicId(signal, { prefix: args.prefix, taken: existingEpicIds(workspaceRoot, doc) });

  const result = scaffoldEpic({
    workspaceRoot,
    doc,
    epicId,
    title: signal.symptom,
    description: `Signal from \`${signal.source}\`, observed ${signal.observedAt}. ${signal.scope}`,
    target: { kind: 'pipeline', id: pipeline.id },
    agents,
    inputs: {
      signal_source: signal.source,
      signal_observed_at: signal.observedAt,
      signal_symptom: signal.symptom,
      signal_scope: signal.scope,
    },
    pipeline,
    aidlcDir,
  });

  // The signal, verbatim and re-parseable. Not folded into inputs.json: a later
  // source (Sentry, OTel, a pager) fills the same five fields, and keeping the
  // payload as its own file is what makes those reports comparable.
  const signalPath = path.join(result.epicDir, SIGNAL_FILE);
  fs.writeFileSync(signalPath, JSON.stringify(signal, null, 2) + '\n', 'utf8');

  return { ...result, epicId, signalPath };
}

/**
 * Read a signal back out of an incident epic. Returns null when the epic has
 * none — a caller that was handed only an epic id can then say so plainly rather
 * than proceed on an invented signal.
 */
export function readEpicSignal(
  workspaceRoot: string,
  doc: { state?: unknown } | null,
  epicId: string,
): string | null {
  const file = path.join(epicsRoot(workspaceRoot, doc), epicId, SIGNAL_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * Derive the follow-up epic's id from the incident's: `<incident>-FIX`, with a
 * `-2`, `-3`, … suffix when that is taken.
 *
 * Deriving rather than re-slugging the symptom keeps the pair adjacent when the
 * epics are listed, which is the only time anyone reads these ids: the incident
 * and the work it opened sort next to each other.
 */
export function followUpIdFor(incidentEpicId: string, taken: Iterable<string> = []): string {
  const base = `${incidentEpicId}-FIX`;
  const used = new Set(taken);
  if (!used.has(base)) { return base; }
  for (let n = 2; n < 1000; n++) {
    if (!used.has(`${base}-${n}`)) { return `${base}-${n}`; }
  }
  throw new EpicScaffoldError(`Could not derive a free epic id from "${base}".`);
}
