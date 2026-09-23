/**
 * Progress counted in stages, not steps.
 *
 * The case that drove it: CR-Y01 fans `cr-solo-ba` / `cr-solo-dev` /
 * `cr-solo-qc` out of one intake and back into one merge. Those three are one
 * round of review, and counting them as three of nine steps made the epic
 * claim a third of itself done for finishing a single round.
 */

import { describe, it, expect } from 'vitest';
import { weighStepProgress, type ProgressStep } from '../src/runs/runProgress';

/** The CR-Y01 shape: intake → three peers → merge → spec → build. */
const FAN: Array<Omit<ProgressStep, 'done'>> = [
  { id: 'cr-intake', dependsOn: [] },
  { id: 'cr-solo-ba', dependsOn: ['cr-intake'] },
  { id: 'cr-solo-dev', dependsOn: ['cr-intake'] },
  { id: 'cr-solo-qc', dependsOn: ['cr-intake'] },
  { id: 'cr-merge', dependsOn: ['cr-solo-dev'] },
  { id: 'cr-build-spec', dependsOn: ['cr-merge'] },
  { id: 'cr-build', dependsOn: ['cr-build-spec'] },
];

const withDone = (
  steps: Array<Omit<ProgressStep, 'done'>>,
  done: string[],
): ProgressStep[] => steps.map((s) => ({ ...s, done: done.includes(s.id) }));

describe('weighStepProgress', () => {
  it('counts a rank of peers as one stage', () => {
    const w = weighStepProgress(withDone(FAN, []));
    // 7 steps, 5 ranks: the three solos share one.
    expect(w.stages).toBe(5);
    expect(w.ranks).toEqual([0, 1, 1, 1, 2, 3, 4]);
    expect(w.weights[1]).toBeCloseTo(1 / 3);
    expect(w.weights[0]).toBe(1);
  });

  it('gives the whole fan-out one stage, not three', () => {
    const all = weighStepProgress(withDone(FAN, ['cr-intake', 'cr-solo-ba', 'cr-solo-dev', 'cr-solo-qc']));
    expect(all.stagesDone).toBeCloseTo(2);
    expect(all.percent).toBe(Math.round((2 / 5) * 100));
    // By step count that would have been 4/7 — 57% for two rounds of work.
    expect(all.percent).toBeLessThan(57);
  });

  it('gives partial credit while a stage is only partly done', () => {
    const one = weighStepProgress(withDone(FAN, ['cr-intake', 'cr-solo-dev']));
    expect(one.stagesDone).toBeCloseTo(1 + 1 / 3);
  });

  it('leaves a sequential pipeline counted exactly as before', () => {
    const seq = [
      { id: 'a', dependsOn: [], done: true },
      { id: 'b', dependsOn: [], done: true },
      { id: 'c', dependsOn: [], done: false },
      { id: 'd', dependsOn: [], done: false },
    ];
    // No `depends_on` anywhere: every step is its own stage, so this is the
    // plain 2/4 the old arithmetic produced.
    const w = weighStepProgress(seq);
    expect(w.stages).toBe(4);
    expect(w.percent).toBe(50);
  });

  it('reaches 100 when every step is done', () => {
    const w = weighStepProgress(withDone(FAN, FAN.map((s) => s.id)));
    expect(w.percent).toBe(100);
    expect(w.stagesDone).toBeCloseTo(w.stages);
  });

  it('is 0 for an epic with no steps', () => {
    expect(weighStepProgress([])).toEqual({
      ranks: [], weights: [], stages: 0, stagesDone: 0, percent: 0,
    });
  });

  it('ranks by the longest path, so a shortcut does not pull a step forward', () => {
    // `d` depends on both `a` (rank 0) and `c` (rank 2) — it belongs after c.
    const w = weighStepProgress([
      { id: 'a', dependsOn: [], done: false },
      { id: 'b', dependsOn: ['a'], done: false },
      { id: 'c', dependsOn: ['b'], done: false },
      { id: 'd', dependsOn: ['a', 'c'], done: false },
    ]);
    expect(w.ranks).toEqual([0, 1, 2, 3]);
  });

  it('ignores a dependency on an id no step declares', () => {
    const w = weighStepProgress([
      { id: 'a', dependsOn: ['ghost'], done: true },
      { id: 'b', dependsOn: ['a'], done: false },
    ]);
    expect(w.ranks).toEqual([0, 1]);
    expect(w.percent).toBe(50);
  });

  it('does not hang on a dependency cycle', () => {
    const w = weighStepProgress([
      { id: 'a', dependsOn: ['b'], done: true },
      { id: 'b', dependsOn: ['a'], done: false },
    ]);
    expect(w.stages).toBeGreaterThan(0);
    expect(w.percent).toBeGreaterThanOrEqual(0);
    expect(w.percent).toBeLessThanOrEqual(100);
  });

  it('resolves a duplicate id to the first step that carries it', () => {
    // Two steps on the same agent with no `name` — `depends_on` could only
    // ever have meant the first.
    const w = weighStepProgress([
      { id: 'dev', dependsOn: [], done: true },
      { id: 'dev', dependsOn: [], done: false },
      { id: 'qa', dependsOn: ['dev'], done: false },
    ]);
    expect(w.ranks).toEqual([0, 0, 1]);
    expect(w.stagesDone).toBeCloseTo(0.5);
  });
});
