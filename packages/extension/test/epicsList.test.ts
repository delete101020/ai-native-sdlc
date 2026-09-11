import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { epicPinningPipeline, listEpics } from '../src/v2/epicsList';

/**
 * Regression coverage for issue #57: a step showed "IN PROGRESS" with no
 * "Mark step done" affordance because the run-state overlay was keyed by
 * agent id. When one persona (e.g. `qa`) owns several pipeline steps, the
 * last-writer-wins map collapsed them, so a mid-pipeline `awaiting_work`
 * step inherited a trailing step's `pending` status and lost its button.
 * The overlay is now keyed by step index.
 */
describe('listEpics run-state overlay with a multi-step agent', () => {
  let root: string;
  const epicId = 'EPIC-1';

  const doc = {
    state: { root: 'docs/epics' },
    slash_commands: [{ name: '/pl-test-plan' }],
    pipelines: [
      {
        id: 'pl',
        steps: [
          { agent: 'po', name: 'plan' },
          { agent: 'arch', name: 'design' },
          { agent: 'qa', name: 'test-plan', produces: ['docs/{epic}/TEST-PLAN.md'] },
          { agent: 'qa', name: 'generate-test-cases' },
          { agent: 'qa', name: 'execute-test' },
        ],
      },
    ],
  } as unknown as Parameters<typeof listEpics>[1];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-epicslist-'));
    const epicDir = path.join(root, 'docs', 'epics', epicId);
    fs.mkdirSync(epicDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.aidlc', 'runs'), { recursive: true });

    fs.writeFileSync(
      path.join(epicDir, 'state.json'),
      JSON.stringify({
        id: epicId,
        title: 'Test',
        pipeline: 'pl',
        currentStep: 2,
        status: 'in_progress',
        stepStates: [
          { agent: 'po', status: 'done' },
          { agent: 'arch', status: 'done' },
          { agent: 'qa', status: 'in_progress' },
          { agent: 'qa', status: 'pending' },
          { agent: 'qa', status: 'pending' },
        ],
      }),
    );

    const mkStep = (stepIdx: number, agent: string, status: string) => ({
      stepIdx,
      agent,
      revision: 1,
      status,
      artifactsProduced: [],
    });
    fs.writeFileSync(
      path.join(root, '.aidlc', 'runs', `${epicId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        runId: epicId,
        pipelineId: 'pl',
        context: { epic: epicId },
        startedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        currentStepIdx: 2,
        status: 'running',
        steps: [
          mkStep(0, 'po', 'approved'),
          mkStep(1, 'arch', 'approved'),
          mkStep(2, 'qa', 'awaiting_work'),
          mkStep(3, 'qa', 'pending'),
          mkStep(4, 'qa', 'pending'),
        ],
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves each repeated-agent step independently by index', () => {
    const epic = listEpics(root, doc).find((e) => e.id === epicId);
    expect(epic).toBeDefined();
    const steps = epic!.stepDetails;

    // The genuinely-active qa step keeps its actionable status (drives the
    // "Mark step done" button) instead of inheriting a trailing qa step.
    expect(steps[2].agent).toBe('qa');
    expect(steps[2].runStatus).toBe('awaiting_work');
    expect(steps[2].isCurrentRunStep).toBe(true);

    // Later qa steps stay pending and are not flagged current.
    expect(steps[3].runStatus).toBe('pending');
    expect(steps[4].runStatus).toBe('pending');
    expect(steps[3].isCurrentRunStep).toBe(false);
    expect(steps[4].isCurrentRunStep).toBe(false);

    // Earlier single-agent steps are unaffected.
    expect(steps[0].runStatus).toBe('approved');
    expect(steps[1].runStatus).toBe('approved');
  });
});

/**
 * Coverage for the artifacts-only fallback: a folder with no `state.json`
 * (no pipeline binding) is no longer silently skipped — it's synthesized into
 * an epic straight from the `.md` files in its `artifacts/` folder, mirroring
 * cf-aidlc-dashboard's `pipelineId: 'artifacts'` behavior.
 */
describe('listEpics artifacts-only fallback (no state.json)', () => {
  let root: string;

  const write = (rel: string, body: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-epicslist-artifacts-'));
    // An epic folder with artifacts but NO state.json, in lifecycle-shuffled order.
    write('docs/epics/LOOSE-1/artifacts/TECH-DESIGN.md', '---\nstatus: draft\n---\n# Design\n');
    write('docs/epics/LOOSE-1/artifacts/PRD.md', '---\nstatus: approved\n---\n# PRD\n');
    write('docs/epics/LOOSE-1/artifacts/.annotation-history.json', '{}');
    // A folder with neither state.json nor artifacts — must stay skipped.
    fs.mkdirSync(path.join(root, 'docs', 'epics', 'EMPTY'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('synthesizes an epic from artifact .md files, ordered by lifecycle', () => {
    const epics = listEpics(root, { state: { root: 'docs/epics' } } as unknown as Parameters<typeof listEpics>[1]);

    // The empty folder is skipped; only the artifacts-bearing one appears.
    expect(epics.map((e) => e.id)).toEqual(['LOOSE-1']);

    const epic = epics[0];
    expect(epic.artifactsOnly).toBe(true);
    expect(epic.pipeline).toBeNull();
    expect(epic.statePath).toBe('');

    // PRD sorts before TECH-DESIGN (lifecycle), dotfiles are excluded.
    expect(epic.stepDetails.map((s) => s.artifact)).toEqual(['PRD.md', 'TECH-DESIGN.md']);

    // Status is read from each artifact's own frontmatter.
    expect(epic.stepDetails[0].status).toBe('done');       // approved
    expect(epic.stepDetails[1].status).toBe('in_progress'); // draft
    expect(epic.status).toBe('in_progress');
  });
});

/**
 * `aidlc epic start` materialises a per-epic pipeline in workspace.yaml plus
 * two positional step arrays (state.json's `stepStates`, the run file's
 * `steps`). Neither of those records a step *name*, so reshaping the pipeline
 * moves history onto the wrong steps — and silently, because the runner only
 * checks that an index is still inside the array. `epicPinningPipeline` is
 * what the webview and the mutation handlers use to refuse that edit.
 */
describe('epicPinningPipeline', () => {
  const epic = (
    id: string,
    pipeline: string | null,
    artifactsOnly?: boolean,
  ) => ({ id, pipeline, ...(artifactsOnly === undefined ? {} : { artifactsOnly }) });

  it('finds the epic running against a pipeline', () => {
    const epics = [epic('EPIC-001', 'EPIC-001'), epic('EPIC-002', 'ai-native-full')];
    expect(epicPinningPipeline(epics, 'EPIC-001')?.id).toBe('EPIC-001');
    // A shared workflow is pinned too — an epic started straight off
    // `ai-native-full` indexes into it exactly the same way.
    expect(epicPinningPipeline(epics, 'ai-native-full')?.id).toBe('EPIC-002');
  });

  it('leaves a pipeline no epic runs against free to edit', () => {
    expect(epicPinningPipeline([epic('EPIC-001', 'EPIC-001')], 'sdlc-full')).toBeNull();
    expect(epicPinningPipeline([], 'EPIC-001')).toBeNull();
    expect(epicPinningPipeline([epic('EPIC-001', 'EPIC-001')], '')).toBeNull();
  });

  it('ignores an artifacts-only epic — it has no state.json to desync', () => {
    expect(epicPinningPipeline([epic('LOOSE-1', 'p', true)], 'p')).toBeNull();
  });
});

/**
 * A pipeline whose artifacts live outside the epic folder — a document
 * pipeline writing to `docs/snp/`, say.
 *
 * The panel used to answer "has this step produced its artifact?" by looking
 * for the basename in `docs/epics/<id>/artifacts/`, which such a pipeline
 * never writes to. Every step therefore read as missing and *Mark step done*
 * stayed disabled forever, even though `markStepDone` resolves `produces`
 * against the workspace root and would have accepted it.
 */
describe('listEpics artifact existence for produces outside the epic folder', () => {
  let root: string;
  const epicId = 'SNP-1';

  const doc = {
    state: { root: 'docs/epics' },
    slash_commands: [],
    pipelines: [
      {
        id: 'snp',
        steps: [
          { agent: 'registrar', name: 'intake', produces: ['docs/snp/00-source-register.md'] },
          { agent: 'analyst', name: 'align', produces: ['docs/snp/analysis/{topic}.md'] },
        ],
      },
    ],
  } as unknown as Parameters<typeof listEpics>[1];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-epicslist-outside-'));
    const epicDir = path.join(root, 'docs', 'epics', epicId);
    fs.mkdirSync(epicDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.aidlc', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs', 'snp'), { recursive: true });
    // Step 0's artifact exists on disk; step 1's does not.
    fs.writeFileSync(path.join(root, 'docs', 'snp', '00-source-register.md'), '# sổ nguồn\n');

    fs.writeFileSync(
      path.join(epicDir, 'state.json'),
      JSON.stringify({
        id: epicId,
        title: 'Doc alignment',
        pipeline: 'snp',
        currentStep: 0,
        status: 'in_progress',
        stepStates: [
          { agent: 'registrar', status: 'in_progress' },
          { agent: 'analyst', status: 'pending' },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(root, '.aidlc', 'runs', `${epicId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        runId: epicId,
        pipelineId: 'snp',
        context: { epic: epicId, topic: 'container-stowage-rules' },
        startedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        currentStepIdx: 0,
        status: 'running',
        steps: [
          { stepIdx: 0, agent: 'registrar', revision: 1, status: 'awaiting_work', artifactsProduced: [] },
          { stepIdx: 1, agent: 'analyst', revision: 1, status: 'pending', artifactsProduced: [] },
        ],
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports the produced file as present even though the epic folder is empty', () => {
    const epic = listEpics(root, doc).find((e) => e.id === epicId);
    expect(epic).toBeDefined();
    // docs/epics/SNP-1/artifacts/ was never created — the old basename lookup
    // had nothing to find here.
    expect(fs.existsSync(path.join(root, 'docs', 'epics', epicId, 'artifacts'))).toBe(false);

    const step = epic!.stepDetails[0];
    expect(step.artifact).toBe('00-source-register.md');
    expect(step.artifactPath).toBe('docs/snp/00-source-register.md');
    expect(step.artifactExists).toBe(true);
  });

  it('resolves placeholders from the run context and reports a missing file as missing', () => {
    const epic = listEpics(root, doc).find((e) => e.id === epicId);
    const step = epic!.stepDetails[1];

    // The label is taken off the resolved path — the raw `produces` basename
    // would put a literal `{topic}.md` on the card.
    expect(step.artifact).toBe('container-stowage-rules.md');
    expect(step.artifactPath).toBe('docs/snp/analysis/container-stowage-rules.md');
    expect(step.artifactExists).toBe(false);
    expect(step.artifactStale).toBe(false);
  });

  it('flags an artifact older than the step as inherited, not produced here', () => {
    // Step 1 opens now; its output file was written a day ago by an earlier
    // step that declares the same `produces` path.
    const analysis = path.join(root, 'docs', 'snp', 'analysis', 'container-stowage-rules.md');
    fs.mkdirSync(path.dirname(analysis), { recursive: true });
    fs.writeFileSync(analysis, '# phân tích\n');
    const old = new Date('2025-12-31T00:00:00Z');
    fs.utimesSync(analysis, old, old);

    const runPath = path.join(root, '.aidlc', 'runs', `${epicId}.json`);
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    run.currentStepIdx = 1;
    run.steps[0].status = 'approved';
    run.steps[1].status = 'awaiting_work';
    run.steps[1].startedAt = '2026-01-01T00:00:00Z';
    fs.writeFileSync(runPath, JSON.stringify(run));

    const epic = listEpics(root, doc).find((e) => e.id === epicId);
    const step = epic!.stepDetails[1];
    expect(step.artifactExists).toBe(true);
    expect(step.artifactStale).toBe(true);

    // Touching it after the step started clears the flag.
    const fresh = new Date('2026-01-02T00:00:00Z');
    fs.utimesSync(analysis, fresh, fresh);
    const after = listEpics(root, doc).find((e) => e.id === epicId);
    expect(after!.stepDetails[1].artifactStale).toBe(false);
  });
});
