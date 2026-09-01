import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Same fake-child_process shape the DefaultRunner tests use: spawn() hands back
// an emitter the test drives line by line.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}
let lastChild: FakeChild;
let lastBin: string;
let lastArgs: string[];

vi.mock('child_process', () => ({
  spawn: (bin: string, args: string[]) => {
    lastBin = bin;
    lastArgs = args;
    lastChild = new FakeChild();
    return lastChild;
  },
}));

import { CodexRunner } from '../src';
import type { RunnerContext } from '../src';

function ctx(overrides: Partial<RunnerContext> = {}): RunnerContext {
  return {
    skill: 'SYSTEM PROMPT',
    env: {},
    args: ['write spec.md'],
    workspaceRoot: '/tmp/ws',
    onOutput: () => {},
    onError: () => {},
    claude: null,
    ...overrides,
  };
}

/** Emit one JSONL event, exactly as codex writes it. */
function line(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj) + '\n');
}

describe('CodexRunner — invocation', () => {
  beforeEach(() => { lastArgs = []; lastBin = ''; });

  it('runs `codex exec --json` in the workspace root', async () => {
    const p = new CodexRunner().run(ctx());
    expect(lastBin).toBe('codex');
    expect(lastArgs[0]).toBe('exec');
    expect(lastArgs).toContain('--json');
    lastChild.emit('close', 0);
    await p;
  });

  it('asks for a writable sandbox so artifact-producing phases can write', async () => {
    const p = new CodexRunner().run(ctx());
    expect(lastArgs[lastArgs.indexOf('--sandbox') + 1]).toBe('workspace-write');
    lastChild.emit('close', 0);
    await p;
  });

  it('passes the whole composed prompt, since codex exec has no system-prompt flag', async () => {
    const p = new CodexRunner().run(ctx({ skill: 'PERSONA+SKILLS', args: ['do it'] }));
    const prompt = lastArgs[lastArgs.length - 1];
    expect(prompt).toContain('PERSONA+SKILLS');
    expect(prompt).toContain('do it');
    lastChild.emit('close', 0);
    await p;
  });

  it('omits --model for a Claude tier alias rather than inventing an equivalent', async () => {
    const p = new CodexRunner().run(ctx({ model: 'sonnet' }));
    expect(lastArgs).not.toContain('--model');
    lastChild.emit('close', 0);
    await p;
  });

  it('passes an explicit provider model through verbatim', async () => {
    const p = new CodexRunner().run(ctx({ model: 'gpt-5-codex' }));
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('gpt-5-codex');
    lastChild.emit('close', 0);
    await p;
  });
});

describe('CodexRunner — event stream', () => {
  it('streams agent messages and returns the last one as output', async () => {
    const chunks: string[] = [];
    const p = new CodexRunner().run(ctx({ onOutput: (c) => chunks.push(c) }));

    lastChild.stdout.emit('data', line({ msg: { type: 'agent_message', message: 'Hello ' } }));
    lastChild.stdout.emit('data', line({ msg: { type: 'agent_message', message: 'world' } }));
    lastChild.emit('close', 0);

    const res = await p;
    expect(res.success).toBe(true);
    expect(chunks.join('')).toBe('Hello world');
    expect(res.output).toBe('world');
  });

  it('streams deltas without printing the assembled message twice', async () => {
    const chunks: string[] = [];
    const p = new CodexRunner().run(ctx({ onOutput: (c) => chunks.push(c) }));

    lastChild.stdout.emit('data', line({ msg: { type: 'agent_message_delta', delta: 'par' } }));
    lastChild.stdout.emit('data', line({ msg: { type: 'agent_message_delta', delta: 'tial' } }));
    lastChild.stdout.emit('data', line({ msg: { type: 'agent_message', message: 'partial' } }));
    lastChild.emit('close', 0);

    const res = await p;
    expect(chunks.join('')).toBe('partial');
    expect(res.output).toBe('partial');
  });

  it('buffers JSONL across split chunks', async () => {
    const chunks: string[] = [];
    const p = new CodexRunner().run(ctx({ onOutput: (c) => chunks.push(c) }));
    const raw = JSON.stringify({ msg: { type: 'agent_message', message: 'split me' } }) + '\n';

    lastChild.stdout.emit('data', Buffer.from(raw.slice(0, 12)));
    lastChild.stdout.emit('data', Buffer.from(raw.slice(12)));
    lastChild.emit('close', 0);

    await p;
    expect(chunks.join('')).toBe('split me');
  });

  it('reads token usage but never reports a dollar cost', async () => {
    const p = new CodexRunner().run(ctx());
    lastChild.stdout.emit('data', line({
      msg: { type: 'token_count', info: { total_token_usage: { input_tokens: 120, output_tokens: 45 } } },
    }));
    lastChild.emit('close', 0);

    const res = await p;
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 45 });
    // Codex reports tokens, not dollars — inventing one would make the budget
    // guard confidently wrong (P0/D5).
    expect(res.costUsd).toBeUndefined();
  });

  it('understands the newer top-level item envelope too', async () => {
    const chunks: string[] = [];
    const p = new CodexRunner().run(ctx({ onOutput: (c) => chunks.push(c) }));
    lastChild.stdout.emit('data', line({ type: 'item.completed', item: { type: 'agent_message', text: 'newer shape' } }));
    lastChild.emit('close', 0);
    await p;
    expect(chunks.join('')).toBe('newer shape');
  });

  it('surfaces non-JSON stdout instead of swallowing it', async () => {
    const chunks: string[] = [];
    const p = new CodexRunner().run(ctx({ onOutput: (c) => chunks.push(c) }));
    lastChild.stdout.emit('data', Buffer.from('warning: something changed\n'));
    lastChild.emit('close', 0);
    await p;
    expect(chunks.join('')).toContain('warning: something changed');
  });

  it('maps a non-zero exit to failure', async () => {
    const p = new CodexRunner().run(ctx());
    lastChild.emit('close', 1);
    expect((await p).success).toBe(false);
  });

  it('reports a missing binary through onError rather than throwing', async () => {
    const errs: string[] = [];
    const p = new CodexRunner().run(ctx({ onError: (c) => errs.push(c) }));
    lastChild.emit('error', new Error('spawn codex ENOENT'));
    const res = await p;
    expect(res.success).toBe(false);
    expect(errs.join('')).toContain('ENOENT');
  });
});

describe('CodexRunner — harness capabilities', () => {
  it('declares nothing it has not earned, and names AGENTS.md', () => {
    const caps = new CodexRunner().capabilities;
    expect(caps).toEqual({
      persona: false,
      projectInstructions: false,
      astGraph: false,
      instructionFile: 'AGENTS.md',
    });
  });

  it('carries the registrar that can give it the ast-graph server', () => {
    expect(new CodexRunner().mcp.bin).toBe('codex');
  });
});
