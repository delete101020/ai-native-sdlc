/**
 * "Run with feedback" puts the feedback on the step, not in a file beside the
 * run: `.aidlc/runs/<id>.feedback.md` lingered after the run, untracked or
 * swept into a feature commit, and the step's history never said what the
 * agent had been told.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';

import {
  startRun,
  markStepDone,
  rejectStep,
  rerunStep,
  recordLaunchFeedback,
  renderRunReport,
  PipelineRunError,
} from '../src/index';
import type { PipelineConfig } from '../src/index';
import { revisionFeedback } from '../src/runs/revisionFeedback';

const pipeline = {
  id: 'p',
  steps: [{ agent: 'dev', human_review: true }, { agent: 'rev', human_review: true }],
  on_failure: 'stop',
} as PipelineConfig;

const fresh = () => startRun({ runId: 'R', pipeline, context: {} });

describe('recordLaunchFeedback', () => {
  it('sets the step feedback and logs it, without moving status or revision', () => {
    const s = fresh();
    const fb = 'F35 F36 cần fix\n- F35: giữ tổng đang lưu\n- F36: thêm ca spec';
    const next = recordLaunchFeedback({ state: s, stepIdx: 0, feedback: `  ${fb}\n` });

    const step = next.steps[0];
    expect(step.feedback).toBe(fb);
    expect(step.status).toBe(s.steps[0].status);
    expect(step.revision).toBe(s.steps[0].revision);
    expect(step.history?.at(-1)).toMatchObject({ kind: 'feedback', revision: 1, feedback: fb });
    expect(s.steps[0].feedback).toBeUndefined(); // input untouched
  });

  it('adds nothing when the step already carries that text (rerun / send-back)', () => {
    let s = rejectStep({ state: markStepDone({ state: fresh(), pipeline, workspaceRoot: os.tmpdir() }), pipeline });
    s = rerunStep({ state: s, feedback: 'thiếu API contract' });
    expect(recordLaunchFeedback({ state: s, stepIdx: 0, feedback: 'thiếu API contract ' })).toBe(s);
    expect(recordLaunchFeedback({ state: s, stepIdx: 0, feedback: '   ' })).toBe(s);
  });

  it('edited text replaces the carried one, and a rerun agent is told the new one', () => {
    let s = rejectStep({ state: markStepDone({ state: fresh(), pipeline, workspaceRoot: os.tmpdir() }), pipeline });
    s = rerunStep({ state: s, feedback: 'bản cũ' });
    s = recordLaunchFeedback({ state: s, stepIdx: 0, feedback: 'bản đã sửa trong modal' });

    expect(s.steps[0].feedback).toBe('bản đã sửa trong modal');
    expect(revisionFeedback(s, 0)).toContain('bản đã sửa trong modal');
    expect(renderRunReport({ state: s, pipeline }))
      .toContain('launched with feedback (rev 2): bản đã sửa trong modal');
  });

  it('refuses a step that does not exist', () => {
    expect(() => recordLaunchFeedback({ state: fresh(), stepIdx: 5, feedback: 'x' })).toThrow(PipelineRunError);
  });
});
