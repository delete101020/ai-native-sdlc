/**
 * Epic-owned pipelines: `docs/epics/<id>/pipeline.yaml` instead of a block in
 * the shared `.aidlc/workspace.yaml`.
 *
 * The property that matters is round-tripping: a caller that reads a document,
 * mutates `doc.pipelines` and writes it back must never notice that some of
 * those pipelines came from elsewhere — and must never leave a second copy of
 * one behind in the shared file.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

import {
  mergeEpicPipelines,
  splitEpicPipelines,
  writeEpicPipelines,
  stageEpicPipeline,
  epicOwningPipeline,
  planEpicPipelineExtraction,
  epicPipelineReport,
  epicPipelinePath,
} from '../src';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-epic-pipe-'));
});

/** A document shaped like the one yamlIO hands around. */
function doc(pipelines: Array<Record<string, unknown>> = []): {
  pipelines: Array<Record<string, unknown>>;
  state?: unknown;
} {
  return { pipelines };
}

function writeEpic(epicId: string, files: Record<string, string>): void {
  const dir = path.join(root, 'docs', 'epics', epicId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }
}

const STEP = { agent: 'writer', name: 'intent', enabled: true, produces: [], requires: [] };

describe('mergeEpicPipelines', () => {
  it('splices each epic pipeline file into the document', () => {
    writeEpic('EPIC-001', { 'pipeline.yaml': yaml.dump({ id: 'EPIC-001', steps: [STEP] }) });
    writeEpic('EPIC-002', { 'pipeline.yaml': yaml.dump({ id: 'EPIC-002', steps: [STEP] }) });
    const d = doc([{ id: 'ai-native-full', steps: [STEP] }]);

    const report = mergeEpicPipelines(root, d);

    expect(report.merged).toEqual(['EPIC-001', 'EPIC-002']);
    expect(d.pipelines.map((p) => p.id)).toEqual(['ai-native-full', 'EPIC-001', 'EPIC-002']);
    expect(epicOwningPipeline(d, 'EPIC-002')).toBe('EPIC-002');
    // The shared pipeline was not adopted by anyone.
    expect(epicOwningPipeline(d, 'ai-native-full')).toBeUndefined();
  });

  it('is a no-op when there are no epics yet', () => {
    const d = doc([{ id: 'ai-native-full', steps: [STEP] }]);
    expect(mergeEpicPipelines(root, d).merged).toEqual([]);
    expect(d.pipelines).toHaveLength(1);
  });

  it('names a file after its directory when the file omits an id', () => {
    writeEpic('EPIC-007', { 'pipeline.yaml': yaml.dump({ steps: [STEP] }) });
    const d = doc();
    mergeEpicPipelines(root, d);
    expect(d.pipelines[0].id).toBe('EPIC-007');
  });

  it('lets the epic file win over an inline copy, and reports the clash', () => {
    writeEpic('EPIC-001', {
      'pipeline.yaml': yaml.dump({ id: 'EPIC-001', steps: [{ ...STEP, name: 'from-file' }] }),
    });
    const d = doc([{ id: 'EPIC-001', steps: [{ ...STEP, name: 'inline' }] }]);

    const report = mergeEpicPipelines(root, d);

    expect(d.pipelines).toHaveLength(1);
    expect((d.pipelines[0].steps as Array<{ name: string }>)[0].name).toBe('from-file');
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].pipelineId).toBe('EPIC-001');
  });

  it('reports an unparseable file instead of throwing the whole load away', () => {
    writeEpic('EPIC-009', { 'pipeline.yaml': 'steps: [\n  - broken' });
    const d = doc();
    const report = mergeEpicPipelines(root, d);
    expect(report.merged).toEqual([]);
    expect(report.unreadable).toHaveLength(1);
    expect(epicPipelineReport(d)).toBe(report);
  });
});

describe('splitEpicPipelines', () => {
  it('routes an epic-owned pipeline out and leaves the rest inline', () => {
    const d = doc([{ id: 'ai-native-full', steps: [STEP] }, { id: 'EPIC-001', steps: [STEP] }]);
    stageEpicPipeline(d, 'EPIC-001', 'EPIC-001');

    const split = splitEpicPipelines(root, d);

    expect(split.inline.map((p) => p.id)).toEqual(['ai-native-full']);
    expect(split.external).toHaveLength(1);
    expect(split.external[0].file).toBe(epicPipelinePath(root, d, 'EPIC-001'));
  });

  it('round-trips: what is written out is what is read back in', () => {
    const d = doc([{ id: 'EPIC-001', derived_from: 'ai-native-full', steps: [STEP] }]);
    stageEpicPipeline(d, 'EPIC-001', 'EPIC-001');
    writeEpicPipelines(splitEpicPipelines(root, d).external);

    const reread = doc();
    mergeEpicPipelines(root, reread);
    expect(reread.pipelines).toEqual(d.pipelines);
  });

  it('keeps a pipeline inline when nobody staged it', () => {
    const d = doc([{ id: 'EPIC-001', steps: [STEP] }]);
    const split = splitEpicPipelines(root, d);
    expect(split.external).toEqual([]);
    expect(split.inline).toHaveLength(1);
  });
});

