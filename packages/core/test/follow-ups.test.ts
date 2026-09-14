/**
 * Follow-up manifests — a finished epic handing its work forward.
 *
 * Holds the contract (`followups.json`), the child id, and the edge back to the
 * parent: a child must start with its intent written and `from_epic` pointing
 * home, or the epic list cannot draw the family and the human gate at stage 1
 * reviews a blank page.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseFollowUps,
  FollowUpsParseError,
  followUpChildId,
  followUpsOf,
  openManifestFollowUp,
  openFollowUpEpic,
  readEpicFollowUps,
  FOLLOW_UPS_FILE,
  type PipelineConfig,
} from '../src';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-followups-'));
}

const PIPELINE: PipelineConfig = {
  id: 'native-full-child',
  on_failure: 'stop',
  steps: [
    { agent: 'aidlc-native-originator', name: 'intent', requires: [], produces: ['intent.md'], depends_on: [], human_review: true, auto_review: false, enabled: true },
    { agent: 'aidlc-native-product-owner', name: 'spec', requires: ['intent.md'], produces: ['spec.md'], depends_on: ['intent'], human_review: true, auto_review: false, enabled: true },
  ],
};

const MANIFEST = {
  version: 1,
  items: [
    { key: 'E-B', title: 'Port call order per voyage', recipe: 'native-full', intent: '# Intent\n\nPort order.' },
    { key: 'E-A', title: 'Rule resolver', intent: '# Intent\n\nResolver.', blockedBy: 'ADR for R-31', dependsOn: ['E-B'] },
  ],
};

describe('parseFollowUps', () => {
  it('accepts a manifest and fills the defaults', () => {
    const m = parseFollowUps(JSON.stringify(MANIFEST));
    expect(m.items).toHaveLength(2);
    expect(m.items[0].dependsOn).toEqual([]);
    expect(m.items[0].inputs).toEqual({});
    expect(m.items[1].blockedBy).toBe('ADR for R-31');
  });

  it('lists every problem at once', () => {
    const bad = { items: [{ key: 'has space', title: '', intent: 'x' }, { key: 'ok', title: 't', intent: 'x' }, { key: 'OK', title: 't', intent: 'x' }] };
    let msg = '';
    try { parseFollowUps(bad); } catch (err) {
      expect(err).toBeInstanceOf(FollowUpsParseError);
      msg = (err as Error).message;
    }
    expect(msg).toContain('items.0.key');
    expect(msg).toContain('items.0.title');
    expect(msg).toContain('duplicate key "OK"');
  });

  it('rejects non-JSON and empty manifests', () => {
    expect(() => parseFollowUps('{nope')).toThrow(FollowUpsParseError);
    expect(() => parseFollowUps({ items: [] })).toThrow(/at least one item/);
  });
});

describe('followUpChildId', () => {
  it('suffixes the parent with the key, and counts up when taken', () => {
    expect(followUpChildId('SNP-STOS-001', 'E-A')).toBe('SNP-STOS-001-E-A');
    expect(followUpChildId('SNP-STOS-001', 'w2')).toBe('SNP-STOS-001-W2');
    expect(followUpChildId('P', 'E-A', ['P-E-A'])).toBe('P-E-A-2');
  });
});

describe('openManifestFollowUp', () => {
  it('seeds the intent and records the edge back to the parent', () => {
    const root = tmpRoot();
    const item = parseFollowUps(MANIFEST).items[0];
    const res = openManifestFollowUp({
      workspaceRoot: root, doc: null, parentEpicId: 'SNP-STOS-001',
      item: { ...item, inputs: { from_epic: 'spoofed', topic: 'stowage' } },
      pipeline: PIPELINE,
    });

    expect(res.epicId).toBe('SNP-STOS-001-E-B');
    expect(fs.readFileSync(res.intentPath, 'utf8')).toBe('# Intent\n\nPort order.\n');
    const inputs = JSON.parse(fs.readFileSync(path.join(res.epicDir, 'inputs.json'), 'utf8'));
    expect(inputs).toMatchObject({ from_epic: 'SNP-STOS-001', follow_up_key: 'E-B', topic: 'stowage' });
  });

  it('opens a second child for the same key beside the first, not over it', () => {
    const root = tmpRoot();
    const item = parseFollowUps(MANIFEST).items[0];
    openManifestFollowUp({ workspaceRoot: root, doc: null, parentEpicId: 'P', item, pipeline: PIPELINE });
    const again = openManifestFollowUp({ workspaceRoot: root, doc: null, parentEpicId: 'P', item, pipeline: PIPELINE });
    expect(again.epicId).toBe('P-E-B-2');
  });
});

describe('followUpsOf', () => {
  it('finds manifest children and incident follow-ups by from_epic alone', () => {
    const root = tmpRoot();
    const item = parseFollowUps(MANIFEST).items[0];
    openManifestFollowUp({ workspaceRoot: root, doc: null, parentEpicId: 'P', item, pipeline: PIPELINE });
    openFollowUpEpic({
      workspaceRoot: root, doc: null, pipeline: PIPELINE, fromEpicId: 'P', epicId: 'P-FIX',
      signal: { source: 'manual', observedAt: '2026-09-14', symptom: 's', scope: 'x', evidence: '' },
    });
    openManifestFollowUp({ workspaceRoot: root, doc: null, parentEpicId: 'OTHER', item, pipeline: PIPELINE });

    const found = followUpsOf(root, null, 'P').sort((a, b) => a.epicId.localeCompare(b.epicId));
    expect(found).toEqual([{ epicId: 'P-E-B', key: 'E-B' }, { epicId: 'P-FIX' }]);
  });

  it('returns nothing when there is no epics folder yet', () => {
    expect(followUpsOf(tmpRoot(), null, 'P')).toEqual([]);
  });
});

describe('readEpicFollowUps', () => {
  it('reads the manifest from the epic folder, or null', () => {
    const root = tmpRoot();
    expect(readEpicFollowUps(root, null, 'P')).toBeNull();
    const dir = path.join(root, 'docs', 'epics', 'P');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FOLLOW_UPS_FILE), JSON.stringify(MANIFEST));
    expect(parseFollowUps(readEpicFollowUps(root, null, 'P')!).items).toHaveLength(2);
  });
});
