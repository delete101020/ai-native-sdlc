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
  followUpDefaults,
  nextManualFollowUpKey,
  withFollowUpProvenance,
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

describe('nextManualFollowUpKey', () => {
  it('takes the first free F<n>, ignoring case and manifest keys', () => {
    expect(nextManualFollowUpKey([])).toBe('F1');
    expect(nextManualFollowUpKey(['f1', 'E-A', 'F3'])).toBe('F2');
  });
});

describe('withFollowUpProvenance', () => {
  it('writes the edge last, over anything the caller passed', () => {
    expect(withFollowUpProvenance({ a: '1', from_epic: 'X' }, 'P', 'F1'))
      .toEqual({ a: '1', from_epic: 'P', follow_up_key: 'F1' });
  });
});

describe('followUpDefaults', () => {
  function parent(root: string, pipelineYaml?: string, state: Record<string, unknown> = {}): void {
    const dir = path.join(root, 'docs', 'epics', 'CR-Y01');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      id: 'CR-Y01', title: 'Cắt seal', pipeline: 'CR-Y01', tags: ['SPRINT-10', 'team 2'], ...state,
    }));
    if (pipelineYaml) { fs.writeFileSync(path.join(dir, 'pipeline.yaml'), pipelineYaml); }
  }
  const OWN = 'id: CR-Y01\nderived_from: cr-squad\nsteps:\n  - agent: cr-ba\n    name: cr-intake\n  - agent: cr-dev\n    name: cr-build\n';
  const DOC = {
    pipelines: [{ id: 'cr-squad', steps: [] }],
    recipes: [
      { id: 'cr-full', from: 'cr-squad', steps: ['cr-intake', 'cr-solo-ba', 'cr-build'] },
      { id: 'cr-small', from: 'cr-squad', steps: ['cr-intake', 'cr-build'] },
      { id: 'cr-internal', from: 'cr-squad', steps: ['cr-intake', 'cr-build'] },
    ],
  };

  it('keys the child F1, inherits tags, and traces the parent back to its recipe', () => {
    const root = tmpRoot();
    parent(root, OWN);
    expect(followUpDefaults(root, DOC, 'CR-Y01')).toEqual({
      parentEpicId: 'CR-Y01',
      parentTitle: 'Cắt seal',
      key: 'F1',
      epicId: 'CR-Y01-F1',
      tags: ['SPRINT-10', 'TEAM-2'],
      target: { kind: 'recipe', id: 'cr-small' },
    });
  });

  it('falls back to the source pipeline when no recipe has the same steps', () => {
    const root = tmpRoot();
    parent(root, OWN);
    const d = followUpDefaults(root, { ...DOC, recipes: [] }, 'CR-Y01');
    expect(d.target).toEqual({ kind: 'pipeline', id: 'cr-squad' });
  });

  it('offers a shared pipeline as-is, and no target when nothing is known', () => {
    const root = tmpRoot();
    parent(root, undefined, { pipeline: 'shared' });
    expect(followUpDefaults(root, { pipelines: [{ id: 'shared', steps: [] }] }, 'CR-Y01').target)
      .toEqual({ kind: 'pipeline', id: 'shared' });
    expect(followUpDefaults(root, null, 'CR-Y01').target).toBeUndefined();
  });

  it('counts past follow-ups already opened, and folders already taken', () => {
    const root = tmpRoot();
    parent(root, OWN);
    const item = { ...parseFollowUps(MANIFEST).items[0], key: 'F1' };
    openManifestFollowUp({ workspaceRoot: root, doc: null, parentEpicId: 'CR-Y01', item, pipeline: PIPELINE });
    fs.mkdirSync(path.join(root, 'docs', 'epics', 'CR-Y01-F2'));
    const d = followUpDefaults(root, DOC, 'CR-Y01');
    expect(d.key).toBe('F2');
    expect(d.epicId).toBe('CR-Y01-F2-2');
  });

  it('refuses a parent that is not an epic', () => {
    expect(() => followUpDefaults(tmpRoot(), null, 'NOPE')).toThrow(/not found/);
  });
});