describe('planEpicPipelineExtraction', () => {
  it('takes the pipeline assembled for an epic, and only that one', () => {
    writeEpic('EPIC-001', { 'state.json': JSON.stringify({ id: 'EPIC-001', pipeline: 'EPIC-001' }) });
    // EPIC-002 was started on the shared base pipeline. It names it, but it
    // does not own it — moving it into docs/epics/EPIC-002/ would take it away
    // from everyone else.
    writeEpic('EPIC-002', { 'state.json': JSON.stringify({ id: 'EPIC-002', pipeline: 'ai-native-full' }) });
    const d = doc([{ id: 'ai-native-full', steps: [STEP] }, { id: 'EPIC-001', steps: [STEP] }]);

    const plan = planEpicPipelineExtraction(root, d);

    expect(plan.map((x) => x.pipelineId)).toEqual(['EPIC-001']);
  });

  it('takes the <epic>-<recipe> fallback id too', () => {
    writeEpic('EPIC-003', { 'state.json': JSON.stringify({ pipeline: 'EPIC-003-native-lite' }) });
    const d = doc([{ id: 'EPIC-003-native-lite', steps: [STEP] }]);
    expect(planEpicPipelineExtraction(root, d).map((x) => x.epicId)).toEqual(['EPIC-003']);
  });

  it('leaves a pipeline two epics share in the workspace file', () => {
    writeEpic('EPIC-001', { 'state.json': JSON.stringify({ pipeline: 'shared' }) });
    writeEpic('EPIC-002', { 'state.json': JSON.stringify({ pipeline: 'shared' }) });
    const d = doc([{ id: 'shared', steps: [STEP] }]);

    expect(planEpicPipelineExtraction(root, d)).toEqual([]);
  });

  it('skips an epic that already has its own file', () => {
    writeEpic('EPIC-001', {
      'state.json': JSON.stringify({ pipeline: 'EPIC-001' }),
      'pipeline.yaml': yaml.dump({ id: 'EPIC-001', steps: [STEP] }),
    });
    expect(planEpicPipelineExtraction(root, doc([{ id: 'EPIC-001', steps: [STEP] }]))).toEqual([]);
  });
});

describe('writeEpicPipelines', () => {
  it('leaves a file alone when its pipeline is unchanged, comments and all', () => {
    // Every read splices *all* epic pipelines into the document, so any command
    // that saves workspace.yaml for its own reasons hands us every epic's file
    // back. Rewriting them all would replace whatever their authors wrote with
    // the generated header — an unexplained `git status` entry per epic.
    const d = doc([{ id: 'EPIC-001', steps: [STEP] }]);
    stageEpicPipeline(d, 'EPIC-001', 'EPIC-001');
    const external = splitEpicPipelines(root, d).external;
    writeEpicPipelines(external);

    const file = epicPipelinePath(root, d, 'EPIC-001');
    const annotated =
      '# Why this epic skips the spec step: the incident loop measures first.\n'
      + fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, annotated, 'utf8');

    writeEpicPipelines(external);

    expect(fs.readFileSync(file, 'utf8')).toBe(annotated);
  });

  it('writes when the pipeline actually changed', () => {
    const d = doc([{ id: 'EPIC-001', steps: [STEP] }]);
    stageEpicPipeline(d, 'EPIC-001', 'EPIC-001');
    writeEpicPipelines(splitEpicPipelines(root, d).external);
    const file = epicPipelinePath(root, d, 'EPIC-001');

    const changed = doc([{ id: 'EPIC-001', steps: [STEP, { agent: 'reviewer' }] }]);
    stageEpicPipeline(changed, 'EPIC-001', 'EPIC-001');
    writeEpicPipelines(splitEpicPipelines(root, changed).external);

    const onDisk = yaml.load(fs.readFileSync(file, 'utf8')) as { steps: unknown[] };
    expect(onDisk.steps).toHaveLength(2);
  });

  it('rewrites a file that is missing or unparseable — that is the repair path', () => {
    const d = doc([{ id: 'EPIC-001', steps: [STEP] }]);
    stageEpicPipeline(d, 'EPIC-001', 'EPIC-001');
    const external = splitEpicPipelines(root, d).external;
    writeEpicPipelines(external);

    const file = epicPipelinePath(root, d, 'EPIC-001');
    fs.writeFileSync(file, 'steps: [oh no: {{{', 'utf8');
    writeEpicPipelines(external);

    const onDisk = yaml.load(fs.readFileSync(file, 'utf8')) as { id: string };
    expect(onDisk.id).toBe('EPIC-001');
  });
});
