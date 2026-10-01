import { describe, expect, it } from 'vitest';

import { applyListDeltas, shareStructure } from '../src/webview/lib/hostState';

describe('shareStructure', () => {
  it('keeps every unchanged subtree, and the root when nothing changed', () => {
    const prev = { a: { x: 1 }, b: [1, 2], c: 'k' };
    expect(shareStructure(prev, JSON.parse(JSON.stringify(prev)))).toBe(prev);

    const next = shareStructure(prev, { a: { x: 1 }, b: [1, 3], c: 'k' });
    expect(next).not.toBe(prev);
    expect(next.a).toBe(prev.a);
    expect(next.b).toEqual([1, 3]);
  });

  it('matches list items by id, so a re-sorted list keeps each item', () => {
    const prev = [{ id: 'A', n: 1 }, { id: 'B', n: 2 }];
    const next = shareStructure(prev, [{ id: 'B', n: 2 }, { id: 'A', n: 9 }]);
    expect(next[0]).toBe(prev[1]);
    expect(next[1]).toEqual({ id: 'A', n: 9 });
  });
});

describe('applyListDeltas', () => {
  const prev = { epics: [{ id: 'A', v: 1 }, { id: 'B', v: 1 }], other: 1 };

  it('fills the unchanged items from what is held, in the order sent', () => {
    const next = applyListDeltas(prev, { epics: [], other: 2 }, {
      epics: { ids: ['B', 'A', 'C'], changed: [{ id: 'C', v: 1 } as never, { id: 'A', v: 2 } as never] },
    });
    expect(next?.other).toBe(2);
    expect(next?.epics).toEqual([{ id: 'B', v: 1 }, { id: 'A', v: 2 }, { id: 'C', v: 1 }]);
    expect(next?.epics[0]).toBe(prev.epics[1]);
  });

  it('gives up when an id is not held, so the view can ask for everything', () => {
    expect(applyListDeltas(prev, { epics: [], other: 1 }, { epics: { ids: ['Z'], changed: [] } })).toBeNull();
  });

  it('passes a whole state through untouched', () => {
    const whole = { epics: [], other: 3 };
    expect(applyListDeltas(prev, whole, undefined)).toBe(whole);
  });
});
