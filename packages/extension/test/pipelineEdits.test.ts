/**
 * Saving a pipeline from the builder keeps what the modal does not edit, and
 * never writes an `on_reject` the schema would refuse. Re-saving `cr-squad`
 * through Edit pipeline used to drop `cr-review`'s `on_reject` and
 * `cr-build`'s `batches`, and the build ⇄ review loop quietly stopped.
 */
import { describe, expect, it } from 'vitest';

import {
  applyLoopSettings,
  applyStepLoopSettings,
  newSendBackIssues,
  rebuildEditedSteps,
} from '../src/v2/pipelineEdits';
import { sendBackChoices, sendBackSources } from '../src/webview/lib/pipelines';
import type { PipelineStepSummary } from '../src/webview/lib/types';

const crSquad = () => [
  { agent: 'dev', name: 'cr-build-spec', human_review: true, produces: ['spec.md'] },
  {
    agent: 'dev', name: 'cr-build', enabled: false, batches: true, max_batches: 4, timeout_minutes: 90,
    produces: ['build-log.md', { path: 'review-answers.md', optional: true }],
  },
  {
    agent: 'reviewer', name: 'cr-review', human_review: true, auto_review: true,
    auto_review_runner: '.aidlc/scripts/validate-cr-review.mjs', on_reject: { send_back_to: 'cr-build' },
  },
];

/** What the Edit pipeline modal sends for `steps`: only the fields it owns. */
const draftOf = (steps: Array<Record<string, unknown>>) =>
  steps.map((s) => ({
    agent: s.agent, name: s.name, human_review: s.human_review === true,
    auto_review: s.auto_review === true, auto_review_runner: s.auto_review_runner,
  }));

describe('rebuildEditedSteps', () => {
  it('keeps every field the modal does not edit', () => {
    const old = crSquad();
    const r = rebuildEditedSteps(old, draftOf(old));
    expect(r.ok).toBe(true);
    if (!r.ok) { return; }
    expect(r.steps[1]).toMatchObject({
      enabled: false, batches: true, max_batches: 4, timeout_minutes: 90,
      produces: ['build-log.md', { path: 'review-answers.md', optional: true }],
    });
    expect(r.steps[2].on_reject).toEqual({ send_back_to: 'cr-build' });
  });

  it('pairs steps of one agent by name, so reordering does not swap what they carry', () => {
    const old = crSquad().slice(0, 2);
    const r = rebuildEditedSteps(old, draftOf(old).reverse());
    expect(r.ok && r.steps.map((s) => [s.name, s.batches === true])).toEqual([['cr-build', true], ['cr-build-spec', false]]);
  });

  it('applies the modal-owned fields, and a new step starts empty', () => {
    const old = crSquad();
    const draft = [...draftOf(old), { agent: 'qa', human_review: false, auto_review: false, skills: ['s1'] }];
    draft[2].human_review = false;
    const r = rebuildEditedSteps(old, draft);
    expect(r.ok).toBe(true);
    if (!r.ok) { return; }
    expect(r.steps[2].human_review).toBe(false);
    expect(r.steps[3]).toEqual({ agent: 'qa', enabled: true, requires: [], produces: [], skills: ['s1'], human_review: false, auto_review: false });
  });

  it('drops on_reject with auto_review, and refuses a target that gains human review', () => {
    const old = crSquad();
    const offDraft = draftOf(old);
    offDraft[2].auto_review = false;
    const off = rebuildEditedSteps(old, offDraft);
    expect(off.ok && off.steps[2].on_reject).toBeUndefined();

    const gated = draftOf(old);
    gated[1].human_review = true;
    const r = rebuildEditedSteps(old, gated);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('human_review');
  });

  it('refuses moving the reviewer ahead of the step it sends back to', () => {
    const old = crSquad();
    const d = draftOf(old);
    const r = rebuildEditedSteps(old, [d[0], d[2], d[1]]);
    expect(!r.ok && r.error).toContain('must be a step before this one');
  });
});

describe('step and pipeline loop settings', () => {
  it('sets and clears on_reject and batches only when the modal sent them', () => {
    const step: Record<string, unknown> = { agent: 'r', auto_review: true, batches: true, max_batches: 2, pause_between_batches: true };
    applyStepLoopSettings(step, {});
    expect(step).toMatchObject({ batches: true, max_batches: 2 });

    applyStepLoopSettings(step, { send_back_to: 'cr-build', batches: false });
    expect(step.on_reject).toEqual({ send_back_to: 'cr-build' });
    expect(step).not.toHaveProperty('batches');
    expect(step).not.toHaveProperty('max_batches');
    expect(step).not.toHaveProperty('pause_between_batches');

    applyStepLoopSettings(step, { send_back_to: '' });
    expect(step).not.toHaveProperty('on_reject');
  });

  it('only reports send-back problems the edit introduced', () => {
    const before = crSquad();
    expect(newSendBackIssues(before, before)).toEqual([]);
    const after = before.map((s, i) => (i === 1 ? { ...s, human_review: true } : s));
    expect(newSendBackIssues(before, after)).toHaveLength(1);
    expect(newSendBackIssues(after, after)).toEqual([]);
  });

  it('pipeline autopilot and max_send_backs', () => {
    const p: Record<string, unknown> = { id: 'x', autopilot: true, max_send_backs: 3 };
    applyLoopSettings(p, { on_failure: 'stop' });
    expect(p).toMatchObject({ autopilot: true, max_send_backs: 3 });
    applyLoopSettings(p, { autopilot: false, max_send_backs: 0 });
    expect(p).not.toHaveProperty('autopilot');
    expect(p.max_send_backs).toBe(0);
    applyLoopSettings(p, { max_send_backs: undefined });
    expect(p).not.toHaveProperty('max_send_backs');
  });
});

describe('send-back choices in the step config modal', () => {
  const summary = (over: Partial<PipelineStepSummary>): PipelineStepSummary => ({
    agent: 'dev', enabled: true, produces: [], requires: [], human_review: false, auto_review: false, ...over,
  });
  const steps = [
    summary({ name: 'cr-build-spec', human_review: true }),
    summary({ name: 'cr-build' }),
    summary({ agent: 'reviewer', name: 'cr-review', auto_review: true, send_back_to: 'cr-build' }),
  ];

  it('offers the earlier steps and marks the ones the runner refuses', () => {
    expect(sendBackChoices(steps, 2)).toEqual([
      { ref: 'cr-build-spec', label: '1. cr-build-spec', blocked: 'has human review' },
      { ref: 'cr-build', label: '2. cr-build' },
    ]);
    expect(sendBackChoices(steps, 0)).toEqual([]);
  });

  it('marks an unnamed step whose agent backs several steps', () => {
    const unnamed = [summary({}), summary({}), summary({ agent: 'r' })];
    expect(sendBackChoices(unnamed, 2)[0].blocked).toContain('name this step');
  });

  it('names the later steps that send back to a step', () => {
    expect(sendBackSources(steps, 1)).toEqual(['cr-review']);
    expect(sendBackSources(steps, 0)).toEqual([]);
  });
});
