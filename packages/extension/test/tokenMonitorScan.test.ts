import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSnapshot, resetTokenScan } from '../src/v2/tokenMonitor';

const NOW = new Date(2026, 10, 15, 12);
const line = (id: string, input: number, session = 's', at = NOW): string =>
  `${JSON.stringify({
    type: 'assistant',
    sessionId: session,
    timestamp: at.toISOString(),
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: 1 } },
  })}\n`;

describe('readSnapshot', () => {
  let home: string;
  let file: string;
  const saved = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-tokens-'));
    process.env.CLAUDE_CONFIG_DIR = home;
    fs.mkdirSync(path.join(home, 'projects', 'p'), { recursive: true });
    file = path.join(home, 'projects', 'p', 'a.jsonl');
    resetTokenScan();
  });

  afterEach(() => {
    if (saved === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = saved; }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('adds what was appended without counting earlier lines twice', async () => {
    fs.writeFileSync(file, line('m1', 10));
    expect((await readSnapshot(NOW)).month.input_tokens).toBe(10);
    expect((await readSnapshot(NOW)).month.input_tokens).toBe(10);
    fs.appendFileSync(file, line('m2', 5));
    expect((await readSnapshot(NOW)).month.input_tokens).toBe(15);
  });

  it('waits for a line still being written', async () => {
    const whole = line('m1', 10);
    fs.writeFileSync(file, whole.slice(0, 20));
    expect((await readSnapshot(NOW)).month.calls).toBe(0);
    fs.appendFileSync(file, whole.slice(20));
    expect((await readSnapshot(NOW)).month.input_tokens).toBe(10);
  });

  it('keeps a multi-byte character cut across two reads', async () => {
    const entry = JSON.parse(line('m1', 10)) as Record<string, unknown>;
    const big = `${JSON.stringify({ ...entry, note: 'é'.repeat(200_000) })}\n`;
    fs.writeFileSync(file, big);
    expect((await readSnapshot(NOW)).month.input_tokens).toBe(10);
  });

  it('counts a message once across files', async () => {
    fs.writeFileSync(file, line('m1', 10));
    fs.writeFileSync(path.join(path.dirname(file), 'b.jsonl'), line('m1', 10));
    expect((await readSnapshot(NOW)).month.calls).toBe(1);
  });

  it('starts over when a file shrinks', async () => {
    fs.writeFileSync(file, line('m1', 10) + line('m2', 5));
    await readSnapshot(NOW);
    fs.writeFileSync(file, line('m3', 7));
    expect((await readSnapshot(NOW)).month.input_tokens).toBe(7);
  });

  it('drops yesterday from today on a new day, and keeps it in the month', async () => {
    fs.writeFileSync(file, line('m1', 10));
    expect((await readSnapshot(NOW)).today.input_tokens).toBe(10);
    const tomorrow = await readSnapshot(new Date(2026, 10, 16, 1));
    expect(tomorrow.today.input_tokens).toBe(0);
    expect(tomorrow.month.input_tokens).toBe(10);
  });

  it('leaves last month out of a session that ran into this one', async () => {
    fs.writeFileSync(file, line('m1', 10, 's', new Date(2026, 9, 31, 23)) + line('m2', 5));
    const snap = await readSnapshot(NOW);
    expect(snap.month.input_tokens).toBe(5);
    expect(snap.month.calls).toBe(1);
  });

  it('does not hand out totals a later scan can change', async () => {
    fs.writeFileSync(file, line('m1', 10));
    const first = await readSnapshot(NOW);
    fs.appendFileSync(file, line('m2', 5));
    await readSnapshot(NOW);
    expect(first.month.input_tokens).toBe(10);
  });
});
