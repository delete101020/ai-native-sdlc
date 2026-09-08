/**
 * Per-epic pipelines, stored beside the epic rather than inside the shared
 * `.aidlc/workspace.yaml`.
 *
 * Starting an epic assembles a pipeline from a recipe and has to keep it —
 * `docs/epics/<id>/state.json` names it, and every later step edit rewrites
 * it. Keeping those definitions in `workspace.yaml` put per-epic state and
 * team-wide config (agents, skills, recipes, the base pipeline) in one tracked
 * file: concurrent epics conflict on the same append point, and the file grows
 * by a near-copy of the base pipeline per epic.
 *
 * So an epic's pipeline lives in `docs/epics/<id>/pipeline.yaml` — one file,
 * one owner, no shared append point. The rest of the system never learns
 * about it: {@link mergeEpicPipelines} splices those files into `pipelines:`
 * at read time, and {@link splitEpicPipelines} routes them back out at write
 * time, so the ~40 call sites that do `doc.pipelines.find(...)` keep working
 * unchanged.
 *
 * Where a pipeline came from is remembered per parsed document, not written
 * into the YAML — a marker key would leak into every dump and into presets.
 * A pipeline nobody staged or read from an epic file stays inline, which is
 * what shared, hand-authored pipelines want.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { epicsRoot } from '../runs/EpicScaffold';

/** File an epic's own pipeline lives in, inside the epic directory. */
export const EPIC_PIPELINE_FILENAME = 'pipeline.yaml';

/** The shape both the raw YAML doc and a validated config satisfy. */
interface PipelineCarrier {
  pipelines: Array<Record<string, unknown>>;
  state?: unknown;
}

/** pipeline id → owning epic id, per parsed document. */
const ORIGINS = new WeakMap<object, Map<string, string>>();

/**
 * What the last merge into a document found. Kept beside the document rather
 * than returned to every caller, because `readYaml` has one return value and
 * only `aidlc doctor` wants the diagnostics.
 */
const REPORTS = new WeakMap<object, MergeEpicPipelinesResult>();

/** Diagnostics from the merge that produced this document, if any. */
export function epicPipelineReport(doc: object): MergeEpicPipelinesResult | undefined {
  return REPORTS.get(doc);
}

function originsOf(doc: object): Map<string, string> {
  let m = ORIGINS.get(doc);
  if (!m) {
    m = new Map();
    ORIGINS.set(doc, m);
  }
  return m;
}

/** Absolute path of the pipeline file belonging to `epicId`. */
export function epicPipelinePath(
  workspaceRoot: string,
  doc: { state?: unknown } | null,
  epicId: string,
): string {
  return path.join(epicsRoot(workspaceRoot, doc), epicId, EPIC_PIPELINE_FILENAME);
}

/**
 * An epic file and the shared workspace both define the same pipeline id.
 * Not fatal — the epic file wins, because it is the one an epic owns — but
 * the inline copy is dead config that still reads as if it were in force.
 */
export interface EpicPipelineConflict {
  epicId: string;
  pipelineId: string;
  file: string;
}

export interface MergeEpicPipelinesResult {
  /** Pipeline ids spliced in from epic files. */
  merged: string[];
  conflicts: EpicPipelineConflict[];
  /** Epic files that could not be read or did not hold a pipeline object. */
  unreadable: Array<{ file: string; reason: string }>;
}

/**
 * Splice every epic's own `pipeline.yaml` into `doc.pipelines`, and
 * remember which epic each came from so a later write can route it back.
 * Mutates `doc` in place and is safe to call on a document with no epics.
 */
export function mergeEpicPipelines(
  workspaceRoot: string,
  doc: PipelineCarrier,
): MergeEpicPipelinesResult {
  const result: MergeEpicPipelinesResult = { merged: [], conflicts: [], unreadable: [] };
  REPORTS.set(doc, result);
  const root = epicsRoot(workspaceRoot, doc);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result; // No epics directory yet — nothing to merge.
  }

  const origins = originsOf(doc);
  // Sorted so a workspace loads identically everywhere, whatever order the
  // filesystem hands back.
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name, EPIC_PIPELINE_FILENAME);
    if (!fs.existsSync(file)) { continue; }
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      result.unreadable.push({ file, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      result.unreadable.push({ file, reason: 'did not parse to a pipeline object' });
      continue;
    }
    const pipeline = parsed as Record<string, unknown>;
    // The id may differ from the epic id — `recipePipelineId` falls back to
    // `<epic>-<recipe>` when the plain epic id is taken — so the file names
    // itself, and only defaults to the directory it sits in.
    const id = typeof pipeline.id === 'string' && pipeline.id.trim() ? pipeline.id : entry.name;
    pipeline.id = id;

    const inlineAt = doc.pipelines.findIndex((p) => p.id === id);
    if (inlineAt >= 0) {
      result.conflicts.push({ epicId: entry.name, pipelineId: id, file });
      doc.pipelines.splice(inlineAt, 1, pipeline);
    } else {
      doc.pipelines.push(pipeline);
    }
    origins.set(id, entry.name);
    result.merged.push(id);
  }
  return result;
}

