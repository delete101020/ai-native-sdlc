import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listEpics } from '../src/v2/epicsList';

/**
 * A `{ path, optional: true }` entry is output the step writes only sometimes.
 * The panel has to list it either way — present, it opens; absent, it says
 * "optional" rather than "not produced yet" — and must never let it be the
 * headline that holds *Mark step done* back.
 */
describe('listEpics — optional produces entries', () => {
  let root: string;
  const epicId = 'CR-1';
  const overview = `docs/cr/${epicId}/diagrams/overview.html`;
  const business = `docs/cr/${epicId}/business.md`;

  const docWith = (produces: unknown[]) => ({
    state: { root: 'docs/epics' },
    slash_commands: [],
    pipelines: [{ id: 'cr', steps: [{ agent: 'architect', name: 'cr-intake', produces }] }],
  } as unknown as Parameters<typeof listEpics>[1]);

  const writeRun = (status: string, artifactsProduced: string[]) => {
    fs.mkdirSync(path.join(root, '.aidlc', 'runs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.aidlc', 'runs', `${epicId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        runId: epicId,
        pipelineId: 'cr',
        context: { epic: epicId },
        startedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        currentStepIdx: 0,
        status: 'running',
        steps: [{ stepIdx: 0, agent: 'architect', revision: 1, status, artifactsProduced }],
      }),
    );
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-optional-artifacts-'));
    const epicDir = path.join(root, 'docs', 'epics', epicId);
    fs.mkdirSync(epicDir, { recursive: true });
    fs.writeFileSync(
      path.join(epicDir, 'state.json'),
      JSON.stringify({
        id: epicId,
        title: 'CR',
        pipeline: 'cr',
        currentStep: 0,
        status: 'in_progress',
        stepStates: [{ agent: 'architect', status: 'in_progress' }],
      }),
    );
    fs.mkdirSync(path.join(root, 'docs', 'cr', epicId), { recursive: true });
    fs.writeFileSync(path.join(root, business), '# Business\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists an absent optional entry, flagged optional', () => {
    const step = listEpics(root, docWith([business.replace(epicId, '{epic}'), { path: 'docs/cr/{epic}/diagrams/overview.html', optional: true }]))[0].stepDetails[0];
    expect(step.artifacts).toEqual([
      expect.objectContaining({ path: business, exists: true }),
      expect.objectContaining({ path: overview, exists: false, optional: true }),
    ]);
    expect(step.artifacts[0].optional).toBeUndefined();
  });

  it('picks the first required entry as the headline, even when an optional one is listed first', () => {
    const step = listEpics(root, docWith([{ path: 'docs/cr/{epic}/diagrams/overview.html', optional: true }, 'docs/cr/{epic}/business.md']))[0].stepDetails[0];
    expect(step.artifactPath).toBe(business);
    expect(step.artifactOptional).toBeUndefined();
  });

  it('marks the headline optional when the step declares nothing else', () => {
    const step = listEpics(root, docWith([{ path: 'docs/cr/{epic}/diagrams/overview.html', optional: true }]))[0].stepDetails[0];
    expect(step.artifactPath).toBe(overview);
    expect(step.artifactExists).toBe(false);
    expect(step.artifactOptional).toBe(true);
  });

  it('keeps an optional entry the finished step did not write in the list', () => {
    // markStepDone leaves an absent optional entry out of artifactsProduced.
    writeRun('approved', [business]);
    const step = listEpics(root, docWith(['docs/cr/{epic}/business.md', { path: 'docs/cr/{epic}/diagrams/overview.html', optional: true }]))[0].stepDetails[0];
    expect(step.artifacts.map((a) => [a.path, a.exists, !!a.optional])).toEqual([
      [business, true, false],
      [overview, false, true],
    ]);
  });

  it('shows a written optional entry as present, once', () => {
    fs.mkdirSync(path.join(root, 'docs', 'cr', epicId, 'diagrams'), { recursive: true });
    fs.writeFileSync(path.join(root, overview), '<html></html>');
    writeRun('approved', [business, overview]);
    const step = listEpics(root, docWith(['docs/cr/{epic}/business.md', { path: 'docs/cr/{epic}/diagrams/overview.html', optional: true }]))[0].stepDetails[0];
    expect(step.artifacts.map((a) => [a.path, a.exists, !!a.optional])).toEqual([
      [business, true, false],
      [overview, true, true],
    ]);
  });
});
