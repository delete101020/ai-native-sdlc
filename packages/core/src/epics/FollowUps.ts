/**
 * Follow-up manifests — how any finished epic hands work forward.
 *
 * Stage 6 already closes one loop: an incident's `signal.json` becomes the
 * `intent.md` of a fix epic. Other pipelines end the same way without a signal.
 * A document-alignment pipeline, for one, closes by splitting its decisions into
 * pieces of work, and until now a person copied each piece into Start Epic by
 * hand.
 *
 * The contract is a file, not an integration: a step writes
 * `docs/epics/<epic>/followups.json`, one item per piece of work with its intent
 * already written, and the extension offers to open the ones a person picks. The
 * pipeline decides *what* the work is; this module only scaffolds it. Nothing
 * here knows what an ADR or a gap is.
 *
 * The edge back to the parent is `from_epic` in the child's inputs.json — the
 * same provenance {@link openFollowUpEpic} writes for incidents, so the epic list
 * groups both kinds without a second mechanism. `follow_up_key` says which item
 * of the manifest the child came from.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';

import type { PipelineConfig } from '../schema/WorkspaceSchema';
import { stepAgentId } from '../schema/WorkspaceSchema';
import { scaffoldEpic, epicsRoot, EpicScaffoldError } from '../runs/EpicScaffold';
import type { ScaffoldEpicResult } from '../runs/EpicScaffold';
import { FOLLOW_UPS_FILE } from '../schema/FollowUpHookSchema';
import { EPIC_PIPELINE_FILENAME } from '../loader/EpicPipelineStore';
import { normalizeTags } from '../loader/epicTags';

// Defined beside the hook schema, which has to recognise the manifest's step
// without importing this module (and, through it, the scaffold).
export { FOLLOW_UPS_FILE };

/** The artifact each child starts with — stage 1, reviewed by a human like any other intent. */
export const FOLLOW_UP_INTENT = 'intent.md';

const nonEmpty = (field: string) => z.string().trim().min(1, `\`${field}\` is required`);

export const FollowUpItemSchema = z.object({
  /**
   * Stable handle within the manifest (`E-A`, `W2`). Becomes the child id's
   * suffix and `follow_up_key`, so rewriting a manifest does not orphan the
   * epics already opened from it.
   */
  key: nonEmpty('key').regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, '`key` may use letters, digits, `-` and `_` only'),
  title: nonEmpty('title'),
  /** The child's `intent.md`, verbatim. Written by the step that knows the work. */
  intent: nonEmpty('intent'),
  /** Recipe the child runs on. The caller falls back to its own default when absent. */
  recipe: z.string().trim().min(1).optional(),
  /** One line for the epic card. Defaults to naming the parent. */
  description: z.string().optional(),
  /** `strict_mode` for the child. Absent = the scaffold default. */
  strictMode: z.boolean().optional(),
  /**
   * Why this cannot start yet, in prose. Present = blocked. The item is still
   * listed — hiding it would hide the blocker — but not picked by default.
   */
  blockedBy: z.string().trim().min(1).optional(),
  /** Keys of items that should be done first. Informational: nothing is enforced. */
  dependsOn: z.array(z.string()).default([]),
  /** Extra inputs.json entries for the child. `from_epic` / `follow_up_key` are reserved. */
  inputs: z.record(z.string(), z.string()).default({}),
});

export const FollowUpManifestSchema = z.object({
  version: z.literal(1).default(1),
  items: z.array(FollowUpItemSchema).min(1, 'a manifest needs at least one item'),
}).superRefine((m, ctx) => {
  const seen = new Set<string>();
  m.items.forEach((item, i) => {
    const k = item.key.toUpperCase();
    if (seen.has(k)) {
      ctx.addIssue({ code: 'custom', path: ['items', i, 'key'], message: `duplicate key "${item.key}"` });
    }
    seen.add(k);
  });
});

export type FollowUpItem = z.infer<typeof FollowUpItemSchema>;
export type FollowUpManifest = z.infer<typeof FollowUpManifestSchema>;

export class FollowUpsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FollowUpsParseError';
  }
}

/**
 * Parse and validate a manifest from JSON text or an already-parsed object.
 * Every problem is listed at once: the writer is usually an agent, and one
 * round-trip to fix the file beats one per field.
 */
