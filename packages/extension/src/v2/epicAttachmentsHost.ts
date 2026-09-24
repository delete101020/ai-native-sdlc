/**
 * Host side of epic attachments: the file dialogs and confirmations around the
 * pure `@aidlc/core` operations. See `core/src/epics/EpicAttachments.ts` for
 * what the two scopes mean and who reads them.
 *
 * Each function returns true when it changed something on disk, which tells
 * the caller to refresh the panel. The files land outside the watched globs,
 * so nothing else would.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  addEpicInput,
  attachStepFile,
  attachmentsForStep,
  epicsRoot,
  placeStepOutput,
  readEpicAttachments,
  removeAttachment,
  RunStateStore,
  type Attachment,
} from '@aidlc/core';
import { readYaml } from './yamlIO';

/** One attachment as the panel shows it. */
export interface AttachmentUi {
  /** Absolute path, sent back as `path` to open the file. */
  path: string;
  /** Path relative to the epic folder: the manifest key, used to remove it. */
  relPath: string;
  /** File name in the epic folder (may carry a `-2` suffix). */
  label: string;
  addedAt: string;
  exists: boolean;
}

export interface EpicAttachmentsUi {
  epic: AttachmentUi[];
  steps: Record<string, AttachmentUi[]>;
}

function toUi(epicDir: string, a: Attachment): AttachmentUi {
  const abs = path.resolve(epicDir, a.path);
  return {
    path: abs,
    relPath: a.path,
    label: path.basename(a.path),
    addedAt: a.addedAt,
    exists: fs.existsSync(abs),
  };
}

export function readAttachmentsUi(epicDir: string): EpicAttachmentsUi {
  const att = readEpicAttachments(epicDir);
  const steps: Record<string, AttachmentUi[]> = {};
  for (const [step, list] of Object.entries(att.steps)) {
    steps[step] = list.map((a) => toUi(epicDir, a));
  }
  return { epic: att.epic.map((a) => toUi(epicDir, a)), steps };
}

async function pickFiles(openLabel: string, many: boolean): Promise<string[]> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: many,
    openLabel,
  });
  return (picked ?? []).map((u) => u.fsPath);
}

function isEpicDir(epicDir: string): boolean {
  return epicDir !== '' && fs.existsSync(path.join(epicDir, 'state.json'));
}

/** Pick documents and copy them into the epic's `inputs/`. */
export async function addEpicInputsInteractive(epicDir: string): Promise<boolean> {
  if (!isEpicDir(epicDir)) { return false; }
  const files = await pickFiles('Add as epic input', true);
  for (const f of files) { addEpicInput(epicDir, f); }
  if (files.length > 0) {
    void vscode.window.showInformationMessage(
      `Added ${files.length} input document${files.length === 1 ? '' : 's'} — every step of this epic will read ${files.length === 1 ? 'it' : 'them'}.`,
    );
  }
  return files.length > 0;
}

/** Pick documents and attach them to one step. */
export async function attachStepFilesInteractive(epicDir: string, stepName: string): Promise<boolean> {
  if (!isEpicDir(epicDir) || !stepName) { return false; }
  const files = await pickFiles(`Attach to ${stepName}`, true);
  for (const f of files) { attachStepFile(epicDir, stepName, f); }
  if (files.length > 0) {
    void vscode.window.showInformationMessage(
      `Attached ${files.length} file${files.length === 1 ? '' : 's'} to ${stepName}.`,
    );
  }
  return files.length > 0;
}

/**
 * Pick a file produced elsewhere and write it to the step's declared output
 * path. Confirms before overwriting. Marking the step done is left to the
 * person, so the usual `produces` checks still run.
 */
export async function useFileAsStepOutputInteractive(targetAbs: string, label: string): Promise<boolean> {
  const [file] = await pickFiles(`Use as ${label}`, false);
  if (!file) { return false; }
  if (fs.existsSync(targetAbs)) {
    const ok = await vscode.window.showWarningMessage(
      `Replace ${label} with ${path.basename(file)}?`,
      { modal: true, detail: `The current file at ${targetAbs} will be overwritten.` },
      'Replace',
    );
    if (ok !== 'Replace') { return false; }
  }
  placeStepOutput(file, targetAbs);
  void vscode.window.showInformationMessage(
    `${label} is in place. Click "Mark step done" when you are ready to advance.`,
  );
  return true;
}

/**
 * Tail for the interactive "Run with Claude" prompt, naming the files this
 * step should read, or '' when it has none. The command files say the same,
 * but `ensureCommandFiles` never rewrites an existing one, so a workspace set
 * up by an older build would not know about attachments without this.
 */
export function attachmentsPromptSuffix(root: string, runId: string, stepIdx: number | null): string {
  try {
    const epicDir = path.join(epicsRoot(root, readYaml(root)), runId);
    const rec = stepIdx === null ? undefined : RunStateStore.load(root, runId)?.steps[stepIdx];
    const files = attachmentsForStep(readEpicAttachments(epicDir), rec ? (rec.name ?? rec.agent) : '');
    if (files.length === 0) { return ''; }
    const rel = path.relative(root, epicDir).replace(/\\/g, '/');
    return ` — Also read these attached documents first: ${files.map((f) => `${rel}/${f.path}`).join(', ')}`;
  } catch {
    return '';
  }
}

/** Confirm, then drop an attachment and delete its copy. */
export async function removeAttachmentInteractive(epicDir: string, relPath: string): Promise<boolean> {
  if (!isEpicDir(epicDir) || !relPath) { return false; }
  const ok = await vscode.window.showWarningMessage(
    `Remove ${path.basename(relPath)} from this epic?`,
    { modal: true, detail: 'The copy in the epic folder is deleted. The original file is not touched.' },
    'Remove',
  );
  if (ok !== 'Remove') { return false; }
  return removeAttachment(epicDir, relPath);
}
