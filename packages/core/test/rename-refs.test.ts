import { describe, it, expect } from 'vitest';

import {
  renameAgentRefs,
  renameSkillRefs,
  agentReferences,
  skillReferences,
  unusedAfterStepRemoval,
} from '../src';

/**
 * A workspace shaped like the one that hit the original bug: one pipeline whose
 * steps are a mix of named and unnamed, recipes drawn from it, and slash
 * commands pointing at both an agent and the pipeline.
 */
function doc(): Record<string, unknown> {
  return {
    skills: [{ id: 'intake', builtin: true }, { id: 'qc', builtin: true }],
    agents: [
      { id: 'cr-intake', name: 'Intake', skills: ['intake'] },
      { id: 'cr-qc', name: 'QC', skills: ['qc', 'intake'] },
    ],
    pipelines: [
      {
        id: 'cr-squad',
        steps: [
          // Unnamed: its DAG id *is* the agent id.
          { agent: 'cr-intake', depends_on: [] },
          // Named: its DAG id is independent of the agent it runs.
          { agent: 'cr-qc', name: 'cr-test', depends_on: ['cr-intake'], skills: ['qc'] },
        ],
      },
    ],
    recipes: [
      { id: 'cr-full', from: 'cr-squad', steps: ['cr-intake', 'cr-test'], gates: { 'cr-intake': { human_review: true } } },
    ],
    slash_commands: [
      { name: '/cr-intake', agent: 'cr-intake' },
      { name: '/cr-squad', pipeline: 'cr-squad' },
    ],
  };
}

describe('renameAgentRefs', () => {
  it('re-points steps and slash commands', () => {
    const d = doc();
    const edit = renameAgentRefs(d, 'cr-intake', 'cr-triage');

    const steps = (d.pipelines as any)[0].steps;
    expect(steps[0].agent).toBe('cr-triage');
    expect((d.slash_commands as any)[0].agent).toBe('cr-triage');
    expect(edit.paths).toContain('pipelines.cr-squad.steps.cr-intake.agent');
    expect(edit.paths).toContain('slash_commands./cr-intake.agent');
  });

  it('drags the DAG id of an unnamed step through depends_on and recipes', () => {
    const d = doc();
    const edit = renameAgentRefs(d, 'cr-intake', 'cr-triage');

    // The renamed step had no `name`, so every id addressing it moved too.
    expect(edit.renamedStepIds).toEqual(['cr-intake']);
    expect((d.pipelines as any)[0].steps[1].depends_on).toEqual(['cr-triage']);
    expect((d.recipes as any)[0].steps).toEqual(['cr-triage', 'cr-test']);
    expect((d.recipes as any)[0].gates).toEqual({ 'cr-triage': { human_review: true } });
  });

  it('leaves the DAG id alone when the step carries its own name', () => {
    const d = doc();
    const edit = renameAgentRefs(d, 'cr-qc', 'cr-quality');

    expect((d.pipelines as any)[0].steps[1].agent).toBe('cr-quality');
    // `cr-test` is the step id, and it did not change — so nothing addressing
    // it needed to move.
    expect(edit.renamedStepIds).toEqual([]);
    expect((d.recipes as any)[0].steps).toEqual(['cr-intake', 'cr-test']);
    expect((d.pipelines as any)[0].steps[1].depends_on).toEqual(['cr-intake']);
  });

  it('rewrites a legacy bare-string step', () => {
    const d = { pipelines: [{ id: 'p', steps: ['po', 'dev'] }] };
    renameAgentRefs(d, 'po', 'product-owner');
    expect((d.pipelines as any)[0].steps).toEqual(['product-owner', 'dev']);
  });

  it('follows a recipe that relies on the first-pipeline fallback', () => {
    const d = doc();
    delete (d.recipes as any)[0].from;
    renameAgentRefs(d, 'cr-intake', 'cr-triage');
    expect((d.recipes as any)[0].steps).toEqual(['cr-triage', 'cr-test']);
  });

  it('is a no-op for an unreferenced or unchanged id', () => {
    const d = doc();
    expect(renameAgentRefs(d, 'nobody', 'somebody').paths).toEqual([]);
    expect(renameAgentRefs(d, 'cr-intake', 'cr-intake').paths).toEqual([]);
    expect(d).toEqual(doc());
  });
});

describe('renameSkillRefs', () => {
  it('re-points the agents that declare it and the steps that narrow to it', () => {
    const d = doc();
    const edit = renameSkillRefs(d, 'qc', 'quality-control');

    expect((d.agents as any)[1].skills).toEqual(['quality-control', 'intake']);
    expect((d.pipelines as any)[0].steps[1].skills).toEqual(['quality-control']);
    expect(edit.paths).toEqual([
      'agents.cr-qc.skills',
      'pipelines.cr-squad.steps.cr-test.skills',
    ]);
  });

  it('rewrites the legacy singular `skill:` form', () => {
    const d = {
      agents: [{ id: 'a', skill: 'old' }],
      pipelines: [{ id: 'p', steps: [{ agent: 'a', skill: 'old' }] }],
    };
    renameSkillRefs(d, 'old', 'new');
    expect((d.agents as any)[0].skill).toBe('new');
    expect((d.pipelines as any)[0].steps[0].skill).toBe('new');
  });
});

describe('agentReferences / skillReferences — what a delete would strand', () => {
  it('names the steps and commands that would be left pointing at nothing', () => {
    const refs = agentReferences(doc(), 'cr-intake');
    expect(refs.paths).toEqual([
      'pipelines.cr-squad.steps.cr-intake',
      'slash_commands./cr-intake.agent',
    ]);
    expect(refs.messages[0]).toMatch(/still runs agent "cr-intake"/);
  });

  it('warns louder about a skill that is an agent\'s only one', () => {
    const refs = skillReferences(doc(), 'intake');
    // cr-intake declares only `intake`; the schema requires at least one, so
    // removing it would fail the whole workspace to load, not just dangle.
    expect(refs.messages.some((m) => /only skill/.test(m))).toBe(true);
    expect(refs.messages.some((m) => m === 'Agent "cr-qc" declares skill "intake".')).toBe(true);
  });

  it('reports nothing for an id no one references', () => {
    expect(agentReferences(doc(), 'ghost').paths).toEqual([]);
    expect(skillReferences(doc(), 'ghost').paths).toEqual([]);
  });
});

describe('unusedAfterStepRemoval', () => {
  it('names the agent, its skills and its commands once no step runs it', () => {
    const d = doc();
    // Simulate the removal of the only step on cr-qc.
    (d.pipelines as any)[0].steps.splice(1, 1);
    (d.slash_commands as any).push({ name: '/cr-test', agent: 'cr-qc' });

    expect(unusedAfterStepRemoval(d, 'cr-qc')).toEqual({
      agent: 'cr-qc',
      slashCommands: ['/cr-test'],
      skills: ['qc', 'intake'],
    });
  });

  it('stays quiet while another step still runs the agent', () => {
    const d = doc();
    (d.pipelines as any)[0].steps.push({ agent: 'cr-qc', name: 'cr-close' });
    (d.pipelines as any)[0].steps.splice(1, 1);

    expect(unusedAfterStepRemoval(d, 'cr-qc').agent).toBeNull();
  });
});
