import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listEpics } from '../src/v2/epicsList';

/**
 * A step may declare several `produces` entries, and the panel payload used
 * to carry only the first — so a step that writes a kickoff doc, a comparison
 * table, a diagrams folder and a parking lot had three of its four outputs
 * reachable only by typing their paths from memory.
 */
describe('listEpics per-step artifact list', () => {
  let root: string;
  const epicId = 'CR-1';
  const produces = [
    'docs/cr/{epic}/kickoff.md',
    'docs/cr/{epic}/comparison.md',
    'docs/cr/{epic}/diagrams/',
    'docs/cr/{epic}/parking-lot.md',
  ];

  const doc = {
    state: { root: 'docs/epics' },
    slash_commands: [],
    pipelines: [{ id: 'cr', steps: [{ agent: 'architect', name: 'cr-intake', produces }] }],
  } as unknown as Parameters<typeof listEpics>[1];

  const writeRun = (artifactsProduced: string[]) => {
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
        steps: [{ stepIdx: 0, agent: 'architect', revision: 1, status: 'approved', artifactsProduced }],
      }),
    );
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-artifacts-'));
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

    // Only two of the four outputs are on disk — the panel has to say so.
    const crDir = path.join(root, 'docs', 'cr', epicId);
    fs.mkdirSync(path.join(crDir, 'diagrams'), { recursive: true });
    fs.writeFileSync(path.join(crDir, 'kickoff.md'), '# Kickoff\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists every declared `produces` entry, path-resolved', () => {
    const step = listEpics(root, doc)[0].stepDetails[0];

    expect(step.artifacts.map((a) => a.path)).toEqual([
      `docs/cr/${epicId}/kickoff.md`,
      `docs/cr/${epicId}/comparison.md`,
      `docs/cr/${epicId}/diagrams/`,
      `docs/cr/${epicId}/parking-lot.md`,
    ]);
    expect(step.artifacts.map((a) => a.label)).toEqual([
      'kickoff.md',
      'comparison.md',
      'diagrams/',
      'parking-lot.md',
    ]);
  });

  it('marks a trailing-slash entry as a directory, and reports what is on disk', () => {
    const step = listEpics(root, doc)[0].stepDetails[0];
    const byLabel = Object.fromEntries(step.artifacts.map((a) => [a.label, a]));

    expect(byLabel['diagrams/'].isDirectory).toBe(true);
    expect(byLabel['diagrams/'].exists).toBe(true);
    expect(byLabel['kickoff.md'].isDirectory).toBe(false);
    expect(byLabel['kickoff.md'].exists).toBe(true);
    // Declared but never written — listed, so the user knows it is owed.
    expect(byLabel['comparison.md'].exists).toBe(false);
  });

  it('keeps the first entry as the headline artifact', () => {
    const step = listEpics(root, doc)[0].stepDetails[0];

    expect(step.artifact).toBe('kickoff.md');
    expect(step.artifactPath).toBe(`docs/cr/${epicId}/kickoff.md`);
  });

  it('prefers what the run recorded over what the pipeline declares', () => {
    // The step wrote one file the pipeline never mentions; that is the truth
    // about this run, so it wins over the declaration.
    writeRun([`docs/cr/${epicId}/kickoff.md`, `docs/cr/${epicId}/appendix.md`]);

    const step = listEpics(root, doc)[0].stepDetails[0];

    expect(step.artifacts.map((a) => a.label)).toEqual(['kickoff.md', 'appendix.md']);
  });

  it('falls back to the declaration when the run recorded nothing yet', () => {
    writeRun([]);

    const step = listEpics(root, doc)[0].stepDetails[0];

    expect(step.artifacts).toHaveLength(4);
  });
});

/**
 * A pipeline that cannot know its filenames in advance declares the folder
 * (`docs/cr/{epic}/diagrams/`). Listing only the folder left the documents
 * inside it reachable only through the explorer — the panel can open an
 * `.html` artifact itself, it just never had the path.
 */
describe('listEpics expands a produced folder', () => {
  let root: string;
  const epicId = 'CR-2';
  const doc = {
    state: { root: 'docs/epics' },
    slash_commands: [],
    pipelines: [{
      id: 'cr',
      steps: [{
        agent: 'dev',
        name: 'cr-build-spec',
        produces: ['docs/cr/{epic}/build-spec.md', 'docs/cr/{epic}/diagrams/'],
      }],
    }],
  } as unknown as Parameters<typeof listEpics>[1];

  const crDir = () => path.join(root, 'docs', 'cr', epicId);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-diagrams-'));
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
        stepStates: [{ agent: 'dev', name: 'cr-build-spec', status: 'in_progress' }],
      }),
    );
    fs.mkdirSync(path.join(crDir(), 'diagrams'), { recursive: true });
    fs.writeFileSync(path.join(crDir(), 'build-spec.md'), '# Spec\n');
    fs.writeFileSync(path.join(crDir(), 'diagrams', 'overview.html'), '<html></html>');
    fs.writeFileSync(path.join(crDir(), 'diagrams', 'build-spec.html'), '<html></html>');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists the files inside, keeping the folder itself first', () => {
    const step = listEpics(root, doc)[0].stepDetails[0];

    expect(step.artifacts.map((a) => a.label)).toEqual([
      'build-spec.md',
      'diagrams/',
      'diagrams/build-spec.html',
      'diagrams/overview.html',
    ]);
    const child = step.artifacts.find((a) => a.label === 'diagrams/overview.html')!;
    expect(child.path).toBe(`docs/cr/${epicId}/diagrams/overview.html`);
    expect(child.exists).toBe(true);
    expect(child.isDirectory).toBe(false);
  });

  it('leaves a folder that is not there yet alone', () => {
    fs.rmSync(path.join(crDir(), 'diagrams'), { recursive: true, force: true });

    const step = listEpics(root, doc)[0].stepDetails[0];

    expect(step.artifacts.map((a) => a.label)).toEqual(['build-spec.md', 'diagrams/']);
    expect(step.artifacts[1].exists).toBe(false);
  });

  it('skips dotfiles and sub-folders — one level, real files only', () => {
    fs.mkdirSync(path.join(crDir(), 'diagrams', 'src'));
    fs.writeFileSync(path.join(crDir(), 'diagrams', 'src', 'overview.mmd'), 'graph TD;');
    fs.writeFileSync(path.join(crDir(), 'diagrams', '.gitkeep'), '');

    const step = listEpics(root, doc)[0].stepDetails[0];

    expect(step.artifacts.map((a) => a.label)).toEqual([
      'build-spec.md',
      'diagrams/',
      'diagrams/build-spec.html',
      'diagrams/overview.html',
    ]);
  });

  it('does not list a file twice when it is also declared on its own', () => {
    const withBoth = {
      ...(doc as object),
      pipelines: [{
        id: 'cr',
        steps: [{
          agent: 'dev',
          name: 'cr-build-spec',
          produces: [
            'docs/cr/{epic}/build-spec.md',
            'docs/cr/{epic}/diagrams/',
            'docs/cr/{epic}/diagrams/overview.html',
          ],
        }],
      }],
    } as unknown as Parameters<typeof listEpics>[1];

    const step = listEpics(root, withBoth)[0].stepDetails[0];

    expect(step.artifacts.filter((a) => a.label.endsWith('overview.html'))).toHaveLength(1);
  });
});
