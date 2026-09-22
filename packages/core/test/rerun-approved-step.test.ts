/**
 * Rerunning a step that already passed.
 *
 * The distinguishing claim of this transition is what it *doesn't* do:
 * `requestStepUpdate` answers the same user intent by resetting every
 * descendant to `pending`, and the whole point here is that the descendants
 * keep their approval, their artifacts and their history. So the tests are
 * mostly about the downstream steps — that they survive, that they are marked,
 * and that the mark means "done, with a caveat" rather than "not done".
 *
 * The other half is the mark's lifecycle: only the dirty step being approved
 * again clears it, and in particular redoing the step that caused it does not,
 * because the dirty step still has not seen the new output.
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
  canRerunApprovedStep,
  rerunApprovedStep,
  dirtyUpstreamOf,
  isRunComplete,
  deriveRunProgress,
  PipelineRunError,
  type PipelineConfig,
  type RunState,
} from '../src';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-rerun-'));
}

function touch(root: string, rel: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x'.repeat(20));
}

/** No gates — mark done approves and advances in one click. */
const SEQUENTIAL: PipelineConfig = {
  id: 'seq',
  on_failure: 'stop',
  steps: [
    { agent: 'po',        requires: [], produces: ['PRD.md'],         human_review: false, auto_review: false, enabled: true },
    { agent: 'tech-lead', requires: [], produces: ['TECH-DESIGN.md'], human_review: false, auto_review: false, enabled: true },
    { agent: 'dev',       requires: [], produces: ['CODE.md'],        human_review: false, auto_review: false, enabled: true },
  ],
};

/**
 * The shape of CR-Y01: three solo steps fan out from an intake, a merge joins
 * them, and the build hangs off the merge.
 */
const FAN: PipelineConfig = {
  id: 'fan',
  on_failure: 'stop',
  steps: [
    { agent: 'ba',   name: 'intake',   requires: [], produces: ['PRD.md'],   human_review: false, auto_review: false, enabled: true },
    { agent: 'sba',  name: 'solo-ba',  requires: [], produces: ['BA.md'],    human_review: false, auto_review: false, enabled: true, depends_on: ['intake'] },
    { agent: 'sdev', name: 'solo-dev', requires: [], produces: ['DEV.md'],   human_review: false, auto_review: false, enabled: true, depends_on: ['intake'] },
    { agent: 'fac',  name: 'merge',    requires: [], produces: ['MERGE.md'], human_review: false, auto_review: false, enabled: true, depends_on: ['solo-ba', 'solo-dev'] },
    { agent: 'dev',  name: 'build',    requires: [], produces: ['CODE.md'],  human_review: false, auto_review: false, enabled: true, depends_on: ['merge'] },
  ],
};

const FILES = ['PRD.md', 'TECH-DESIGN.md', 'CODE.md', 'BA.md', 'DEV.md', 'MERGE.md'];

