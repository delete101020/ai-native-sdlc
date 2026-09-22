/**
 * Undoing a "Mark step done".
 *
 * The transition exists for a misclick, so the tests that matter are the ones
 * about what it refuses: the moment a following step has been worked, this is
 * no longer an undo — it is a rewind, and `requestStepUpdate` owns that. The
 * other half is that an undo must be *cheap*: same revision, same feedback,
 * nothing touched on disk. A rerun in undo's clothing would be worse than no
 * undo at all, because the user would only find out from the history.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  markStepDone,
  approveStep,
  rejectStep,
  canUndoStepDone,
  undoStepDone,
  PipelineRunError,
  type PipelineConfig,
} from '../src';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-undo-'));
}

function touch(root: string, rel: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x'.repeat(20));
}

/** No gates at all — mark done approves and advances in one click. */
const SEQUENTIAL: PipelineConfig = {
  id: 'seq',
  on_failure: 'stop',
  steps: [
    { agent: 'po',        requires: [],         produces: ['PRD.md'],         human_review: false, auto_review: false, enabled: true },
    { agent: 'tech-lead', requires: ['PRD.md'], produces: ['TECH-DESIGN.md'], human_review: false, auto_review: false, enabled: true },
    { agent: 'dev',       requires: [],         produces: ['CODE.md'],        human_review: false, auto_review: false, enabled: true },
  ],
};

const HUMAN_GATE: PipelineConfig = {
  id: 'human',
  on_failure: 'stop',
  steps: [
    { agent: 'po',        requires: [], produces: ['PRD.md'],         human_review: true, auto_review: false, enabled: true },
    { agent: 'tech-lead', requires: [], produces: ['TECH-DESIGN.md'], human_review: true, auto_review: false, enabled: true },
  ],
};

/** `spec` fans out to two independent steps. */
const DAG: PipelineConfig = {
  id: 'dag',
  on_failure: 'stop',
  steps: [
    { agent: 'po',  name: 'spec', requires: [], produces: ['PRD.md'],  human_review: false, auto_review: false, enabled: true },
    { agent: 'dev', name: 'impl', requires: [], produces: ['CODE.md'], human_review: false, auto_review: false, enabled: true, depends_on: ['spec'] },
    { agent: 'qa',  name: 'test', requires: [], produces: ['TEST.md'], human_review: false, auto_review: false, enabled: true, depends_on: ['spec'] },
  ],
};

