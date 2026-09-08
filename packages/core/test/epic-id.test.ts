import { describe, it, expect } from 'vitest';
import {
  EPIC_ID_PREFIX_PATTERN,
  epicIdDateStamp,
  resolveEpicIdPrefix,
  suggestEpicId,
} from '../src/loader/epicId';

describe('resolveEpicIdPrefix', () => {
  it('accepts exactly two letters and upper-cases them', () => {
    expect(resolveEpicIdPrefix({ epic_id_prefix: 'NG' })).toBe('NG');
    expect(resolveEpicIdPrefix({ epic_id_prefix: 'ng' })).toBe('NG');
    expect(resolveEpicIdPrefix({ epic_id_prefix: '  kf  ' })).toBe('KF');
  });

  it('degrades anything else to no prefix rather than throwing', () => {
    // A bad value in workspace.yaml must not be able to stop someone starting
    // an epic — it costs them the prefix, not the command.
    expect(resolveEpicIdPrefix({ epic_id_prefix: 'N' })).toBeNull();
    expect(resolveEpicIdPrefix({ epic_id_prefix: 'NGO' })).toBeNull();
    expect(resolveEpicIdPrefix({ epic_id_prefix: 'N1' })).toBeNull();
    expect(resolveEpicIdPrefix({ epic_id_prefix: '' })).toBeNull();
    expect(resolveEpicIdPrefix({ epic_id_prefix: 42 })).toBeNull();
    expect(resolveEpicIdPrefix({})).toBeNull();
    expect(resolveEpicIdPrefix(null)).toBeNull();
    expect(resolveEpicIdPrefix(undefined)).toBeNull();
  });

  it('exports the pattern the UI validates against', () => {
    expect(EPIC_ID_PREFIX_PATTERN.test('NG')).toBe(true);
    expect(EPIC_ID_PREFIX_PATTERN.test('ng')).toBe(false);
  });
});

describe('epicIdDateStamp', () => {
  it('is yymmdd', () => {
    expect(epicIdDateStamp(new Date(2026, 8, 8, 12, 0, 0))).toBe('260908');
    expect(epicIdDateStamp(new Date(2026, 0, 1, 12, 0, 0))).toBe('260101');
    expect(epicIdDateStamp(new Date(2026, 11, 31, 12, 0, 0))).toBe('261231');
  });

  it('reads the local calendar date, not UTC', () => {
    // 01:30 local on the 8th. Slicing toISOString() in any timezone east of
    // UTC would stamp this the 7th — a whole working morning of epics filed
    // under yesterday. The Date is constructed from local parts, so whatever
    // timezone the test host is in, the stamp must agree with it.
    const early = new Date(2026, 8, 8, 1, 30, 0);
    expect(epicIdDateStamp(early)).toBe('260908');
    expect(epicIdDateStamp(early)).toBe(
      `${String(early.getFullYear() % 100)}${String(early.getMonth() + 1).padStart(2, '0')}${String(early.getDate()).padStart(2, '0')}`,
    );
  });
});

describe('suggestEpicId', () => {
  const day = new Date(2026, 8, 8, 9, 0, 0);

  it('keeps the old scheme byte for byte when no prefix is declared', () => {
    expect(suggestEpicId([], null, day)).toBe('EPIC-001');
    expect(suggestEpicId(['EPIC-001', 'EPIC-002'], null, day)).toBe('EPIC-003');
    expect(suggestEpicId(['EPIC-007', 'notes'], null, day)).toBe('EPIC-008');
  });

  it('puts the date first, then the prefix', () => {
    expect(suggestEpicId([], 'NG', day)).toBe('EPIC-260908-NG-001');
  });

  it('counts only ids from this prefix on this day', () => {
    const existing = [
      'EPIC-260908-NG-001',
      'EPIC-260908-NG-002',
      'EPIC-260908-KF-009',  // someone else's prefix
      'EPIC-260907-NG-005',  // ours, yesterday
      'EPIC-003',            // the old scheme
    ];
    expect(suggestEpicId(existing, 'NG', day)).toBe('EPIC-260908-NG-003');
    expect(suggestEpicId(existing, 'KF', day)).toBe('EPIC-260908-KF-010');
  });

  it('restarts at 001 on a new day', () => {
    const existing = ['EPIC-260907-NG-001', 'EPIC-260907-NG-002'];
    expect(suggestEpicId(existing, 'NG', day)).toBe('EPIC-260908-NG-001');
  });

  it('never proposes an id that is already on disk', () => {
    // The bug this whole module exists for: a prefixed folder used to be
    // invisible to the scan, so the suggester kept offering a taken id.
    const existing = ['EPIC-260908-NG-001'];
    const next = suggestEpicId(existing, 'NG', day);
    expect(existing).not.toContain(next);
  });

  it('ignores case in existing folder names', () => {
    expect(suggestEpicId(['epic-260908-ng-004'], 'NG', day)).toBe('EPIC-260908-NG-005');
  });
});