describe('rerunApprovedStep', () => {
  let root: string;
  beforeEach(() => {
    root = tmpRoot();
    for (const f of FILES) { touch(root, f); }
  });

  const done = (s: RunState, pipeline: PipelineConfig, stepIdx: number): RunState =>
    markStepDone({ state: s, pipeline, workspaceRoot: root, stepIdx });

  describe('on a sequential pipeline', () => {
    it('rewinds the target and keeps the approved steps after it, marked dirty', () => {
      let s = startRun({ runId: 'r', pipeline: SEQUENTIAL, context: {} });
      s = done(s, SEQUENTIAL, 0);
      s = done(s, SEQUENTIAL, 1);
      expect(s.steps[1].status).toBe('approved');

      s = rerunApprovedStep({ state: s, pipeline: SEQUENTIAL, stepIdx: 0 });

      expect(s.steps[0].status).toBe('awaiting_work');
      expect(s.steps[0].revision).toBe(2);
      expect(s.steps[0].artifactsProduced).toEqual([]);
      expect(s.currentStepIdx).toBe(0);

      // The whole point: step 1 is untouched except for the mark.
      expect(s.steps[1].status).toBe('approved');
      expect(s.steps[1].artifactsProduced).toEqual(['TECH-DESIGN.md']);
      expect(s.steps[1].revision).toBe(1);
      expect(s.steps[1].dirty).toMatchObject({ byStepIdx: 0, byStep: 'po', byRevision: 2 });
    });

    it('leaves a descendant that was never approved exactly as it was', () => {
      let s = startRun({ runId: 'r', pipeline: SEQUENTIAL, context: {} });
      s = done(s, SEQUENTIAL, 0);
      // Step 1 is open but unworked; step 2 was never reached.
      expect(s.steps[1].status).toBe('awaiting_work');

      s = rerunApprovedStep({ state: s, pipeline: SEQUENTIAL, stepIdx: 0 });

      expect(s.steps[1].status).toBe('awaiting_work');
      expect(s.steps[1].dirty).toBeUndefined();
      expect(s.steps[2].status).toBe('pending');
      expect(s.steps[2].dirty).toBeUndefined();
    });
  });

  describe('on a DAG', () => {
    it('marks transitive descendants, not just direct dependents', () => {
      let s = startRun({ runId: 'r', pipeline: FAN, context: {} });
      s = done(s, FAN, 0);
      s = done(s, FAN, 1);
      s = done(s, FAN, 2);
      s = done(s, FAN, 3);            // merge
      s = done(s, FAN, 4);            // build
      expect(s.status).toBe('completed');

      s = rerunApprovedStep({ state: s, pipeline: FAN, stepIdx: 2 });   // solo-dev

      expect(s.steps[2].status).toBe('awaiting_work');
      expect(s.steps[2].revision).toBe(2);
      // merge is the direct dependent, build is one further along.
      expect(s.steps[3].dirty?.byStep).toBe('solo-dev');
      expect(s.steps[4].dirty?.byStep).toBe('solo-dev');
      expect(s.steps[3].status).toBe('approved');
      expect(s.steps[4].status).toBe('approved');
      // The sibling branch shares no edge with solo-dev.
      expect(s.steps[1].dirty).toBeUndefined();
      // And the run is running again, because the target is open.
      expect(s.status).toBe('running');
    });

    it('does not mark a sibling that merely runs later', () => {
      let s = startRun({ runId: 'r', pipeline: FAN, context: {} });
      s = done(s, FAN, 0);
      s = done(s, FAN, 2);            // solo-dev first
      s = done(s, FAN, 1);            // then solo-ba

      s = rerunApprovedStep({ state: s, pipeline: FAN, stepIdx: 1 });   // solo-ba

      expect(s.steps[2].dirty).toBeUndefined();
      expect(s.steps[2].status).toBe('approved');
    });
  });

  describe('the mark', () => {
    it('does not block: a dirty step still counts as done', () => {
      let s = startRun({ runId: 'r', pipeline: FAN, context: {} });
      for (const i of [0, 1, 2, 3, 4]) { s = done(s, FAN, i); }
      s = rerunApprovedStep({ state: s, pipeline: FAN, stepIdx: 2 });

      // Only the reopened target owes the run anything.
      expect(deriveRunProgress(s, FAN).actionable).toEqual([2]);
      expect(deriveRunProgress(s, FAN).blocking).toEqual([]);

      // Redo the target and the run completes again — the dirty marks on
      // merge and build never stood in the way.
      s = done(s, FAN, 2);
      expect(isRunComplete(s, FAN)).toBe(true);
      expect(s.status).toBe('completed');
    });

    it('survives the rerun of the step that caused it', () => {
      let s = startRun({ runId: 'r', pipeline: FAN, context: {} });
      for (const i of [0, 1, 2, 3, 4]) { s = done(s, FAN, i); }
      s = rerunApprovedStep({ state: s, pipeline: FAN, stepIdx: 2 });
      s = done(s, FAN, 2);

      // merge has still not been re-run against the new DEV.md.
      expect(s.steps[3].dirty?.byStep).toBe('solo-dev');
    });

    it('is cleared only by that step being approved again', () => {
      let s = startRun({ runId: 'r', pipeline: FAN, context: {} });
      for (const i of [0, 1, 2, 3, 4]) { s = done(s, FAN, i); }
      s = rerunApprovedStep({ state: s, pipeline: FAN, stepIdx: 2 });
      s = done(s, FAN, 2);
      expect(s.steps[3].dirty).toBeDefined();

      s = rerunApprovedStep({ state: s, pipeline: FAN, stepIdx: 3 });
      expect(s.steps[3].dirty).toBeUndefined();          // the target's own mark goes
      expect(s.steps[4].dirty?.byStep).toBe('merge');    // build is re-marked by merge
      s = done(s, FAN, 3);
      expect(s.steps[3].dirty).toBeUndefined();
      expect(s.steps[4].dirty?.byStep).toBe('merge');
    });

    it('is recorded in the marked step\'s history, which the status alone would not show', () => {
      let s = startRun({ runId: 'r', pipeline: SEQUENTIAL, context: {} });
      s = done(s, SEQUENTIAL, 0);
      s = done(s, SEQUENTIAL, 1);
      s = rerunApprovedStep({ state: s, pipeline: SEQUENTIAL, stepIdx: 0 });

      const entry = s.steps[1].history?.at(-1);
      expect(entry).toMatchObject({ kind: 'dirty', byStep: 'po', byStepIdx: 0, revision: 1 });
      // The approve before it is still there — history is append-only.
      expect(s.steps[1].history?.[0]).toMatchObject({ kind: 'approve' });
    });
  });

  describe('dirtyUpstreamOf', () => {
    it('names the dirty ancestors of a step about to be worked', () => {
      let s = startRun({ runId: 'r', pipeline: FAN, context: {} });
      for (const i of [0, 1, 2, 3]) { s = done(s, FAN, i); }
      s = rerunApprovedStep({ state: s, pipeline: FAN, stepIdx: 2 });

      // `build` sits behind merge, which is now dirty.
      const warn = dirtyUpstreamOf({ state: s, pipeline: FAN, stepIdx: 4 });
      expect(warn.map((w) => w.step)).toEqual(['merge']);
      expect(warn[0].dirty.byStep).toBe('solo-dev');
    });

    it('is empty for a step with nothing suspect behind it', () => {
      let s = startRun({ runId: 'r', pipeline: FAN, context: {} });
      for (const i of [0, 1, 2, 3]) { s = done(s, FAN, i); }
      expect(dirtyUpstreamOf({ state: s, pipeline: FAN, stepIdx: 4 })).toEqual([]);

      s = rerunApprovedStep({ state: s, pipeline: FAN, stepIdx: 2 });
      // solo-dev's own branch has a clean ancestor chain (just intake).
      expect(dirtyUpstreamOf({ state: s, pipeline: FAN, stepIdx: 2 })).toEqual([]);
    });

    it('walks the sequential chain when the pipeline declares no edges', () => {
      let s = startRun({ runId: 'r', pipeline: SEQUENTIAL, context: {} });
      s = done(s, SEQUENTIAL, 0);
      s = done(s, SEQUENTIAL, 1);
      s = rerunApprovedStep({ state: s, pipeline: SEQUENTIAL, stepIdx: 0 });

      expect(dirtyUpstreamOf({ state: s, pipeline: SEQUENTIAL, stepIdx: 2 })
        .map((w) => w.stepIdx)).toEqual([1]);
    });
  });

  describe('refusals', () => {
    it('refuses a step that was marked done but not yet approved, and points at undo', () => {
      const HUMAN: PipelineConfig = {
        id: 'h',
        on_failure: 'stop',
        steps: [
          { agent: 'po', requires: [], produces: ['PRD.md'], human_review: true, auto_review: false, enabled: true },
        ],
      };
      let s = startRun({ runId: 'r', pipeline: HUMAN, context: {} });
      s = done(s, HUMAN, 0);
      expect(s.steps[0].status).toBe('awaiting_review');

      const gate = canRerunApprovedStep({ state: s, pipeline: HUMAN, stepIdx: 0 });
      expect(gate.ok).toBe(false);
      expect((gate as { reason: string }).reason).toContain('Undo');
      expect(() => rerunApprovedStep({ state: s, pipeline: HUMAN, stepIdx: 0 }))
        .toThrow(PipelineRunError);
    });

    it('refuses a rejected step — that is what rerunStep is for', () => {
      const GATED: PipelineConfig = {
        id: 'g',
        on_failure: 'stop',
        steps: [
          { agent: 'po', requires: [], produces: ['PRD.md'], human_review: true, auto_review: false, enabled: true },
        ],
      };
      let s = startRun({ runId: 'r', pipeline: GATED, context: {} });
      s = done(s, GATED, 0);
      s = rejectStep({ state: s, pipeline: GATED, stepIdx: 0, reason: 'no' });
      expect(s.steps[0].status).toBe('rejected');
      expect(canRerunApprovedStep({ state: s, pipeline: GATED, stepIdx: 0 }).ok).toBe(false);
    });

    it('refuses an index the run does not have', () => {
      const s = startRun({ runId: 'r', pipeline: SEQUENTIAL, context: {} });
      expect(canRerunApprovedStep({ state: s, pipeline: SEQUENTIAL, stepIdx: 9 }).ok).toBe(false);
    });
  });
});
