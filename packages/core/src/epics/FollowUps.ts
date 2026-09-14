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
import { z } from 'zod';

import type { PipelineConfig } from '../schema/WorkspaceSchema';
import { stepAgentId } from '../schema/WorkspaceSchema';
import { scaffoldEpic, epicsRoot, EpicScaffoldError } from '../runs/EpicScaffold';
import type { ScaffoldEpicResult } from '../runs/EpicScaffold';
import { FOLLOW_UPS_FILE } from '../schema/FollowUpHookSchema';

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
    inputs: {
      ...item.inputs,
      from_epic: parentEpicId,
      follow_up_key: item.key,
    },
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
