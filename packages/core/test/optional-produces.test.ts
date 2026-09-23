/**
 * Optional `produces` entries — `{ path, optional: true }`.
 *
 * A step that renders a diagram only when there is something to draw wants
 * that diagram listed with its artifacts, and never wants its absence to
 * block mark-done. The tests that matter are the ones about the gate: an
 * optional entry that is missing is not "missing", a required one still is,
 * and the flag survives every path that rebuilds a step from its normalized
 * form — a recipe that dropped it would quietly make the diagram required.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  markStepDone,
  verifyRun,
  normalizeStep,
  producesEntries,
  assemblePipeline,
  validateWorkspace,
  PipelineRunError,
  WorkspaceValidationError,
  type PipelineConfig,
} from '../src';
import { stepProducesFollowUps } from '../src/schema/FollowUpHookSchema';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-optional-produces-'));
}

function touch(root: string, rel: string, body = 'x'.repeat(20)): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

const INTAKE: PipelineConfig = {
  id: 'cr',
  on_failure: 'stop',
  steps: [
    {
      agent: 'intake',
      requires: [],
      produces: [
        'docs/cr/{epic}/business.md',
        { path: 'docs/cr/{epic}/diagrams/overview.html', optional: true },
      ],
      produces_contains: [],
      human_review: false,
      auto_review: false,
      enabled: true,
      optional: false,
      depends_on: [],
    },
    { agent: 'next', requires: [], produces: [], human_review: false, auto_review: false, enabled: true } as never,
  ],
};

describe('normalizeStep — optional produces', () => {
  it('flattens every entry into `produces` and lists the optional ones apart', () => {
    const norm = normalizeStep({
      agent: 'a',
      produces: ['a.md', { path: 'b.html', optional: true }, { path: 'c.md', optional: false }],
    });
    expect(norm.produces).toEqual(['a.md', 'b.html', 'c.md']);
    expect(norm.produces_optional).toEqual(['b.html']);
  });

  it('writes the entries back with their flag', () => {
    const norm = normalizeStep({ agent: 'a', produces: ['a.md', { path: 'b.html', optional: true }] });
    expect(producesEntries(norm)).toEqual(['a.md', { path: 'b.html', optional: true }]);
  });

  it('a string-only list has no optional entries', () => {
    expect(normalizeStep({ agent: 'a', produces: ['a.md'] }).produces_optional).toEqual([]);
  });
});

describe('markStepDone — optional produces', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('does not block when the optional entry is absent, and leaves it out of the record', () => {
    touch(root, 'docs/cr/CR-1/business.md');
    const started = startRun({ runId: 'CR-1', pipeline: INTAKE, context: { epic: 'CR-1' } });
    const done = markStepDone({ state: started, pipeline: INTAKE, workspaceRoot: root });
    expect(done.steps[0].status).toBe('approved');
    expect(done.steps[0].artifactsProduced).toEqual(['docs/cr/CR-1/business.md']);
  });

  it('records the optional entry when it is there', () => {
    touch(root, 'docs/cr/CR-1/business.md');
    touch(root, 'docs/cr/CR-1/diagrams/overview.html');
    const started = startRun({ runId: 'CR-1', pipeline: INTAKE, context: { epic: 'CR-1' } });
    const done = markStepDone({ state: started, pipeline: INTAKE, workspaceRoot: root });
    expect(done.steps[0].artifactsProduced).toEqual([
      'docs/cr/CR-1/business.md',
      'docs/cr/CR-1/diagrams/overview.html',
    ]);
  });

  it('still blocks on a missing required entry, and names only that one', () => {
    const started = startRun({ runId: 'CR-1', pipeline: INTAKE, context: { epic: 'CR-1' } });
    try {
      markStepDone({ state: started, pipeline: INTAKE, workspaceRoot: root });
      expect.unreachable('mark-done should have been blocked');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineRunError);
      expect((err as PipelineRunError).missing).toEqual(['docs/cr/CR-1/business.md']);
    }
  });

  it('a later drift check does not report the optional entry the step never wrote', () => {
    touch(root, 'docs/cr/CR-1/business.md');
    const started = startRun({ runId: 'CR-1', pipeline: INTAKE, context: { epic: 'CR-1' } });
    const done = markStepDone({ state: started, pipeline: INTAKE, workspaceRoot: root });
    expect(verifyRun({ state: done, pipeline: INTAKE, workspaceRoot: root }).drift).toEqual([]);
  });
});

describe('schema — optional produces', () => {
  const base = {
    version: '1.0',
    name: 't',
    agents: [{ id: 'intake', name: 'Intake', skills: ['cr-intake'] }],
    skills: [{ id: 'cr-intake', builtin: true }],
  };

  it('accepts the object form', () => {
    const cfg = validateWorkspace({
      ...base,
      pipelines: [{
        id: 'cr',
        steps: [{ agent: 'intake', produces: ['a.md', { path: 'b.html', optional: true }] }],
      }],
    }, 'test.yaml');
    expect(normalizeStep(cfg.pipelines[0].steps[0]).produces_optional).toEqual(['b.html']);
  });

  it('rejects a misspelt key instead of silently making the entry required', () => {
    expect(() => validateWorkspace({
      ...base,
      pipelines: [{ id: 'cr', steps: [{ agent: 'intake', produces: [{ path: 'b.html', optonal: true }] }] }],
    }, 'test.yaml')).toThrow(WorkspaceValidationError);
  });

  it('a recipe keeps the flag on the steps it assembles', () => {
    const cfg = validateWorkspace({
      ...base,
      pipelines: [{
        id: 'cr',
        steps: [{ name: 'cr-intake', agent: 'intake', produces: ['a.md', { path: 'b.html', optional: true }] }],
      }],
      recipes: [{ id: 'cr-squad', steps: ['cr-intake'] }],
    }, 'test.yaml');
    const assembled = assemblePipeline(cfg, { recipeId: 'cr-squad', pipelineId: 'CR-1' });
    expect(normalizeStep(assembled.steps[0]).produces_optional).toEqual(['b.html']);
  });

  it('a follow-ups manifest declared in object form still counts', () => {
    expect(stepProducesFollowUps({ agent: 'a', produces: [{ path: 'docs/x/followups.json', optional: true }] })).toBe(true);
  });
});
