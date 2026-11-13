import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { analyzeEpicSuggestions, analyzeSuggestions, type EpicForRules } from '../src/v2/costSuggestions';
import { loadAllRecords, type CallRecord } from '../src/v2/tokenRecords';

let n = 0;
function rec(over: Partial<CallRecord> = {}): CallRecord {
  n++;
  return {
    account: '',
    project: '-repo',
    sessionId: 's1',
    timestamp: '2026-09-01T10:00:00Z',
    model: 'claude-sonnet-5',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    cost: 0.01,
    cwd: '',
    msgId: `m${n}`,
    tools: [],
    readPaths: [],
    turn: 1,
    ...over,
  };
}

const rules = (records: CallRecord[]) => analyzeSuggestions(records).map((s) => s.rule);

describe('workflow rules', () => {
  it('flags prompts that ran 40+ tool calls without an edit, but not long turns that edited', () => {
    const spinning = [1, 2].map((turn) => rec({ turn, tools: Array(40).fill('Grep') }));
    expect(rules(spinning)).toContain('runaway-agent-turns');
    expect(rules(spinning.slice(0, 1))).not.toContain('runaway-agent-turns');
    const working = [1, 2].map((turn) => rec({ turn, tools: [...Array(40).fill('Grep'), 'Edit'] }));
    expect(rules(working)).not.toContain('runaway-agent-turns');
  });

  it('flags sessions of 50+ prompts', () => {
    expect(rules([rec({ turn: 50 })])).toContain('mega-session');
    expect(rules([rec({ turn: 49 })])).not.toContain('mega-session');
  });

  it('flags the same long prompt sent four times, but not acks or slash commands', () => {
    const p = 'please fix the failing build in the extension package';
    expect(rules([1, 2, 3, 4].map((turn) => rec({ turn, prompt: p })))).toContain('repeated-prompts');
    expect(rules([1, 2, 3, 4].map((turn) => rec({ turn, prompt: 'continue' })))).not.toContain('repeated-prompts');
    const launch = 'epic=CR-1 from_epic=CR-0 follow_up_key=f1';
    expect(rules([1, 2, 3, 4].map((turn) => rec({ turn, prompt: launch })))).not.toContain('repeated-prompts');
  });

  it('flags a premium-model session of small outputs, with savings against Sonnet', () => {
    const records = Array.from({ length: 10 }, () => rec({ model: 'claude-opus-5-5', cost: 1 }));
    const s = analyzeSuggestions(records).find((x) => x.rule === 'premium-model-routine');
    expect(s?.estSavings).toBeGreaterThan(0);
  });

  it('flags a workspace whose CLAUDE.md files exceed 4 KB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-bloat-'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x'.repeat(5000));
    expect(rules([rec({ cwd: dir })])).toContain('instruction-bloat');
  });
});

function epic(id: string, steps: Array<Partial<EpicForRules['stepDetails'][number]>>, status = 'done'): EpicForRules {
  return {
    id,
    status: status as EpicForRules['status'],
    stepDetails: steps.map((s) => ({ agent: 'dev', status: 'done', rejectCount: 0, ...s })) as EpicForRules['stepDetails'],
  };
}
const usage = (totalTokens: number, startedAt: string | null = null, endedAt: string | null = null) =>
  ({ totalTokens, cost: totalTokens / 1e6, startedAt, endedAt });

describe('epic rules', () => {
  const epicRules = (epics: EpicForRules[], records: CallRecord[] = []) =>
    analyzeEpicSuggestions(epics, records, '/ws').map((s) => `${s.rule}:${s.scope}`);

  it('flags a phase that cost 3×+ its median across epics', () => {
    const epics = ['A', 'B', 'C', 'D'].map((id, i) =>
      epic(id, [{ agent: 'implement', tokenUsage: usage(i === 3 ? 5_000_000 : 1_000_000) }, { agent: 'verify' }]));
    expect(epicRules(epics)).toEqual(['phase-cost-outlier:epic D · implement']);
  });

  it('flags a phase rejected on 3+ epics and a quarter of its runs', () => {
    const epics = ['A', 'B', 'C', 'D', 'E', 'F'].map((id, i) =>
      epic(id, [{ agent: 'spec', rejectCount: i < 3 ? 1 : 0 }, { agent: 'verify' }]));
    expect(epicRules(epics)).toEqual(['phase-rework:phase spec']);
    epics[0].stepDetails[0].rejectCount = 0;
    expect(epicRules(epics)).toEqual([]);
  });

  it('flags done epics that implemented without any review/verify step done', () => {
    const shipped = epic('A', [{ agent: 'implement' }, { agent: 'review', status: 'skipped' as never }]);
    const checked = epic('B', [{ agent: 'implement' }, { agent: 'verify' }]);
    expect(epicRules([shipped, checked])).toEqual(['unverified-epics:1 epic(s)']);
  });

  it('counts compactions inside a phase window for the workspace', () => {
    const e = epic('A', [
      { agent: 'implement', tokenUsage: usage(10, '2026-09-01T09:00:00Z', '2026-09-01T12:00:00Z') },
      { agent: 'verify' },
    ]);
    const cwd = path.resolve('/ws');
    const records = ['10:00', '11:00', '13:00'].map((t) =>
      rec({ cwd, afterCompact: true, timestamp: `2026-09-01T${t}:00Z` }));
    expect(epicRules([e], records)).toEqual(['phase-compaction:epic A · implement']);
    expect(epicRules([e], records.slice(1))).toEqual([]);
  });
});

describe('transcript parsing', () => {
  it('numbers human turns, keeps prompt text, marks compaction, ignores tool results', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-records-'));
    const proj = path.join(dir, 'projects', '-repo');
    fs.mkdirSync(proj, { recursive: true });
    const usageBlock = { input_tokens: 1, output_tokens: 1 };
    const lines = [
      { type: 'user', sessionId: 's', message: { content: 'refactor the parser please' } },
      { type: 'assistant', sessionId: 's', message: { id: 'a1', model: 'm', usage: usageBlock, content: [{ type: 'tool_use', name: 'Read' }] } },
      { type: 'user', sessionId: 's', message: { content: [{ type: 'tool_result' }] } },
      { type: 'assistant', sessionId: 's', message: { id: 'a2', model: 'm', usage: usageBlock } },
      { type: 'system', subtype: 'compact_boundary', sessionId: 's' },
      { type: 'user', sessionId: 's', isCompactSummary: true, message: { content: 'summary' } },
      { type: 'user', sessionId: 's', message: { content: '<command-name>/aidlc</command-name>' } },
      { type: 'assistant', sessionId: 's', message: { id: 'a3', model: 'm', usage: usageBlock } },
    ];
    fs.writeFileSync(path.join(proj, 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
    const recs = await loadAllRecords(0, [{ label: '', dir }]);
    const byId = Object.fromEntries(recs.map((r) => [r.msgId, r]));
    expect(byId.a1).toMatchObject({ turn: 1, prompt: 'refactor the parser please' });
    expect(byId.a2.turn).toBe(1);
    expect(byId.a2.prompt).toBeUndefined();
    expect(byId.a3).toMatchObject({ turn: 2, afterCompact: true });
    expect(byId.a3.prompt).toBeUndefined();
  });
});