describe('undoStepDone', () => {
  let root: string;
  beforeEach(() => {
    root = tmpRoot();
    touch(root, 'PRD.md');
    touch(root, 'TECH-DESIGN.md');
    touch(root, 'CODE.md');
    touch(root, 'TEST.md');
  });

  it('closes the step the mark-done opened and reopens the one it approved', () => {
    const started = startRun({ runId: 'R1', pipeline: SEQUENTIAL, context: {} });
    const done = markStepDone({ state: started, pipeline: SEQUENTIAL, workspaceRoot: root });
    expect(done.steps[0].status).toBe('approved');
    expect(done.steps[1].status).toBe('awaiting_work');

    const back = undoStepDone({ state: done, pipeline: SEQUENTIAL, stepIdx: 0 });
    expect(back.steps[0].status).toBe('awaiting_work');
    expect(back.steps[1].status).toBe('pending');
    expect(back.steps[1].startedAt).toBeUndefined();
    expect(back.currentStepIdx).toBe(0);
    expect(back.status).toBe('running');
  });

  it('costs nothing — same revision, same feedback, no rerun recorded', () => {
    const started = startRun({ runId: 'R1', pipeline: SEQUENTIAL, context: {} });
    // Give the step a carried note, the way a rejection would.
    started.steps[0].feedback = 'tighten the scope section';
    const done = markStepDone({ state: started, pipeline: SEQUENTIAL, workspaceRoot: root });
    const back = undoStepDone({ state: done, pipeline: SEQUENTIAL, stepIdx: 0 });

    expect(back.steps[0].revision).toBe(started.steps[0].revision);
    expect(back.steps[0].feedback).toBe('tighten the scope section');
    expect(back.steps[0].finishedAt).toBeUndefined();
    // `startedAt` survives: same attempt at the same step, and the panel dates
    // the artifact against it.
    expect(back.steps[0].startedAt).toBe(started.steps[0].startedAt);
    expect(back.steps[0].history?.some((h) => h.kind === 'rerun')).toBe(false);
    const last = back.steps[0].history?.at(-1);
    expect(last).toMatchObject({ kind: 'undo', revision: 1, from: 'approved' });
  });

  it('undoes a mark-done that only reached the human gate', () => {
    const started = startRun({ runId: 'R1', pipeline: HUMAN_GATE, context: {} });
    const done = markStepDone({ state: started, pipeline: HUMAN_GATE, workspaceRoot: root });
    expect(done.steps[0].status).toBe('awaiting_review');

    const back = undoStepDone({ state: done, pipeline: HUMAN_GATE, stepIdx: 0 });
    expect(back.steps[0].status).toBe('awaiting_work');
    expect(back.steps[0].artifactsProduced).toEqual([]);
    // Nothing was opened, so nothing closes.
    expect(back.steps[1].status).toBe('pending');
  });

  it('closes every branch a DAG fan-out opened', () => {
    const started = startRun({ runId: 'R1', pipeline: DAG, context: {} });
    const done = markStepDone({ state: started, pipeline: DAG, workspaceRoot: root });
    expect([done.steps[1].status, done.steps[2].status]).toEqual(['awaiting_work', 'awaiting_work']);

    const back = undoStepDone({ state: done, pipeline: DAG, stepIdx: 0 });
    expect([back.steps[1].status, back.steps[2].status]).toEqual(['pending', 'pending']);
  });

  it('refuses once a following step has been worked', () => {
    const started = startRun({ runId: 'R1', pipeline: SEQUENTIAL, context: {} });
    const one = markStepDone({ state: started, pipeline: SEQUENTIAL, workspaceRoot: root });
    const two = markStepDone({ state: one, pipeline: SEQUENTIAL, workspaceRoot: root, stepIdx: 1 });

    const gate = canUndoStepDone({ state: two, pipeline: SEQUENTIAL, stepIdx: 0 });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toMatch(/Request update/);
    expect(() => undoStepDone({ state: two, pipeline: SEQUENTIAL, stepIdx: 0 }))
      .toThrow(PipelineRunError);
    // The one the user actually just clicked is still undoable.
    expect(canUndoStepDone({ state: two, pipeline: SEQUENTIAL, stepIdx: 1 }).ok).toBe(true);
  });

  it('refuses when one branch of a fan-out has moved on', () => {
    const started = startRun({ runId: 'R1', pipeline: DAG, context: {} });
    const done = markStepDone({ state: started, pipeline: DAG, workspaceRoot: root });
    const impl = markStepDone({ state: done, pipeline: DAG, workspaceRoot: root, stepIdx: 1 });

    expect(canUndoStepDone({ state: impl, pipeline: DAG, stepIdx: 0 }).ok).toBe(false);
  });

  it('has nothing to undo on a step that was never marked done', () => {
    const started = startRun({ runId: 'R1', pipeline: SEQUENTIAL, context: {} });
    const gate = canUndoStepDone({ state: started, pipeline: SEQUENTIAL, stepIdx: 0 });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toMatch(/awaiting_work/);
    expect(canUndoStepDone({ state: started, pipeline: SEQUENTIAL, stepIdx: 2 }).ok).toBe(false);
  });

  it('is not a way around a rejection', () => {
    const started = startRun({ runId: 'R1', pipeline: HUMAN_GATE, context: {} });
    const done = markStepDone({ state: started, pipeline: HUMAN_GATE, workspaceRoot: root });
    const no = rejectStep({ state: done, pipeline: HUMAN_GATE, reason: 'thin', stepIdx: 0 });
    expect(no.steps[0].status).toBe('rejected');
    // Rerun is the documented path out of a rejection; undo must not launder it
    // into a fresh attempt at the same revision.
    expect(canUndoStepDone({ state: no, pipeline: HUMAN_GATE, stepIdx: 0 }).ok).toBe(false);
  });

  it('reopens the last step of a completed run', () => {
    const started = startRun({ runId: 'R1', pipeline: SEQUENTIAL, context: {} });
    let state = markStepDone({ state: started, pipeline: SEQUENTIAL, workspaceRoot: root });
    state = markStepDone({ state, pipeline: SEQUENTIAL, workspaceRoot: root, stepIdx: 1 });
    state = markStepDone({ state, pipeline: SEQUENTIAL, workspaceRoot: root, stepIdx: 2 });
    expect(state.status).toBe('completed');

    const back = undoStepDone({ state, pipeline: SEQUENTIAL, stepIdx: 2 });
    expect(back.status).toBe('running');
    expect(back.steps[2].status).toBe('awaiting_work');
    expect(back.currentStepIdx).toBe(2);
  });

  it('undoes a human approval too — the click after the click', () => {
    const started = startRun({ runId: 'R1', pipeline: HUMAN_GATE, context: {} });
    const done = markStepDone({ state: started, pipeline: HUMAN_GATE, workspaceRoot: root });
    const yes = approveStep({ state: done, pipeline: HUMAN_GATE, stepIdx: 0 });
    expect(yes.steps[0].status).toBe('approved');

    const back = undoStepDone({ state: yes, pipeline: HUMAN_GATE, stepIdx: 0 });
    expect(back.steps[0].status).toBe('awaiting_work');
    // The approve stays in the timeline; the undo is appended after it rather
    // than erasing it.
    const kinds = back.steps[0].history?.map((h) => h.kind);
    expect(kinds).toEqual(['approve', 'undo']);
  });
});
