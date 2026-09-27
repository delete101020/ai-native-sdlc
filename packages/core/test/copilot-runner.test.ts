import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Same fake-child_process shape the Codex tests use, plus a stdin the runner
// writes the prompt into.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinText = '';
  stdin = Object.assign(new EventEmitter(), {
    end: (text: string) => { this.stdinText = text; },
  });
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

vi.mock('../src/util/resolveCommand', () => ({
  resolveCommand: (bin: string) => ({ command: bin, args: [] }),
  clearResolveCommandCache: () => {},
}));

import { CopilotRunner, copilotMcpConfig, RunnerRegistry } from '../src';
import type { RunnerContext, StdioMcpServer } from '../src';

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

const noGraph = { graphServer: () => null };
const graph: StdioMcpServer = {
  name: 'codegraph',
  command: '/opt/codegraph',
  args: ['serve', '--mcp', '--path', '/tmp/ws'],
  env: { CODEGRAPH_TELEMETRY: '0' },
};

/** Emit one JSONL event, exactly as copilot writes it. */
function line(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj) + '\n');
}

describe('CopilotRunner — invocation', () => {
  beforeEach(() => { lastArgs = []; lastBin = ''; });

  it('runs copilot non-interactively with JSONL output and every tool allowed', async () => {
    const p = new CopilotRunner(noGraph).run(ctx());
    expect(lastBin).toBe('copilot');
    expect(lastArgs).toContain('--allow-all-tools');
    expect(lastArgs[lastArgs.indexOf('--output-format') + 1]).toBe('json');
    lastChild.emit('close', 0);
    await p;
  });

  it('sends the composed prompt on stdin, not on the command line', async () => {
    const p = new CopilotRunner(noGraph).run(ctx({ skill: 'PERSONA+SKILLS', args: ['do it'] }));
    expect(lastChild.stdinText).toContain('PERSONA+SKILLS');
    expect(lastChild.stdinText).toContain('do it');
    expect(lastArgs.join(' ')).not.toContain('PERSONA+SKILLS');
    lastChild.emit('close', 0);
    await p;
  });

  it('disables the built-in GitHub MCP server unless asked to keep it', async () => {
    const p1 = new CopilotRunner(noGraph).run(ctx());
    expect(lastArgs).toContain('--disable-builtin-mcps');
    lastChild.emit('close', 0);
    await p1;
    const p2 = new CopilotRunner({ ...noGraph, keepBuiltinMcps: true }).run(ctx());
    expect(lastArgs).not.toContain('--disable-builtin-mcps');
    lastChild.emit('close', 0);
    await p2;
  });

  it('attaches the workspace graph server for this run only', async () => {
    const p = new CopilotRunner({ graphServer: () => graph }).run(ctx());
    const cfg = JSON.parse(lastArgs[lastArgs.indexOf('--additional-mcp-config') + 1]);
    expect(cfg.mcpServers.codegraph).toEqual({
      type: 'local',
      command: '/opt/codegraph',
      args: ['serve', '--mcp', '--path', '/tmp/ws'],
      env: { CODEGRAPH_TELEMETRY: '0' },
      tools: ['*'],
    });
    lastChild.emit('close', 0);
    await p;
  });

  it('passes no MCP config when the workspace has no graph registered', async () => {
    const p = new CopilotRunner(noGraph).run(ctx());
    expect(lastArgs).not.toContain('--additional-mcp-config');
    lastChild.emit('close', 0);
    await p;
  });

  it('omits --model for an unmapped Claude tier alias, uses a declared alias', async () => {
    const p1 = new CopilotRunner(noGraph).run(ctx({ model: 'sonnet' }));
    expect(lastArgs).not.toContain('--model');
    lastChild.emit('close', 0);
    await p1;
    const p2 = new CopilotRunner(noGraph).run(ctx({ model: 'sonnet', modelAliases: { sonnet: 'gpt-5.2' } }));
    expect(lastArgs[lastArgs.indexOf('--model') + 1]).toBe('gpt-5.2');
    lastChild.emit('close', 0);
    await p2;
  });
});

describe('CopilotRunner — output', () => {
  it('streams deltas once and returns the last assistant message', async () => {
    const out: string[] = [];
    const p = new CopilotRunner(noGraph).run(ctx({ onOutput: (c) => out.push(c) }));
    lastChild.stdout.emit('data', line({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'Hel' } }));
    lastChild.stdout.emit('data', line({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'lo' } }));
    lastChild.stdout.emit('data', line({ type: 'assistant.message', data: { messageId: 'm1', content: 'Hello' } }));
    lastChild.stdout.emit('data', line({ type: 'result', exitCode: 0, usage: { premiumRequests: 1 } }));
    lastChild.emit('close', 0);
    const res = await p;
    expect(out.join('')).toBe('Hello\n');
    expect(res).toEqual({ success: true, output: 'Hello', data: { premiumRequests: 1 } });
  });

  it('prints a message that arrived without deltas', async () => {
    const out: string[] = [];
    const p = new CopilotRunner(noGraph).run(ctx({ onOutput: (c) => out.push(c) }));
    lastChild.stdout.emit('data', line({ type: 'assistant.message', data: { messageId: 'm2', content: 'Done' } }));
    lastChild.emit('close', 0);
    await p;
    expect(out.join('')).toBe('Done\n');
  });

  it('reports no cost and no tokens — Copilot bills premium requests', async () => {
    const p = new CopilotRunner(noGraph).run(ctx());
    lastChild.stdout.emit('data', line({ type: 'result', exitCode: 0, usage: { premiumRequests: 3 } }));
    lastChild.emit('close', 0);
    const res = await p;
    expect(res.costUsd).toBeUndefined();
    expect(res.usage).toBeUndefined();
  });

  it('surfaces a graph server that failed to start', async () => {
    const err: string[] = [];
    const p = new CopilotRunner({ graphServer: () => graph }).run(ctx({ onError: (c) => err.push(c) }));
    lastChild.stdout.emit('data', line({
      type: 'session.mcp_server_status_changed',
      data: { serverName: 'codegraph', status: 'failed', error: 'No such file or directory' },
    }));
    lastChild.emit('close', 0);
    await p;
    expect(err.join('')).toContain('codegraph failed to start');
  });

  it('maps a non-zero exit to failure', async () => {
    const p = new CopilotRunner(noGraph).run(ctx());
    lastChild.emit('close', 1);
    expect((await p).success).toBe(false);
  });
});

describe('CopilotRunner — registration', () => {
  it('resolves runner: copilot to the builtin', () => {
    const reg = new RunnerRegistry('/tmp/ws');
    const runner = reg.resolve({ id: 'a', name: 'a', skills: ['s'], runner: 'copilot' } as never);
    expect(runner).toBeInstanceOf(CopilotRunner);
  });

  it('builds MCP config without an env key when the server has none', () => {
    const cfg = JSON.parse(copilotMcpConfig({ name: 'ast-graph', command: '/x', args: [] }));
    expect(cfg.mcpServers['ast-graph']).not.toHaveProperty('env');
  });
});