export function parseFollowUps(input: string | unknown): FollowUpManifest {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      throw new FollowUpsParseError(
        `${FOLLOW_UPS_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const result = FollowUpManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new FollowUpsParseError(`${FOLLOW_UPS_FILE} is malformed — ${issues}`);
  }
  return result.data;
}

/** Raw manifest text of an epic, or null when it has none. */
export function readEpicFollowUps(
  workspaceRoot: string,
  doc: { state?: unknown } | null,
  epicId: string,
): string | null {
  const file = path.join(epicsRoot(workspaceRoot, doc), epicId, FOLLOW_UPS_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

export interface OpenedFollowUp {
  epicId: string;
  /** Manifest key the child was opened from. Absent for incident follow-ups. */
  key?: string;
}

/**
 * Epics already opened from `parentEpicId`, in folder order.
 *
 * Matched on `from_epic` in inputs.json rather than on the id shape: the id is
 * a convenience the user may override, the input is the actual edge.
 */
export function followUpsOf(
  workspaceRoot: string,
  doc: { state?: unknown } | null,
  parentEpicId: string,
): OpenedFollowUp[] {
  const root = epicsRoot(workspaceRoot, doc);
  if (!fs.existsSync(root)) { return []; }
  const out: OpenedFollowUp[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) { continue; }
    const file = path.join(root, entry.name, 'inputs.json');
    if (!fs.existsSync(file)) { continue; }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { from_epic?: unknown; follow_up_key?: unknown };
      if (String(parsed.from_epic ?? '') !== parentEpicId) { continue; }
      const key = String(parsed.follow_up_key ?? '').trim();
      out.push(key ? { epicId: entry.name, key } : { epicId: entry.name });
    } catch {
      // A hand-edited inputs.json is the user's business; it just cannot be a link.
    }
  }
  return out;
}

/**
 * Child id: `<parent>-<KEY>`, e.g. `SNP-STOS-001-E-A`, with `-2`, `-3`, … when
 * taken. Derived from the parent so the family sorts together on disk.
 */
export function followUpChildId(parentEpicId: string, key: string, taken: Iterable<string> = []): string {
  const slug = key.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = slug ? `${parentEpicId}-${slug}` : `${parentEpicId}-FOLLOW-UP`;
  const used = new Set(taken);
  if (!used.has(base)) { return base; }
  for (let n = 2; n < 1000; n++) {
    if (!used.has(`${base}-${n}`)) { return `${base}-${n}`; }
  }
  throw new EpicScaffoldError(`Could not derive a free epic id from "${base}".`);
}

export interface OpenManifestFollowUpArgs {
  workspaceRoot: string;
  /** Raw workspace doc (for `state.root`). Pass null to default `docs/epics`. */
  doc: { state?: unknown } | null;
  parentEpicId: string;
  item: FollowUpItem;
  /** Pipeline the child runs on — normally assembled from `item.recipe`. */
  pipeline: PipelineConfig;
  /** Override the derived id. Defaults to {@link followUpChildId}. */
  epicId?: string;
}

export interface OpenManifestFollowUpResult extends ScaffoldEpicResult {
  epicId: string;
  /** Absolute path of the seeded `intent.md`. */
  intentPath: string;
}

/**
 * Scaffold one manifest item as an epic, with its intent already written.
 *
 * The child starts at stage 1 with the human gate still in place: the intent
 * was written by the step that closed the parent, and a person should read it
 * before anything is specified from it.
 */
export function openManifestFollowUp(args: OpenManifestFollowUpArgs): OpenManifestFollowUpResult {
  const { workspaceRoot, doc, parentEpicId, item, pipeline } = args;

  const steps = Array.isArray(pipeline.steps) ? pipeline.steps : [];
  const agents = steps.map((s) => stepAgentId(s)).filter(Boolean);
  if (agents.length === 0) {
    throw new EpicScaffoldError(`Pipeline "${pipeline.id}" has no steps to run follow-up "${item.key}" on.`);
  }

  const taken = fs.existsSync(epicsRoot(workspaceRoot, doc))
    ? fs.readdirSync(epicsRoot(workspaceRoot, doc))
    : [];
  const epicId = args.epicId ?? followUpChildId(parentEpicId, item.key, taken);

  const result = scaffoldEpic({
    workspaceRoot,
    doc,
    epicId,
    title: item.title,
    description: item.description ?? `Follow-up ${item.key} of ${parentEpicId}.`,
    target: { kind: 'pipeline', id: pipeline.id },
    agents,
    // Provenance last, so a manifest cannot overwrite the edge it is drawn from.
    inputs: withFollowUpProvenance(item.inputs, parentEpicId, item.key),
    pipeline,
    seedArtifacts: { [FOLLOW_UP_INTENT]: item.intent.endsWith('\n') ? item.intent : `${item.intent}\n` },
    ...(item.strictMode !== undefined ? { strictMode: item.strictMode } : {}),
  });

  return {
    ...result,
    epicId,
    intentPath: path.join(result.artifactsDir, FOLLOW_UP_INTENT),
  };
}

/**
 * `inputs` with the edge back to the parent added — last, so nothing the caller
 * passes can overwrite the edge the child is drawn from.
 */
export function withFollowUpProvenance(
  inputs: Record<string, string>,
  parentEpicId: string,
  key: string,
): Record<string, string> {
  return { ...inputs, from_epic: parentEpicId, follow_up_key: key };
}

// ── Follow-ups opened by hand ────────────────────────────────────────────────
//
// A manifest is written by the step that closes an epic. Work also turns up in
// the middle of one — a CR in build finds a second screen that needs the same
// change — and the person who finds it wants it parked beside its parent now,
// not remembered until the closing step. These are the defaults for that: the
// same `from_epic` edge, a key of its own, and the parent's workflow and tags,
// so the note costs a title and a sentence.

/** Prefix of the keys given to follow-ups opened by hand: `F1`, `F2`, … */
export const MANUAL_FOLLOW_UP_KEY_PREFIX = 'F';

/**
 * The next free `F<n>` key. Compared case-insensitively, as manifest keys are,
 * so a hand-opened `F1` and a manifest item `f1` never share a child id.
 */
export function nextManualFollowUpKey(taken: Iterable<string>): string {
  const used = new Set([...taken].map((k) => k.toUpperCase()));
  for (let n = 1; n < 10000; n++) {
    const key = `${MANUAL_FOLLOW_UP_KEY_PREFIX}${n}`;
    if (!used.has(key)) { return key; }
  }
  throw new EpicScaffoldError('Could not find a free follow-up key.');
}

/** What a follow-up runs on — the same two shapes Start Epic offers. */
export interface FollowUpTarget {
  kind: 'recipe' | 'pipeline';
  id: string;
}

export interface FollowUpDefaults {
  parentEpicId: string;
  parentTitle: string;
  /** `follow_up_key` for the child — the next free `F<n>`. */
  key: string;
  /** `<parent>-<key>`, free on disk. */
  epicId: string;
  /** The parent's tags: a follow-up usually lands in the same sprint and team. */
  tags: string[];
  /** The workflow the parent runs on, when one can still be picked. Absent = the person chooses. */
  target?: FollowUpTarget;
}

interface PipelineLike { id?: unknown; derived_from?: unknown; steps?: unknown }
interface RecipeLike { id?: unknown; from?: unknown; steps?: unknown }

function stepIds(steps: unknown): string[] {
  if (!Array.isArray(steps)) { return []; }
  return steps.map((s) => {
    if (typeof s === 'string') { return s; }
    const o = (s ?? {}) as { name?: unknown; agent?: unknown };
    return String(o.name ?? o.agent ?? '');
  });
}

/**
 * The workflow a new epic would pick to run the way the parent does.
 *
 * An epic's own pipeline records one run; it is not something to start another
 * epic on. So it is traced back: to the recipe that assembled it (same source,
 * same steps — the first such recipe, since two recipes may list the same
 * steps), else to the pipeline it was derived from. A parent on a shared
 * pipeline gets that pipeline.
 */
function parentTarget(
  own: PipelineLike | null,
  pipelines: PipelineLike[],
  recipes: RecipeLike[],
): FollowUpTarget | undefined {
  if (!own) { return undefined; }
  const source = typeof own.derived_from === 'string' ? own.derived_from : '';
  if (!source) {
    return typeof own.id === 'string' && own.id ? { kind: 'pipeline', id: own.id } : undefined;
  }
  const steps = stepIds(own.steps).join('\n');
  const recipe = recipes.find((r) =>
    (r.from === undefined || r.from === source) && stepIds(r.steps).join('\n') === steps);
  if (recipe && typeof recipe.id === 'string') { return { kind: 'recipe', id: recipe.id }; }
  if (pipelines.some((p) => p.id === source)) { return { kind: 'pipeline', id: source }; }
  return undefined;
}

/**
 * Defaults for a follow-up of `parentEpicId` opened by hand.
 *
 * `doc` should carry the workspace's `pipelines` and `recipes`. The parent's
 * own pipeline is read from its epic directory first — that is where an epic
 * keeps it — and from `doc.pipelines` only when the file is not there.
 */
export function followUpDefaults(
  workspaceRoot: string,
  doc: { state?: unknown; pipelines?: unknown; recipes?: unknown } | null,
  parentEpicId: string,
): FollowUpDefaults {
  const root = epicsRoot(workspaceRoot, doc);
  const dir = path.join(root, parentEpicId);
  const stateFile = path.join(dir, 'state.json');
  if (!fs.existsSync(stateFile)) {
    throw new EpicScaffoldError(`Epic "${parentEpicId}" not found — no state.json in ${dir}.`);
  }
  let state: { title?: unknown; tags?: unknown; pipeline?: unknown };
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as typeof state;
  } catch (err) {
    throw new EpicScaffoldError(
      `Epic "${parentEpicId}" has an unreadable state.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const pipelines = (Array.isArray(doc?.pipelines) ? doc.pipelines : []) as PipelineLike[];
  const recipes = (Array.isArray(doc?.recipes) ? doc.recipes : []) as RecipeLike[];
  let own: PipelineLike | null = null;
  const ownFile = path.join(dir, EPIC_PIPELINE_FILENAME);
  if (fs.existsSync(ownFile)) {
    try {
      const parsed = yaml.load(fs.readFileSync(ownFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { own = parsed as PipelineLike; }
    } catch { /* unreadable — fall back to the workspace's copy below */ }
  }
  if (!own && typeof state.pipeline === 'string') {
    own = pipelines.find((p) => p.id === state.pipeline) ?? null;
  }

  const key = nextManualFollowUpKey(followUpsOf(workspaceRoot, doc, parentEpicId).map((f) => f.key ?? ''));
  const taken = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const target = parentTarget(own, pipelines, recipes);

  return {
    parentEpicId,
    parentTitle: typeof state.title === 'string' ? state.title : '',
    key,
    epicId: followUpChildId(parentEpicId, key, taken),
    tags: normalizeTags(state.tags),
    ...(target ? { target } : {}),
  };
}
