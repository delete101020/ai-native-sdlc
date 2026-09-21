/**
 * The tag field previews what the store will keep while the user is still
 * typing ("thanh toán vnpay" → THANH-TOAN-VNPAY), which means the webview
 * carries a copy of core's `normalizeTag`. A copy that drifts promises one
 * spelling and stores another, and the tag then sits in a bucket the filter
 * chip never points at.
 *
 * So the copy is asserted against the original — over the cases that made the
 * original what it is: case, accents, `đ`, separator runs, the length cap, and
 * the inputs that fold away to nothing.
 */
import { describe, expect, it } from 'vitest';

import { normalizeTag as coreNormalizeTag, normalizeTags as coreNormalizeTags } from '@aidlc/core';
import { normalizeTag, normalizeTags } from '../src/webview/lib/tags';

const CASES = [
  'payment',
  'Payment Gateway',
  '  spaced  out  ',
  'thanh toán VNPay',
  'Đợt 2',
  'tech_debt',
  'payment // gateway',
  '--release--q3--',
  'a'.repeat(60),
  'a'.repeat(47) + ' bcd',
  '---',
  '   ',
  '。。',
  'RELEASE-Q3',
];

describe('webview tag normalization mirrors core', () => {
  for (const input of CASES) {
    it(`agrees on ${JSON.stringify(input.length > 24 ? input.slice(0, 24) + '…' : input)}`, () => {
      expect(normalizeTag(input)).toBe(coreNormalizeTag(input));
    });
  }

  it('agrees on the set: folded, deduplicated, sorted', () => {
    const list = ['Payment', 'payment', 'thanh toán', '  ', 'release q3'];
    expect(normalizeTags(list)).toEqual(coreNormalizeTags(list));
    expect(normalizeTags(list)).toEqual(['PAYMENT', 'RELEASE-Q3', 'THANH-TOAN']);
  });

  it('agrees on a comma/newline separated string', () => {
    const typed = 'payment, release q3\ntech debt';
    expect(normalizeTags(typed)).toEqual(coreNormalizeTags(typed));
  });

  it('survives the empty cases the field hits on every keystroke', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags([])).toEqual([]);
    expect(normalizeTag('')).toBe('');
  });
});
