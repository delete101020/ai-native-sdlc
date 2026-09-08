/**
 * The Report-signal form shows the epic id it is about to create while the user
 * is still typing the symptom, which means the webview carries a copy of core's
 * `followUpEpicId`. A copy that drifts is worse than no preview at all: the
 * field promises one id and the host writes another, and the user only finds
 * out after the epic exists under a name they did not expect.
 *
 * So the copy is asserted against the original — including the cases that made
 * the original what it is: punctuation collapses, the slug is capped at five
 * words and 24 characters, and a trailing dash left by that cut is trimmed.
 */
import { describe, expect, it } from 'vitest';

import { followUpEpicId } from '@aidlc/core';
import { previewIncidentEpicId } from '../src/webview/lib/incidentId';

const SYMPTOMS = [
  'Checkout returns 500 for repeat customers',
  'complete-yard-job is slow',
  'PUT /v1/so/che/complete-yard-job/:id — p95 over 500ms',
  '  spaces   everywhere  ',
  'One',
  'a b c d e f g h',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  '!!! ??? ***',
  'Ký tự tiếng Việt trong symptom',
];

describe('previewIncidentEpicId', () => {
  it('matches core for every shape of symptom', () => {
    for (const symptom of SYMPTOMS) {
      const signal = {
        source: 'manual',
        observedAt: '2026-09-08T00:00:00.000Z',
        symptom,
        scope: 'test',
        evidence: '',
      };
      expect(previewIncidentEpicId(symptom)).toBe(followUpEpicId(signal));
    }
  });

  it('falls back to the bare prefix when the symptom has no usable characters', () => {
    // Not a hypothetical: the field is previewed on every keystroke, so it is
    // rendered long before the symptom is a sentence.
    expect(previewIncidentEpicId('')).toBe('INC');
    expect(previewIncidentEpicId('!!!')).toBe('INC');
  });

  it('honours a custom prefix the same way core does', () => {
    const signal = {
      source: 'manual',
      observedAt: '2026-09-08T00:00:00.000Z',
      symptom: 'Checkout returns 500',
      scope: 'test',
      evidence: '',
    };
    expect(previewIncidentEpicId(signal.symptom, 'OPS'))
      .toBe(followUpEpicId(signal, { prefix: 'OPS' }));
  });
});
