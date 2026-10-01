import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { invalidateEpicListing, listEpicsCached } from '../src/v2/epicsList';

const doc = {
  state: { root: 'docs/epics' },
  pipelines: [{ id: 'pl', steps: [{ agent: 'po', name: 'plan', produces: ['out/{epic}/PLAN.md'] }] }],
} as unknown as Parameters<typeof listEpicsCached>[1];

let root: string;

function writeEpic(id: string, title: string): void {
  const dir = path.join(root, 'docs', 'epics', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    id, title, pipeline: 'pl', currentStep: 0, status: 'in_progress',
    stepStates: [{ agent: 'po', status: 'in_progress' }],
  }));
}

function writeRun(id: string, status: string): void {
  fs.mkdirSync(path.join(root, '.aidlc', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aidlc', 'runs', `${id}.json`), JSON.stringify({
    schemaVersion: 1, runId: id, pipelineId: 'pl', context: { epic: id },
    startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    currentStepIdx: 0, status: 'running',
    steps: [{ stepIdx: 0, agent: 'po', revision: 1, status, artifactsProduced: [] }],
  }));
}

const byId = (id: string) => listEpicsCached(root, doc).find((e) => e.id === id)!;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-listing-'));
  writeEpic('E1', 'one');
  writeEpic('E2', 'two');
  writeRun('E1', 'awaiting_work');
  invalidateEpicListing();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listEpicsCached', () => {
  it('serves an epic from cache until a change it depends on is reported', () => {
    expect(byId('E1').title).toBe('one');
    writeEpic('E1', 'renamed');
    expect(byId('E1').title).toBe('one');

    invalidateEpicListing(path.join(root, 'docs', 'epics', 'E1', 'state.json'));
    expect(byId('E1').title).toBe('renamed');
  });

  it('re-reads an epic when its run file is reported', () => {
    expect(byId('E1').stepDetails[0].runStatus).toBe('awaiting_work');
    writeRun('E1', 'awaiting_review');
    invalidateEpicListing(path.join(root, 'docs', 'unrelated.md'));
    expect(byId('E1').stepDetails[0].runStatus).toBe('awaiting_work');

    invalidateEpicListing(path.join(root, '.aidlc', 'runs', 'E1.json'));
    expect(byId('E1').stepDetails[0].runStatus).toBe('awaiting_review');
  });

  it('re-reads an epic when an artifact it declares outside its folder appears', () => {
    expect(byId('E2').stepDetails[0].artifactExists).toBe(false);
    const artifact = path.join(root, 'out', 'E2', 'PLAN.md');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, '# plan');
    expect(byId('E2').stepDetails[0].artifactExists).toBe(false);

    invalidateEpicListing(artifact);
    expect(byId('E2').stepDetails[0].artifactExists).toBe(true);
  });

  it('picks up a new epic folder without being told', () => {
    expect(listEpicsCached(root, doc)).toHaveLength(2);
    writeEpic('E3', 'three');
    expect(listEpicsCached(root, doc).map((e) => e.id)).toContain('E3');
  });

  it('hands out copies, so filling one listing in leaves the next alone', () => {
    const first = byId('E1');
    first.tokenUsage = { total: { cost: 1, totalTokens: 1, calls: 1 }, steps: [], hasOverlap: false, computedAt: 0 };
    first.stepDetails[0].status = 'failed';
    expect(byId('E1').tokenUsage).toBeUndefined();
    expect(byId('E1').stepDetails[0].status).not.toBe('failed');
  });
});