/**
 * Mark a pipeline as owned by `epicId`, so the next write puts it in that
 * epic's file instead of `workspace.yaml`. Call it right after pushing an
 * assembled pipeline for a new epic.
 */
export function stageEpicPipeline(doc: object, pipelineId: string, epicId: string): void {
  originsOf(doc).set(pipelineId, epicId);
}

/** Forget a pipeline's epic, so the next write keeps it inline. */
export function unstageEpicPipeline(doc: object, pipelineId: string): void {
  originsOf(doc).delete(pipelineId);
}

/** The epic that owns `pipelineId` in this document, if any. */
export function epicOwningPipeline(doc: object, pipelineId: string): string | undefined {
  return ORIGINS.get(doc)?.get(pipelineId);
}

export interface ExternalEpicPipeline {
  epicId: string;
  pipelineId: string;
  file: string;
  pipeline: Record<string, unknown>;
}

export interface SplitEpicPipelinesResult {
  /** What `workspace.yaml` should still carry. */
  inline: Array<Record<string, unknown>>;
  /** What belongs in an epic file. */
  external: ExternalEpicPipeline[];
}

/**
 * Partition a document's pipelines into the ones `workspace.yaml` keeps and
 * the ones an epic owns. Does not touch disk or mutate `doc`.
 */
export function splitEpicPipelines(
  workspaceRoot: string,
  doc: PipelineCarrier,
): SplitEpicPipelinesResult {
  const origins = ORIGINS.get(doc);
  const out: SplitEpicPipelinesResult = { inline: [], external: [] };
  for (const pipeline of doc.pipelines) {
    const id = typeof pipeline.id === 'string' ? pipeline.id : '';
    const epicId = id ? origins?.get(id) : undefined;
    if (epicId) {
      out.external.push({
        epicId,
        pipelineId: id,
        file: epicPipelinePath(workspaceRoot, doc, epicId),
        pipeline,
      });
    } else {
      out.inline.push(pipeline);
    }
  }
  return out;
}

/**
 * Write each epic-owned pipeline to its own file, atomically. Runs before the
 * `workspace.yaml` dump: if that dump then fails, the epic files are still the
 * definitions that win on the next read, so the two never disagree silently.
 */
export function writeEpicPipelines(entries: readonly ExternalEpicPipeline[]): void {
  for (const { file, pipeline, epicId } of entries) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header =
      `# Pipeline for ${epicId}, owned by this epic.\n`
      + '# Kept out of .aidlc/workspace.yaml on purpose: that file is shared team\n'
      + '# config, and one append point per epic is one merge conflict per epic.\n'
      + '# Referenced by state.json ("pipeline"). Commit it with the epic.\n';
    const text = header + yaml.dump(pipeline, {
      lineWidth: 120,
      quotingType: '"',
      forceQuotes: false,
      noRefs: true,
    });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  }
}

export interface EpicPipelineExtraction {
  epicId: string;
  pipelineId: string;
  file: string;
}

/**
 * Find the inline pipelines an epic owns, for the one-time move out of
 * `workspace.yaml`.
 *
 * Two conditions, and both are needed. The epic must name the pipeline in its
 * `state.json` — a pipeline nobody runs is not an epic's to take. And the
 * pipeline must be named the way `recipePipelineId` names one it assembled for
 * that epic (`EPIC-001`, or `EPIC-001-native-lite`), because an epic started
 * on a shared, hand-authored pipeline names that one too, and moving it into
 * one epic's directory would take it away from every other epic running it.
 */
export function planEpicPipelineExtraction(
  workspaceRoot: string,
  doc: PipelineCarrier,
): EpicPipelineExtraction[] {
  const root = epicsRoot(workspaceRoot, doc);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: EpicPipelineExtraction[] = [];
  const dirs = entries.filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of dirs) {
    const dir = path.join(root, entry.name);
    if (fs.existsSync(path.join(dir, EPIC_PIPELINE_FILENAME))) { continue; }
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const pipelineId = typeof state.pipeline === 'string' ? state.pipeline : '';
    if (!pipelineId) { continue; }
    if (!doc.pipelines.some((p) => p.id === pipelineId)) { continue; }
    // Assembled for this epic, not merely run by it.
    if (pipelineId !== entry.name && !pipelineId.startsWith(`${entry.name}-`)) { continue; }
    // Belt and braces: an id claimed twice is shared however it is named.
    if (out.some((o) => o.pipelineId === pipelineId)) { continue; }
    out.push({ epicId: entry.name, pipelineId, file: path.join(dir, EPIC_PIPELINE_FILENAME) });
  }
  return out;
}
