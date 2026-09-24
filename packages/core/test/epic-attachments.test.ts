/**
 * Attachments — documents a person adds to an epic by hand.
 *
 * Epic inputs reach every step and a step attachment reaches only its own
 * step. Removing an entry must never delete an artifact, however the manifest
 * was edited.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  addEpicInput,
  attachStepFile,
  attachmentsForStep,
  attachmentsPromptSection,
  placeStepOutput,
  readEpicAttachments,
  removeAttachment,
  stepFolderName,
  ATTACHMENTS_FILE,
} from '../src';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sourceFile(name: string, body = 'content'): string {
  const file = path.join(tmp('aidlc-att-src-'), name);
  fs.writeFileSync(file, body);
  return file;
}

describe('epic attachments', () => {
  it('reads an absent or broken manifest as empty', () => {
    const epicDir = tmp('aidlc-att-');
    expect(readEpicAttachments(epicDir)).toEqual({ epic: [], steps: {} });
    fs.writeFileSync(path.join(epicDir, ATTACHMENTS_FILE), '{nope');
    expect(readEpicAttachments(epicDir)).toEqual({ epic: [], steps: {} });
  });

  it('copies an epic input into inputs/ and records it', () => {
    const epicDir = tmp('aidlc-att-');
    const src = sourceFile('brd.md', 'requirements');
    const entry = addEpicInput(epicDir, src, new Date('2026-09-24T00:00:00Z'));
    expect(entry).toEqual({ path: 'inputs/brd.md', name: 'brd.md', addedAt: '2026-09-24T00:00:00.000Z' });
    expect(fs.readFileSync(path.join(epicDir, 'inputs', 'brd.md'), 'utf8')).toBe('requirements');
    expect(readEpicAttachments(epicDir).epic).toEqual([entry]);
  });

  it('never overwrites an earlier copy with the same name', () => {
    const epicDir = tmp('aidlc-att-');
    addEpicInput(epicDir, sourceFile('brd.md', 'one'));
    const second = addEpicInput(epicDir, sourceFile('brd.md', 'two'));
    expect(second.path).toBe('inputs/brd-2.md');
    expect(fs.readFileSync(path.join(epicDir, 'inputs', 'brd.md'), 'utf8')).toBe('one');
  });

  it('scopes a step attachment to its own step', () => {
    const epicDir = tmp('aidlc-att-');
    const input = addEpicInput(epicDir, sourceFile('brd.md'));
    const spec = attachStepFile(epicDir, 'spec', sourceFile('external-spec.md'));
    expect(spec.path).toBe('attachments/spec/external-spec.md');

    const att = readEpicAttachments(epicDir);
    expect(attachmentsForStep(att, 'spec')).toEqual([input, spec]);
    expect(attachmentsForStep(att, 'implement')).toEqual([input]);
  });

  it('makes a step name safe as a folder name', () => {
    expect(stepFolderName('review/qa step')).toBe('review-qa-step');
    expect(stepFolderName('..')).toBe('step');
  });

  it('removes an entry and deletes its copy', () => {
    const epicDir = tmp('aidlc-att-');
    const spec = attachStepFile(epicDir, 'spec', sourceFile('x.md'));
    expect(removeAttachment(epicDir, spec.path)).toBe(true);
    expect(fs.existsSync(path.join(epicDir, spec.path))).toBe(false);
    expect(readEpicAttachments(epicDir).steps).toEqual({});
    expect(removeAttachment(epicDir, spec.path)).toBe(false);
  });

  it('never deletes a file outside inputs/ and attachments/', () => {
    const epicDir = tmp('aidlc-att-');
    fs.mkdirSync(path.join(epicDir, 'artifacts'));
    const artifact = path.join(epicDir, 'artifacts', 'spec.md');
    fs.writeFileSync(artifact, 'agent output');
    fs.writeFileSync(path.join(epicDir, ATTACHMENTS_FILE), JSON.stringify({
      epic: [{ path: 'artifacts/spec.md', name: 'spec.md', addedAt: '' }],
      steps: {},
    }));
    expect(removeAttachment(epicDir, 'artifacts/spec.md')).toBe(true);
    expect(fs.existsSync(artifact)).toBe(true);
  });

  it('places an external file at the step output path', () => {
    const target = path.join(tmp('aidlc-att-'), 'artifacts', 'spec.md');
    placeStepOutput(sourceFile('mine.md', 'external'), target);
    expect(fs.readFileSync(target, 'utf8')).toBe('external');
  });

  it('lists the files in the prompt section, or nothing', () => {
    expect(attachmentsPromptSection('docs/epics/E1', [])).toBe('');
    const section = attachmentsPromptSection('docs\\epics\\E1', [
      { path: 'inputs/brd.md', name: 'brd.md', addedAt: '' },
    ]);
    expect(section).toContain('## Attached documents');
    expect(section).toContain('- `docs/epics/E1/inputs/brd.md`');
  });
});
