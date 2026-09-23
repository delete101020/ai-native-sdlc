/**
 * The Epics list can be ordered five ways. Every order breaks ties the way the
 * host's own list does (newest created, then id), so "Created" is exactly the
 * list the panel started with, and "My epics" never lets `reversed` put other
 * people's work on top.
 */
import { describe, expect, it } from 'vitest';

import type { EpicSummary, EpicStepDetailFull } from '../src/webview/lib/types';
import { attentionRank, isOwnEpic, lastActivity, sortEpics } from '../src/webview/lib/epicSort';

function step(over: Partial<EpicStepDetailFull> = {}): EpicStepDetailFull {
  return {
    agent: 'a', status: 'pending', runStatus: null, isCurrentRunStep: false,
    stepHasAutoReview: false, stepHasHumanReview: false,
    ...over,
  } as EpicStepDetailFull;
}

function epic(id: string, over: Partial<EpicSummary> = {}): EpicSummary {
  return {
    id, title: id, description: '', status: 'pending', progress: 0, statePath: '',
    stepDetails: [], currentStep: 0, pipeline: null, agent: null, runId: null,
    inputs: {}, epicDir: '', existingArtifacts: [], createdAt: '2026-09-01T00:00:00Z',
    strictMode: true,
    ...over,
  } as EpicSummary;
}

const ids = (list: EpicSummary[]) => list.map((e) => e.id);

describe('sortEpics', () => {
  const a = epic('A', { createdAt: '2026-09-01T00:00:00Z', title: 'Zeta' });
  const b = epic('B', { createdAt: '2026-09-03T00:00:00Z', title: 'alpha' });
  const c = epic('C', { createdAt: '2026-09-02T00:00:00Z', title: 'Beta 10' });

  it('Created: newest first, reversible', () => {
    expect(ids(sortEpics([a, b, c], 'created', false, null))).toEqual(['B', 'C', 'A']);
    expect(ids(sortEpics([a, b, c], 'created', true, null))).toEqual(['A', 'C', 'B']);
  });

  it('Name: case-insensitive, natural', () => {
    const c2 = epic('D', { title: 'Beta 2' });
    expect(ids(sortEpics([a, b, c, c2], 'name', false, null))).toEqual(['B', 'D', 'C', 'A']);
  });

  it('does not mutate the input', () => {
    const input = [a, b, c];
    sortEpics(input, 'created', false, null);
    expect(ids(input)).toEqual(['A', 'B', 'C']);
  });

  it('Last activity: latest step event wins over creation date', () => {
    const touched = epic('OLD', {
      createdAt: '2026-08-01T00:00:00Z',
      stepDetails: [step({ startedAt: '2026-09-10T00:00:00Z', history: [{ kind: 'approve', at: '2026-09-12T00:00:00Z', revision: 1 }] })],
    });
    expect(lastActivity(touched)).toBe(Date.parse('2026-09-12T00:00:00Z'));
    expect(ids(sortEpics([a, b, touched], 'activity', false, null))).toEqual(['OLD', 'B', 'A']);
  });

  it('Needs attention: human gate, failed, stale, running, pending, done', () => {
    const gate = epic('GATE', { status: 'in_progress', stepDetails: [step({ runStatus: 'awaiting_review' })] });
    const failed = epic('FAIL', { status: 'failed' });
    const stale = epic('STALE', { status: 'in_progress', stepDetails: [step({ dirtyUpstream: [{ stepIdx: 0, step: 'x', byStep: 'y' }] })] });
    const running = epic('RUN', { status: 'in_progress' });
    const pending = epic('PEND', { status: 'pending' });
    const done = epic('DONE', { status: 'done' });
    expect([gate, failed, stale, running, pending, done].map(attentionRank)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ids(sortEpics([done, pending, running, stale, failed, gate], 'attention', false, null)))
      .toEqual(['GATE', 'FAIL', 'STALE', 'RUN', 'PEND', 'DONE']);
  });

  it('My epics: own ids first by id desc; reversing never lifts others above', () => {
    const mine1 = epic('EPIC-260901-NG-001', { createdAt: '2026-09-01T00:00:00Z' });
    const mine2 = epic('EPIC-260905-NG-002', { createdAt: '2026-09-05T00:00:00Z' });
    const theirs = epic('EPIC-260910-KD-001', { createdAt: '2026-09-10T00:00:00Z' });
    const legacy = epic('EPIC-007', { createdAt: '2026-09-09T00:00:00Z' });
    expect(ids(sortEpics([mine1, theirs, legacy, mine2], 'mine', false, 'NG')))
      .toEqual(['EPIC-260905-NG-002', 'EPIC-260901-NG-001', 'EPIC-260910-KD-001', 'EPIC-007']);
    expect(ids(sortEpics([mine1, theirs, legacy, mine2], 'mine', true, 'NG')))
      .toEqual(['EPIC-260901-NG-001', 'EPIC-260905-NG-002', 'EPIC-007', 'EPIC-260910-KD-001']);
  });
});

describe('isOwnEpic', () => {
  it('matches the dated, hand-written and follow-up shapes, case-insensitively', () => {
    expect(isOwnEpic('EPIC-260908-NG-001', 'NG')).toBe(true);
    expect(isOwnEpic('epic-260908-ng-001', 'NG')).toBe(true);
    expect(isOwnEpic('EPIC-NG-003', 'NG')).toBe(true);
    expect(isOwnEpic('EPIC-260908-NG-001-W2', 'NG')).toBe(true);
  });

  it('does not match other people, bare numbers, or no prefix', () => {
    expect(isOwnEpic('EPIC-260908-KD-001', 'NG')).toBe(false);
    expect(isOwnEpic('EPIC-001', 'NG')).toBe(false);
    expect(isOwnEpic('EPIC-260908-NG-001', null)).toBe(false);
  });
});
