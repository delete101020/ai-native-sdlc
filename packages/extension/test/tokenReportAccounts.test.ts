import { describe, expect, it } from 'vitest';

import type { CallRecord } from '../src/v2/tokenRecords';
import { buildAccountReport } from '../src/v2/tokenReport';

function rec(account: string, project: string, cost: number): CallRecord {
  return {
    account,
    project,
    sessionId: `${account}-s`,
    timestamp: '2026-09-01T10:00:00Z',
    model: 'claude-sonnet-5',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    cost,
    cwd: '',
    msgId: `${account}-${project}`,
    tools: [],
    readPaths: [],
  };
}

const records = [rec('Work', '-repo', 2), rec('Personal', '-repo', 1), rec('Personal', '-other', 4)];

describe('buildAccountReport', () => {
  it('combines every account when none is selected, keeping projects apart per account', () => {
    const r = buildAccountReport(records, 30, null);
    expect(r.accounts).toEqual(['Personal', 'Work']);
    expect(r.account).toBeNull();
    expect(r.report!.overview.totalCost).toBe(7);
    expect(r.report!.topProjects.map((p) => `${p.account}:${p.project}`))
      .toEqual(['Personal:-other', 'Work:-repo', 'Personal:-repo']);
  });

  it('scopes to the selected account', () => {
    const r = buildAccountReport(records, 30, 'Work');
    expect(r.account).toBe('Work');
    expect(r.report!.overview.totalCost).toBe(2);
    expect(r.accounts).toEqual(['Personal', 'Work']);
  });

  it('falls back to all when the selected account has no data', () => {
    expect(buildAccountReport(records, 30, 'Gone').account).toBeNull();
  });
});
