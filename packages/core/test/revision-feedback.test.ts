/**
 * A rerun run headless — `run exec`, "Run to completion" — has to be told why
 * it is running again. It used to get the context pairs and nothing else, so
 * revision 2 ran blind. See AUTOPILOT_READINESS.md §G3.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRun,
  runExecLoop,
  markStepDone,
  rejectStep,
  rerunStep,
  composeAgentPrompt,
  RunStateStore,
  WorkspaceLoader,
} from '../src/index';
import type { PipelineConfig, RunState } from '../src/index';
import { revisionFeedback } from '../src/runs/revisionFeedback';

const pipeline = {
  id: 'p',
  steps: [{ agent: 'dev', human_review: true }, { agent: 'rev', human_review: true }],
  on_failure: 'stop',
} as PipelineConfig;

function done(s: RunState): RunState {
  return markStepDone({ state: s, pipeline, workspaceRoot: os.tmpdir() });
}

/** dev done, rejected in place with `reason`, rerun with `feedback`. */
function inPlace(reason?: string, feedback?: string): RunState {
  let s = startRun({ runId: 'R', pipeline, context: {} });
  s = rejectStep({ state: done(s), pipeline, reason });
  return rerunStep({ state: s, feedback });
}

/** dev approved, rev done, rev sends the work back to dev with `reason`. */
function sentBack(reason: string): RunState {
  let s = startRun({ runId: 'R', pipeline, context: {} });
  s = { ...done(s) };
  s.steps[0].status = 'approved';
  s.currentStepIdx = 1;
  s.steps[1].status = 'awaiting_work';
  s = done(s);
  return rejectStep({ state: s, pipeline, reason, targetIdx: 0 });
}

describe('revisionFeedback', () => {
  it('says nothing on a first run', () => {
    expect(revisionFeedback(startRun({ runId: 'R', pipeline, context: {} }), 0)).toBeNull();
  });

  it('leads with an in-place rejection reason', () => {
    expect(revisionFeedback(inPlace('tests missing'), 0)).toBe(
      'Revision 2. Address before anything else:\n- Rejected at step 1 (dev): tests missing',
    );
  });

  it('adds feedback given at rerun after the reason', () => {
    expect(revisionFeedback(inPlace('tests missing', 'cover the empty list'), 0)).toBe(
      'Revision 2. Address before anything else:\n'
      + '- Rejected at step 1 (dev): tests missing\n'
      + '- cover the empty list',
    );
  });

  it('passes a send-back on once, through the feedback it set', () => {
    const s = sentBack('null check on line 4');
    expect(s.currentStepIdx).toBe(0);
    expect(revisionFeedback(s, 0)).toBe(
      'Revision 2. Address before anything else:\n- Rejected at step 2 (rev): null check on line 4',
    );
  });

  it('does not repeat a reason the feedback already holds', () => {
    expect(revisionFeedback(inPlace('tests missing', 'tests missing — add them'), 0)).toBe(
      'Revision 2. Address before anything else:\n- tests missing — add them',
    );
  });

  it('drops feedback carried over from an earlier revision', () => {
    let s = inPlace('first', 'old note');
    s = rejectStep({ state: done(s), pipeline, reason: 'second' });
    s = rerunStep({ state: s });
    expect(s.steps[0].feedback).toBe('old note');
    expect(revisionFeedback(s, 0)).toBe(
      'Revision 3. Address before anything else:\n- Rejected at step 1 (dev): second',
    );
  });

  it('says nothing when a rerun came with no reason at all', () => {
    expect(revisionFeedback(inPlace(), 0)).toBeNull();
  });
});

describe('composeAgentPrompt — prior revisions', () => {
  const base = {
    skills: 'SKILL',
    persona: null,
    instructions: null,
    harness: { persona: true, projectInstructions: true, instructionFile: 'CLAUDE.md' },
  } as Parameters<typeof composeAgentPrompt>[0];

  it('leaves a first run untouched', () => {
    expect(composeAgentPrompt({ ...base, runHistory: null }).text).toBe('SKILL');
  });

  it('points a rerun at the step\'s history in one line', () => {
    const text = composeAgentPrompt({ ...base, runHistory: { file: '.aidlc/runs/R.json', stepIdx: 2 } }).text;
    const section = text.split('\n\n---\n\n').find((p) => p.startsWith('## Prior revisions'))!;
    expect(section.split('\n').filter(Boolean)).toEqual([
      '## Prior revisions',
      'Earlier rejections and feedback for this step: `.aidlc/runs/R.json` → `steps[2].history`. Do not bring back what they rejected.',
    ]);
    expect(text).toMatch(/## Phase Behavior\n\nSKILL\n$/);
  });
});

describe('autopilot — a rerun is told why', () => {
  function tmpRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-rev-feedback-'));
    fs.mkdirSync(path.join(root, '.aidlc', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aidlc', 'skills', 'dev.md'), 'SKILL-DEV\n');
    fs.writeFileSync(path.join(root, '.aidlc', 'spy.cjs'), `
const fs = require('fs'); const path = require('path');
module.exports = { async run(o) {
  fs.appendFileSync(path.join(o.workspaceRoot, 'calls.log'),
    JSON.stringify({ skill: o.skill, args: o.args }) + '\\n');
  return { success: true, output: 'ok' };
} };
`);
    fs.writeFileSync(path.join(root, '.aidlc', 'workspace.yaml'), `
version: "1.0"
name: fb
agents:
  - { id: dev, name: Dev, skills: [dev], runner: custom, runner_path: .aidlc/spy.cjs }
skills:
  - { id: dev, path: .aidlc/skills/dev.md }
pipelines:
  - id: p
    steps:
      - { agent: dev, human_review: true }
`);
    return root;
  }

  function lastCall(root: string): { skill: string; args: string[] } {
    const lines = fs.readFileSync(path.join(root, 'calls.log'), 'utf8').trim().split('\n');
    return JSON.parse(lines.at(-1)!);
  }

  it('sends the reason in the message and the history pointer in the prompt', async () => {
    const root = tmpRoot();
    const p = WorkspaceLoader.load(root).config.pipelines[0];
    let s = startRun({ runId: 'R-1', pipeline: p, context: { epic: 'R-1' } });
    s = markStepDone({ state: s, pipeline: p, workspaceRoot: root });
    s = rejectStep({ state: s, pipeline: p, reason: 'no tests' });
    RunStateStore.save(root, rerunStep({ state: s }));

    await runExecLoop(root, 'R-1', {}, {});
    const call = lastCall(root);
    expect(call.args).toEqual([
      'epic=R-1\n\nRevision 2. Address before anything else:\n- Rejected at step 1 (dev): no tests',
    ]);
    expect(call.skill).toContain('`.aidlc/runs/R-1.json` → `steps[0].history`');
  });

  it('changes nothing on a first run', async () => {
    const root = tmpRoot();
    const p = WorkspaceLoader.load(root).config.pipelines[0];
    RunStateStore.save(root, startRun({ runId: 'R-2', pipeline: p, context: { epic: 'R-2' } }));

    await runExecLoop(root, 'R-2', {}, {});
    const call = lastCall(root);
    expect(call.args).toEqual(['epic=R-2']);
    expect(call.skill).not.toContain('Prior revisions');
  });
});
