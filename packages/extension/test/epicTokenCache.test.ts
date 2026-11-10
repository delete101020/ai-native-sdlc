import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunState } from '@aidlc/core';
import {
  claudeProjectFolderName,
  computeWorkspaceEpicUsage,
  getOrComputeWorkspaceEpicUsage,
  setEpicUsageCacheFile,
  transcriptFoldersFor,
} from '../src/v2/epicTokenAttribution';

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

describe('transcript index', () => {
  it('reads only complete appended lines, and starts over when the file was rewritten', async () => {
    const r = run('RUN-I', '2026-09-02T00:00:00Z', '2026-09-02T23:00:00Z');
    const calls = async () => (await computeWorkspaceEpicUsage(root, [r])).get('RUN-I')?.total.calls;
    const before = fs.readFileSync(transcript, 'utf8');
    const half = record('i2', '2026-09-02T02:00:00Z');

    fs.appendFileSync(transcript, record('i1', '2026-09-02T01:00:00Z') + half.slice(0, 40));
    expect(await calls()).toBe(1);
    // The rest of the line arrives: it is counted once, whole.
    fs.appendFileSync(transcript, half.slice(40));
    expect(await calls()).toBe(2);

    // Shorter than what was read — nothing indexed from it stands.
    fs.writeFileSync(transcript, record('i3', '2026-09-02T03:00:00Z'));
    expect(await calls()).toBe(1);
    fs.writeFileSync(transcript, before);
  });
});

describe('transcriptFoldersFor', () => {
  it('keeps the root folder and those of directories above it', () => {
    // path.resolve adds the drive on Windows (C:\Users\me → C--Users-me).
    const f = (d: string) => claudeProjectFolderName(path.resolve(d));
    const folders = [f('/Users/me'), f('/Users/me/repo'), f('/Users/me/repo/sub'), f('/Users/me/repo2'), f('/Users/other')];
    expect(transcriptFoldersFor('/Users/me/repo', folders)).toEqual([f('/Users/me'), f('/Users/me/repo')]);
  });

  it('reads every folder when none matches or the name would be shortened', () => {
    expect(transcriptFoldersFor('/Users/me/repo', ['-Users-other'])).toBeNull();
    expect(transcriptFoldersFor(`/${'x'.repeat(250)}`, ['-x'])).toBeNull();
  });
});

describe('setEpicUsageCacheFile', () => {
  it('writes the figures out and reads them back for the same version only', async () => {
    const file = path.join(tmp, 'cache', 'usage.json');
    setEpicUsageCacheFile(file, 'v1');
    const c = run('RUN-C', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z');
    await getOrComputeWorkspaceEpicUsage(root, [c], [7]);
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) { await new Promise((r) => setTimeout(r, 10)); }
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.version).toBe('v1');
    expect(Object.keys(saved.entries).some((k) => k.endsWith('::RUN-C'))).toBe(true);

    setEpicUsageCacheFile(null);
  });
});
