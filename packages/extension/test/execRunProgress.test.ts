import { describe, expect, it } from 'vitest';

import { stepProgressMessage } from '../src/v2/execRunProgress';

/**
 * The autopilot's one line of progress. A first pass at a step is the
 * ordinary case and stays short; the revision only shows on a rerun, so a run
 * going round in circles is visible without reading the log.
 */
const base = { loop: 3, stepIdx: 3, total: 7, label: 'cr-review', revision: 1, rejections: 0 };

describe('stepProgressMessage', () => {
  it('shows loop and 1-based step of total on a first pass', () => {
    expect(stepProgressMessage(base)).toBe('loop 3 · step 4/7 · cr-review');
  });

  it('adds the revision and rejection count on a rerun', () => {
    expect(stepProgressMessage({ ...base, loop: 5, revision: 3, rejections: 2 }))
      .toBe('loop 5 · step 4/7 · cr-review · rev 3 (rejected 2×)');
  });

  it('shows the revision alone when a later step sent the work back', () => {
    expect(stepProgressMessage({ ...base, revision: 2, rejections: 0 }))
      .toBe('loop 3 · step 4/7 · cr-review · rev 2');
  });
});
