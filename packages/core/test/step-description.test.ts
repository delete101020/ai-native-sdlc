/**
 * Per-step `description`.
 *
 * One agent often backs several steps — a dev agent that writes the spec and
 * then builds it — so the agent's description cannot say what either step
 * does. The key has to validate, survive normalization, and survive every
 * path that rebuilds a step from its normalized form: a rebuild that dropped
 * it would put the agent's text back on the card without anyone noticing.
 */
import { describe, it, expect } from 'vitest';

import { normalizeStep, assemblePipeline, validateWorkspace } from '../src';

const base = {
  version: '1.0',
  name: 't',
  agents: [{ id: 'cr-dev', name: 'Dev', skills: ['cr-build-spec', 'cr-build'] }],
  skills: [{ id: 'cr-build-spec', builtin: true }, { id: 'cr-build', builtin: true }],
};

const pipelines = [{
  id: 'cr',
  steps: [
    { agent: 'cr-dev', name: 'cr-build-spec', skills: ['cr-build-spec'], description: 'Write the build spec.' },
    { agent: 'cr-dev', name: 'cr-build', skills: ['cr-build'], description: 'Build against the spec.' },
  ],
}];

describe('step description', () => {
  it('is carried by normalizeStep, trimmed', () => {
    expect(normalizeStep({ agent: 'cr-dev', description: '  Write the build spec.  ' }).description)
      .toBe('Write the build spec.');
  });

  it('is absent when missing or blank', () => {
    expect(normalizeStep({ agent: 'cr-dev' }).description).toBeUndefined();
    expect(normalizeStep({ agent: 'cr-dev', description: '   ' }).description).toBeUndefined();
    expect(normalizeStep('cr-dev').description).toBeUndefined();
  });

  it('validates and is kept by validateWorkspace', () => {
    const cfg = validateWorkspace({ ...base, pipelines }, 'test.yaml');
    expect(cfg.pipelines[0].steps.map((s) => normalizeStep(s).description))
      .toEqual(['Write the build spec.', 'Build against the spec.']);
  });

  it('survives a recipe assembly', () => {
    const cfg = validateWorkspace({
      ...base,
      pipelines,
      recipes: [{ id: 'cr-lite', steps: ['cr-build'] }],
    }, 'test.yaml');
    const assembled = assemblePipeline(cfg, { recipeId: 'cr-lite', pipelineId: 'CR-1' });
    expect(assembled.steps.map((s) => normalizeStep(s).description)).toEqual(['Build against the spec.']);
  });
});
