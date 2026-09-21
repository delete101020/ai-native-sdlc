import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  applyTagEdit,
  epicMatchesTags,
  normalizeTag,
  normalizeTags,
  readEpicTags,
  scaffoldEpic,
  type PipelineConfig,
} from '../src';

const PIPELINE: PipelineConfig = {
  id: 'p',
  on_failure: 'stop',
  steps: [
    { agent: 'po', name: 'plan', requires: [], produces: ['PRD.md'], depends_on: [], human_review: true, auto_review: false, enabled: true },
  ],
};

describe('normalizeTag — free text in, one canonical form out', () => {
  it('uppercases and kebabs', () => {
    expect(normalizeTag('payment gateway')).toBe('PAYMENT-GATEWAY');
    expect(normalizeTag('  Payment  ')).toBe('PAYMENT');
    expect(normalizeTag('PAYMENT')).toBe('PAYMENT');
  });

  it('folds Vietnamese diacritics so one tag is one bucket', () => {
    expect(normalizeTag('thanh toán VNPay')).toBe('THANH-TOAN-VNPAY');
    expect(normalizeTag('Đợt 2')).toBe('DOT-2');
    // The whole point: two spellings of the same word land on one key.
    expect(normalizeTag('thanh toán')).toBe(normalizeTag('THANH TOAN'));
  });

  it('keeps underscores, collapses every other separator run', () => {
    expect(normalizeTag('tech_debt')).toBe('TECH_DEBT');
    expect(normalizeTag('payment // gateway')).toBe('PAYMENT-GATEWAY');
    expect(normalizeTag('--release--q3--')).toBe('RELEASE-Q3');
  });

  it('returns empty when nothing filterable survives', () => {
    expect(normalizeTag('   ')).toBe('');
    expect(normalizeTag('---')).toBe('');
    expect(normalizeTag('。。')).toBe('');
    expect(normalizeTag(42 as unknown as string)).toBe('');
  });

  it('caps length without leaving a trailing separator', () => {
    const long = normalizeTag('a'.repeat(60));
    expect(long).toHaveLength(48);
    expect(normalizeTag('a'.repeat(47) + ' bcd')).toBe('A'.repeat(47));
  });
});

describe('normalizeTags — the stored set', () => {
  it('drops empties, deduplicates after folding, and sorts', () => {
    expect(normalizeTags(['Payment', 'payment', '  ', 'thanh toán']))
      .toEqual(['PAYMENT', 'THANH-TOAN']);
  });

  it('accepts a comma/newline separated string', () => {
    expect(normalizeTags('payment, release q3\ntech debt'))
      .toEqual(['PAYMENT', 'RELEASE-Q3', 'TECH-DEBT']);
  });

  it('is total on junk', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(7)).toEqual([]);
    expect(normalizeTags([null, 3, 'ok'])).toEqual(['OK']);
  });
});

describe('readEpicTags — tolerant of what is actually on disk', () => {
  it('reads and folds the key', () => {
    expect(readEpicTags({ tags: ['payment'] })).toEqual(['PAYMENT']);
  });
  it('treats an epic scaffolded before tags existed as untagged', () => {
    expect(readEpicTags({})).toEqual([]);
    expect(readEpicTags(null)).toEqual([]);
    expect(readEpicTags({ tags: 'hand edited' })).toEqual(['HAND-EDITED']);
    expect(readEpicTags({ tags: { nope: true } })).toEqual([]);
  });
});

describe('epicMatchesTags — AND, on canonical forms', () => {
  const epic = ['PAYMENT', 'RELEASE-Q3'];

  it('matches everything when the filter is empty', () => {
    expect(epicMatchesTags(epic, [])).toBe(true);
    expect(epicMatchesTags([], [])).toBe(true);
  });

  it('requires every wanted tag', () => {
    expect(epicMatchesTags(epic, ['PAYMENT'])).toBe(true);
    expect(epicMatchesTags(epic, ['PAYMENT', 'RELEASE-Q3'])).toBe(true);
    expect(epicMatchesTags(epic, ['PAYMENT', 'BILLING'])).toBe(false);
  });

  it('folds the filter too, so it can be typed however', () => {
    expect(epicMatchesTags(['THANH-TOAN'], ['thanh toán'])).toBe(true);
    expect(epicMatchesTags(epic, 'release q3')).toBe(true);
  });
});

describe('applyTagEdit', () => {
  it('adds, removes and sorts', () => {
    expect(applyTagEdit(['PAYMENT'], { add: ['release q3'] })).toEqual(['PAYMENT', 'RELEASE-Q3']);
    expect(applyTagEdit(['PAYMENT', 'BILLING'], { remove: ['billing'] })).toEqual(['PAYMENT']);
  });

  it('set replaces, and applies add/remove on top of the replacement', () => {
    expect(applyTagEdit(['PAYMENT'], { set: ['billing'] })).toEqual(['BILLING']);
    expect(applyTagEdit(['PAYMENT'], { set: [], add: ['x'] })).toEqual(['X']);
  });

  it('is a no-op when nothing is passed', () => {
    expect(applyTagEdit(['PAYMENT'], {})).toEqual(['PAYMENT']);
  });
});

describe('scaffoldEpic — tags reach state.json canonically', () => {
  it('writes the folded tags', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-tags-'));
    scaffoldEpic({
      workspaceRoot: root,
      doc: null,
      epicId: 'CPD-1',
      title: 't',
      description: 'd',
      target: { kind: 'pipeline', id: 'p' },
      agents: ['po'],
      inputs: {},
      pipeline: PIPELINE,
      tags: ['thanh toán VNPay', 'Payment', 'payment'],
    });
    const state = JSON.parse(
      fs.readFileSync(path.join(root, 'docs/epics/CPD-1/state.json'), 'utf8'),
    );
    expect(state.tags).toEqual(['PAYMENT', 'THANH-TOAN-VNPAY']);
  });

  it('writes an empty array when no tags were given, so the key is there to fill in', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-tags-'));
    scaffoldEpic({
      workspaceRoot: root,
      doc: null,
      epicId: 'CPD-2',
      title: '',
      description: '',
      target: { kind: 'pipeline', id: 'p' },
      agents: ['po'],
      inputs: {},
      pipeline: PIPELINE,
    });
    const state = JSON.parse(
      fs.readFileSync(path.join(root, 'docs/epics/CPD-2/state.json'), 'utf8'),
    );
    expect(state.tags).toEqual([]);
  });
});
