import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listEpics } from '../src/v2/epicsList';

/**
 * Which slash command the panel's "Run with Claude" button sends.
 *
 * The bug this covers: the resolver only ever tried `/<pipelineId>-<stepName>`
 * and `/<stepName>`, then *defaulted* to the namespaced form. An epic that
 * owns its pipeline has `pipelineId === <epic id>`, so the default spelled
 * `/CR-Y01-cr-solo-dev` — a command that cannot exist without a fresh command
 * file per epic. Claude answered "Unknown command: /CR-Y01-cr-solo-dev ·
 * Args from unknown skill: CR-Y01". The epic id is an argument, not part of
 * the name, and the step's own `skills:` already names the right file.
 */
let root: string;

function writeEpic(epicId: string, pipeline: string, steps: Array<{ agent: string }>): void {
  const epicDir = path.join(root, 'docs', 'epics', epicId);
  fs.mkdirSync(epicDir, { recursive: true });
  fs.writeFileSync(
    path.join(epicDir, 'state.json'),
    JSON.stringify({
      id: epicId,
      title: epicId,
      pipeline,
      currentStep: 0,
      status: 'in_progress',
      stepStates: steps.map((s) => ({ agent: s.agent, status: 'pending' })),
    }),
  );
}

const asDoc = (d: unknown) => d as Parameters<typeof listEpics>[1];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-slash-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('slash command for a step', () => {
  it('uses the step\'s skill when the pipeline is the epic\'s own', () => {
    writeEpic('CR-Y01', 'CR-Y01', [{ agent: 'cr-solo-dev' }]);
    const epics = listEpics(root, asDoc({
      state: { root: 'docs/epics' },
      slash_commands: [{ name: '/cr-solo-dev', agent: 'cr-solo-dev' }],
      pipelines: [{
        id: 'CR-Y01',
        steps: [{ agent: 'cr-solo-dev', name: 'cr-solo-dev', skills: ['cr-solo-dev'] }],
      }],
    }));
    expect(epics[0].stepDetails[0].slashCommand).toBe('/cr-solo-dev');
  });

  it('never namespaces the epic id into the command name', () => {
    // Step name differs from the skill, and nothing is registered under
    // either name — the old code returned `/CR-Y02-solo-dev` here.
    writeEpic('CR-Y02', 'CR-Y02', [{ agent: 'cr-solo-dev' }]);
    const epics = listEpics(root, asDoc({
      state: { root: 'docs/epics' },
      slash_commands: [],
      pipelines: [{
        id: 'CR-Y02',
        steps: [{ agent: 'cr-solo-dev', name: 'solo-dev', skills: ['cr-solo-query'] }],
      }],
    }));
    expect(epics[0].stepDetails[0].slashCommand).toBe('/cr-solo-query');
  });

  it('still prefers a registered pipeline-namespaced command', () => {
    // Built-in workflows install `/ai-native-full-spec` and carry a skill id
    // (`aidlc-spec`) that is not a command — the namespaced name must win.
    writeEpic('EPIC-1', 'ai-native-full', [{ agent: 'aidlc-native-product-owner' }]);
    const epics = listEpics(root, asDoc({
      state: { root: 'docs/epics' },
      slash_commands: [{ name: '/ai-native-full-spec' }],
      pipelines: [{
        id: 'ai-native-full',
        steps: [{ agent: 'aidlc-native-product-owner', name: 'spec', skills: ['aidlc-spec'] }],
      }],
    }));
    expect(epics[0].stepDetails[0].slashCommand).toBe('/ai-native-full-spec');
  });

  it('still falls back to a bare registered command', () => {
    writeEpic('EPIC-2', 'pl', [{ agent: 'dev' }]);
    const epics = listEpics(root, asDoc({
      state: { root: 'docs/epics' },
      slash_commands: [{ name: '/implement' }],
      pipelines: [{ id: 'pl', steps: [{ agent: 'dev', name: 'implement' }] }],
    }));
    expect(epics[0].stepDetails[0].slashCommand).toBe('/implement');
  });

  it('still reaches the source pipeline of a recipe-assembled epic', () => {
    // `SWIFT-142` is assembled from `sdlc-parallel-full`; only the source
    // pipeline's command files exist, and the step declares no skill.
    writeEpic('SWIFT-142', 'SWIFT-142', [{ agent: 'dev' }]);
    const epics = listEpics(root, asDoc({
      state: { root: 'docs/epics' },
      slash_commands: [{ name: '/sdlc-parallel-full-implement' }],
      pipelines: [
        { id: 'sdlc-parallel-full', steps: [{ agent: 'dev', name: 'implement' }] },
        { id: 'SWIFT-142', steps: [{ agent: 'dev', name: 'implement' }] },
      ],
    }));
    expect(epics[0].stepDetails[0].slashCommand).toBe('/sdlc-parallel-full-implement');
  });
});
