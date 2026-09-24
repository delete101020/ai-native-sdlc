/**
 * Attachments: documents a person adds to an epic by hand.
 *
 * Everything else in an epic folder is written by the tool or by an agent. This
 * is the one way in for material that exists outside it: a requirements doc
 * that turned up after the epic started, or an artifact produced by a run
 * somewhere else. Two scopes, with different readers:
 *
 * - **Epic inputs**, copied to `inputs/`. Every step reads them.
 * - **Step attachments**, copied to `attachments/<step>/`. Only that step reads
 *   them.
 *
 * Both are recorded in `attachments.json`, the manifest the step prompts point
 * agents at. The files are copied, not linked, so an epic keeps working after
 * the original moves, and nothing outside the workspace has to stay reachable.
 *
 * Attachments never enter `artifactsProduced`. That list belongs to the run
 * machine and is reset on every rerun and undo. Replacing a step's own output
 * with an external file is a different operation, {@link placeStepOutput}: it
 * writes the declared `produces` path, and the normal mark-done gate decides the
 * rest.
 */

import * as fs from 'fs';
import * as path from 'path';

export const ATTACHMENTS_FILE = 'attachments.json';
export const EPIC_INPUTS_DIR = 'inputs';
export const STEP_ATTACHMENTS_DIR = 'attachments';

export interface Attachment {
  /** Path relative to the epic folder, forward slashes. */
  path: string;
  /** Original file name, as the person picked it. */
  name: string;
  addedAt: string;
}

export interface EpicAttachments {
  epic: Attachment[];
  /** Keyed by step name (the step's `name`, or its agent when unnamed). */
  steps: Record<string, Attachment[]>;
}

function emptyAttachments(): EpicAttachments {
  return { epic: [], steps: {} };
}

function isAttachment(v: unknown): v is Attachment {
  if (!v || typeof v !== 'object') { return false; }
  const o = v as Record<string, unknown>;
  return typeof o.path === 'string' && o.path !== '' && typeof o.name === 'string';
}

function cleanList(v: unknown): Attachment[] {
  if (!Array.isArray(v)) { return []; }
  return v.filter(isAttachment).map((a) => ({
    path: a.path,
    name: a.name,
    addedAt: typeof a.addedAt === 'string' ? a.addedAt : '',
  }));
}

/** The manifest, or an empty one. A missing or hand-broken file is not an error. */
export function readEpicAttachments(epicDir: string): EpicAttachments {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(epicDir, ATTACHMENTS_FILE), 'utf8'));
  } catch {
    return emptyAttachments();
  }
  if (!raw || typeof raw !== 'object') { return emptyAttachments(); }
  const o = raw as Record<string, unknown>;
  const steps: Record<string, Attachment[]> = {};
  if (o.steps && typeof o.steps === 'object') {
    for (const [step, list] of Object.entries(o.steps as Record<string, unknown>)) {
      const clean = cleanList(list);
      if (clean.length > 0) { steps[step] = clean; }
    }
  }
  return { epic: cleanList(o.epic), steps };
}

function writeEpicAttachments(epicDir: string, att: EpicAttachments): void {
  fs.writeFileSync(path.join(epicDir, ATTACHMENTS_FILE), JSON.stringify(att, null, 2) + '\n', 'utf8');
}

/** A step name made safe to use as one folder name. */
export function stepFolderName(stepName: string): string {
  const safe = stepName.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  return safe || 'step';
}

/** `name` inside `dir`, or `name-2`, `name-3`, … when that is taken. */
function uniqueFileName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) { return name; }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) { return candidate; }
  }
}

function copyInto(epicDir: string, relDir: string, sourceFile: string, now: Date): Attachment {
  if (!fs.statSync(sourceFile).isFile()) {
    throw new Error(`Not a file: ${sourceFile}`);
  }
  const dir = path.join(epicDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(sourceFile);
  const fileName = uniqueFileName(dir, name);
  fs.copyFileSync(sourceFile, path.join(dir, fileName));
  return { path: `${relDir}/${fileName}`, name, addedAt: now.toISOString() };
}

/** Copy `sourceFile` into the epic's `inputs/` and record it. Every step reads it. */
export function addEpicInput(epicDir: string, sourceFile: string, now: Date = new Date()): Attachment {
  const entry = copyInto(epicDir, EPIC_INPUTS_DIR, sourceFile, now);
  const att = readEpicAttachments(epicDir);
  att.epic.push(entry);
  writeEpicAttachments(epicDir, att);
  return entry;
}

/** Copy `sourceFile` into `attachments/<step>/` and record it. Only that step reads it. */
export function attachStepFile(
  epicDir: string,
  stepName: string,
  sourceFile: string,
  now: Date = new Date(),
): Attachment {
  const relDir = `${STEP_ATTACHMENTS_DIR}/${stepFolderName(stepName)}`;
  const entry = copyInto(epicDir, relDir, sourceFile, now);
  const att = readEpicAttachments(epicDir);
  (att.steps[stepName] ??= []).push(entry);
  writeEpicAttachments(epicDir, att);
  return entry;
}

/**
 * Drop an attachment from the manifest and delete its copy. Only files under
 * `inputs/` or `attachments/` are deleted: the manifest is hand-editable, and a
 * path in it must never be able to remove an artifact. Returns false when the
 * path was not in the manifest.
 */
export function removeAttachment(epicDir: string, relPath: string): boolean {
  const att = readEpicAttachments(epicDir);
  let found = false;
  const keep = (list: Attachment[]) => list.filter((a) => {
    if (a.path !== relPath) { return true; }
    found = true;
    return false;
  });
  att.epic = keep(att.epic);
  for (const step of Object.keys(att.steps)) {
    att.steps[step] = keep(att.steps[step]);
    if (att.steps[step].length === 0) { delete att.steps[step]; }
  }
  if (!found) { return false; }
  writeEpicAttachments(epicDir, att);

  const abs = path.resolve(epicDir, relPath);
  const owned = [EPIC_INPUTS_DIR, STEP_ATTACHMENTS_DIR].some((d) => {
    const rel = path.relative(path.resolve(epicDir, d), abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (owned) { fs.rmSync(abs, { force: true }); }
  return true;
}

/** What a step reads: every epic input, then its own attachments. */
export function attachmentsForStep(att: EpicAttachments, stepName: string): Attachment[] {
  return [...att.epic, ...(att.steps[stepName] ?? [])];
}

/**
 * Write an externally produced file to a step's declared output path,
 * overwriting what is there. Marking the step done still runs the usual
 * `produces` / `produces_contains` checks; this only puts the file in place.
 */
export function placeStepOutput(sourceFile: string, targetAbs: string): void {
  if (!fs.statSync(sourceFile).isFile()) {
    throw new Error(`Not a file: ${sourceFile}`);
  }
  if (path.resolve(sourceFile) === path.resolve(targetAbs)) { return; }
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.copyFileSync(sourceFile, targetAbs);
}

/**
 * Prompt section listing the files a step should read, or '' when it has none.
 * `epicDirRel` is the epic folder relative to the workspace root.
 */
export function attachmentsPromptSection(epicDirRel: string, files: Attachment[]): string {
  if (files.length === 0) { return ''; }
  const base = epicDirRel.replace(/\\/g, '/').replace(/\/$/, '');
  const lines = files.map((f) => `- \`${base}/${f.path}\``);
  return [
    '## Attached documents',
    '',
    'The user attached these files to the epic or to this step. Read them before you start; they take precedence over assumptions:',
    '',
    ...lines,
  ].join('\n');
}
