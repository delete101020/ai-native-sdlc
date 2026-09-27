import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  RECENT_EPICS_LIMIT,
  epicFocusFrom,
  epicIdFromBranch,
  epicSortFrom,
  pushRecent,
  readEpicFocus,
  readEpicSort,
  readUserConfig,
  recordEpicOpened,
  setActiveEpic,
  setEpicSort,
  setEpicWatched,
  userConfigPath,
  writeUserEpicIdPrefix,
} from '../src';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-focus-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('epicFocusFrom — whatever is in the file, a usable working set comes out', () => {
  it('is empty for no file', () => {
    expect(epicFocusFrom(null)).toEqual({ active: null, recent: [], watched: [] });
  });

  it('drops junk entries and duplicates', () => {
    expect(epicFocusFrom({
      active_epic: '  ',
      watched_epics: ['EPIC-1', 3, '', 'EPIC-1', 'EPIC-2'],
      recent_epics: 'EPIC-9',
      // From an earlier version; no longer read.
      pinned_epics: ['EPIC-5'],
    })).toEqual({ active: null, recent: [], watched: ['EPIC-1', 'EPIC-2'] });
  });
});

describe('pushRecent', () => {
  it('moves an id to the front without duplicating it', () => {
    expect(pushRecent(['A', 'B', 'C'], 'B')).toEqual(['B', 'A', 'C']);
  });

  it('keeps at most the limit', () => {
    const long = Array.from({ length: RECENT_EPICS_LIMIT }, (_, i) => `E${i}`);
    const next = pushRecent(long, 'NEW');
    expect(next).toHaveLength(RECENT_EPICS_LIMIT);
    expect(next[0]).toBe('NEW');
    expect(next).not.toContain(`E${RECENT_EPICS_LIMIT - 1}`);
  });
});

describe('writing the working set to .aidlc/user.yaml', () => {
  it('setActiveEpic sets, records as recent, and clears', () => {
    setActiveEpic(root, 'EPIC-012');
    expect(readEpicFocus(root)).toEqual({ active: 'EPIC-012', recent: ['EPIC-012'], watched: [] });

    setActiveEpic(root, null);
    expect(readEpicFocus(root)).toEqual({ active: null, recent: ['EPIC-012'], watched: [] });
  });

  it('recordEpicOpened keeps most recent first', () => {
    recordEpicOpened(root, 'EPIC-1');
    recordEpicOpened(root, 'EPIC-2');
    recordEpicOpened(root, 'EPIC-1');
    expect(readEpicFocus(root).recent).toEqual(['EPIC-1', 'EPIC-2']);
  });

  it('setEpicWatched keeps watch order, ignores repeats, and unwatches', () => {
    setEpicWatched(root, 'EPIC-2', true);
    setEpicWatched(root, 'EPIC-1', true);
    setEpicWatched(root, 'EPIC-2', true);
    expect(readEpicFocus(root).watched).toEqual(['EPIC-2', 'EPIC-1']);
    setEpicWatched(root, 'EPIC-3', false);
    setEpicWatched(root, 'EPIC-2', false);
    expect(readEpicFocus(root).watched).toEqual(['EPIC-1']);
    setEpicWatched(root, 'EPIC-1', false);
    expect(fs.existsSync(userConfigPath(root))).toBe(false);
  });

  it('never loses epic_id_prefix, and the prefix writer never loses the working set', () => {
    writeUserEpicIdPrefix(root, 'ng');
    setActiveEpic(root, 'EPIC-7');
    setEpicWatched(root, 'EPIC-7', true);
    expect(readUserConfig(root)?.epic_id_prefix).toBe('NG');

    writeUserEpicIdPrefix(root, null);
    expect(readEpicFocus(root)).toEqual({ active: 'EPIC-7', recent: ['EPIC-7'], watched: ['EPIC-7'] });
  });
});

describe('epic sort — how this user orders the Epics list', () => {
  it('is null until one is picked, and round-trips through user.yaml', () => {
    expect(readEpicSort(root)).toBe(null);
    setEpicSort(root, { by: 'activity', reversed: true });
    expect(readEpicSort(root)).toEqual({ by: 'activity', reversed: true });
    setEpicSort(root, { by: 'name', reversed: false });
    expect(readUserConfig(root)?.epic_sort).toEqual({ by: 'name' });
    expect(readEpicSort(root)).toEqual({ by: 'name', reversed: false });
  });

  it('leaves the working set alone', () => {
    setEpicWatched(root, 'EPIC-1', true);
    setEpicSort(root, { by: 'attention', reversed: false });
    expect(readEpicFocus(root).watched).toEqual(['EPIC-1']);
  });

  it('ignores a malformed value', () => {
    expect(epicSortFrom({ epic_sort: 'activity' })).toBe(null);
    expect(epicSortFrom({ epic_sort: { reversed: true } })).toBe(null);
    expect(epicSortFrom({ epic_sort: { by: 'future-sort' } })).toEqual({ by: 'future-sort', reversed: false });
  });
});

describe('epicIdFromBranch — which epic a branch is about', () => {
  const ids = ['EPIC-001', 'EPIC-012', 'EPIC-1', 'EPIC-260901-NG-003', 'EPIC-003'];

  it('finds the id inside a conventional branch name, ignoring case', () => {
    expect(epicIdFromBranch('feature/EPIC-012-login', ids)).toBe('EPIC-012');
    expect(epicIdFromBranch('fix/epic-001', ids)).toBe('EPIC-001');
  });

  it('never lets a shorter id claim a longer number', () => {
    expect(epicIdFromBranch('feature/EPIC-12-x', ids)).toBe(null);
    expect(epicIdFromBranch('feature/EPIC-1-x', ids)).toBe('EPIC-1');
    expect(epicIdFromBranch('feature/EPIC-1', ids)).toBe('EPIC-1');
  });

  it('prefers the longest id when several fit', () => {
    expect(epicIdFromBranch('feat/EPIC-260901-NG-003', ids)).toBe('EPIC-260901-NG-003');
  });

  it('is null for no branch or no match', () => {
    expect(epicIdFromBranch(null, ids)).toBe(null);
    expect(epicIdFromBranch('main', ids)).toBe(null);
    expect(epicIdFromBranch('xEPIC-001', ids)).toBe(null);
  });
});
