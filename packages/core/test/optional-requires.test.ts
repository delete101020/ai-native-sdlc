/**
 * Optional `requires` entries — `{ path, optional: true }`.
 *
 * The upstream of an optional `produces` entry: a CR with no legacy source
 * never gets a `business.md`, and the steps downstream that read it when it
 * is there must not be blocked when it is not. A required entry still gates.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  markStepDone,
  canStartStep,
  normalizeStep,
  requiresEntries,
  assemblePipeline,
  validateWorkspace,
  PipelineRunError,
  type PipelineConfig,
} from '../src';

const PIPELINE: PipelineConfig = {
  id: 'cr',
  on_failure: 'stop',
  steps: [
    {
      agent: 'dev',
      requires: [{ path: 'docs/cr/{epic}/business.md', optional: true }, 'docs/cr/{epic}/kickoff.md'],
      produces: [],
      produces_contains: [],
      human_review: false,
      auto_review: false,
      enabled: true,
      optional: false,
      depends_on: [],
    },
  ],
};

describe('optional requires', () => {
  it('normalizes and writes back with the flag', () => {
    const norm = normalizeStep(PIPELINE.steps[0]);
    expect(norm.requires).toEqual(['docs/cr/{epic}/business.md', 'docs/cr/{epic}/kickoff.md']);
    expect(norm.requires_optional).toEqual(['docs/cr/{epic}/business.md']);
    expect(requiresEntries(norm)).toEqual([
      { path: 'docs/cr/{epic}/business.md', optional: true },
      'docs/cr/{epic}/kickoff.md',
    ]);
  });

  it('the schema accepts the object form and a recipe keeps the flag', () => {
    const cfg = validateWorkspace({
      version: '1.0',
      name: 't',
      agents: [{ id: 'dev', name: 'Dev', skills: ['cr-dev'] }],
      skills: [{ id: 'cr-dev', builtin: true }],
      pipelines: [{
        id: 'cr',
        steps: [{ name: 'cr-dev', agent: 'dev', requires: ['a.md', { path: 'b.md', optional: true }] }],
      }],
      recipes: [{ id: 'cr-squad', steps: ['cr-dev'] }],
    }, 'test.yaml');
    const assembled = assemblePipeline(cfg, { recipeId: 'cr-squad', pipelineId: 'CR-1' });
    expect(normalizeStep(assembled.steps[0]).requires_optional).toEqual(['b.md']);
  });

  it('an absent optional entry never blocks; a required one still does', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-optional-requires-'));
    const state = startRun({ runId: 'CR-1', pipeline: PIPELINE, context: { epic: 'CR-1' } });

    expect(canStartStep({ state, pipeline: PIPELINE, workspaceRoot: root }))
      .toEqual({ ok: false, missing: ['docs/cr/CR-1/kickoff.md'] });
    expect(() => markStepDone({ state, pipeline: PIPELINE, workspaceRoot: root })).toThrow(PipelineRunError);

    fs.mkdirSync(path.join(root, 'docs/cr/CR-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/cr/CR-1/kickoff.md'), 'x');
    expect(canStartStep({ state, pipeline: PIPELINE, workspaceRoot: root })).toEqual({ ok: true });
    expect(() => markStepDone({ state, pipeline: PIPELINE, workspaceRoot: root })).not.toThrow();
  });
});
