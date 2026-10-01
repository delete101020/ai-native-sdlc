import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunState } from '@aidlc/core';
import { computeWorkspaceEpicUsage, getOrComputeWorkspaceEpicUsage } from '../src/v2/epicTokenAttribution';

let tmp: string;
let root: string;
let transcript: string;
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;

function run(runId: string, startedAt: string, updatedAt: string): RunState {
  return {
    runId,
    updatedAt,
    steps: [{ stepIdx: 0, agent: 'spec', status: 'in_progress', startedAt }],
  } as unknown as RunState;
}

function record(id: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    cwd: root,
    sessionId: 's1',
    timestamp,
    message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } },
  }) + '\n';
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-token-cache-'));
  root = path.join(tmp, 'repo');
  fs.mkdirSync(root);
  const project = path.join(tmp, 'claude', 'projects', '-repo');
  fs.mkdirSync(project, { recursive: true });
  transcript = path.join(project, 'session.jsonl');
  fs.writeFileSync(transcript, record('m1', '2026-09-01T10:30:00Z') + record('m2', '2026-09-01T12:30:00Z'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
});

afterAll(() => {
  if (prevConfigDir === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
  else { process.env.CLAUDE_CONFIG_DIR = prevConfigDir; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('getOrComputeWorkspaceEpicUsage', () => {
  it('re-walks only the runs whose state file changed, and re-derives overlap for all', async () => {
    const a = run('RUN-A', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z');
    let b = run('RUN-B', '2026-09-01T12:00:00Z', '2026-09-01T13:00:00Z');

    let usage = await getOrComputeWorkspaceEpicUsage(root, [a, b], [1, 1]);
    expect(usage.get('RUN-A')?.total.calls).toBe(1);
    expect(usage.get('RUN-B')?.total.calls).toBe(1);
    expect(usage.get('RUN-A')?.hasOverlap).toBe(false);

    // New transcript lines are not seen while no run file moved: both cached.
    fs.appendFileSync(transcript, record('m3', '2026-09-01T12:45:00Z') + record('m4', '2026-09-01T10:45:00Z'));
    usage = await getOrComputeWorkspaceEpicUsage(root, [a, b], [1, 1]);
    expect(usage.get('RUN-B')?.total.calls).toBe(1);

    // Only B moved: B is re-walked, A keeps its cached figure.
    usage = await getOrComputeWorkspaceEpicUsage(root, [a, b], [1, 2]);
    expect(usage.get('RUN-B')?.total.calls).toBe(2);
    expect(usage.get('RUN-A')?.total.calls).toBe(1);
    const fresh = await computeWorkspaceEpicUsage(root, [a, b]);
    expect(usage.get('RUN-B')?.total).toEqual(fresh.get('RUN-B')?.total);

    // B now overlaps A: the flag lands on A too, though A was not re-walked.
    b = run('RUN-B', '2026-09-01T10:15:00Z', '2026-09-01T13:00:00Z');
    usage = await getOrComputeWorkspaceEpicUsage(root, [a, b], [1, 3]);
    expect(usage.get('RUN-A')?.total.calls).toBe(1);
    expect(usage.get('RUN-A')?.hasOverlap).toBe(true);
    expect(usage.get('RUN-B')?.hasOverlap).toBe(true);
  });
});
