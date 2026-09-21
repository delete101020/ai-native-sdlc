/**
 * An incident and everything it opened render as one folded row.
 *
 * The list is read top-to-bottom to find what needs attention, and a family
 * that unfolds itself puts three or four cards between the reader and the next
 * epic — for one thing that happened. So the fold is the default state, and
 * the header row has to answer what the fold hides.
 */
import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

const view = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'webview', 'components', 'EpicsView.tsx'),
  'utf8',
);

describe('epic families fold by default', () => {
  it('starts every family collapsed, whatever its epics are doing', () => {
    // Was `f.epics.every((e) => e.status === 'done')` — only finished families
    // folded, so an active incident still cost a screenful.
    expect(view).toContain('const isCollapsed = collapsed[f.rootId] ?? true;');
  });

  it('says on the header what the fold is hiding', () => {
    // Folding is only acceptable while the closed row still reports work in
    // flight — otherwise a running follow-up disappears from the list.
    expect(view).toContain("const running = f.epics.filter((e) => e.status === 'in_progress').length;");
    expect(view).toContain("const failed = f.epics.filter((e) => e.status === 'failed').length;");
    expect(view).toContain('{running} running');
    expect(view).toContain('{failed} failed');
  });

  it('opens the family a deep link lands in', () => {
    // Both entry points: the chips on the cards (`navigate`) and the host's
    // sidebar link. A folded family would swallow the scroll target.
    expect(view).toContain('if (target) { setCollapsed((c) => ({ ...c, [familyOf(target)]: false })); }');
    expect(view).toContain('const target = state.epics.find((e) => e.id === focusEpic.id);');
  });

  it('leaves a lone epic unwrapped', () => {
    expect(view).toContain('if (f.epics.length < 2) { return cards; }');
  });
});
