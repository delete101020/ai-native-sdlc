import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claudeMcpRegistrar,
  codexMcpRegistrar,
  mcpRegistrarFor,
  readProjectMcpServer,
  isCodexMcpConfigured,
  codexConfigPath,
  RunnerRegistry,
  resolveProviderModel,
  isClaudeTierAlias,
  createLineSink,
} from '../src';

const server = { name: 'ast-graph', command: '/opt/ast-graph', args: ['mcp', '--db', '/w/.ast-graph/graph.db'] };

describe('MCP registrars', () => {
  it('scopes the Claude registration to the project', () => {
    const cmd = claudeMcpRegistrar.add(server);
    expect(cmd.bin).toBe('claude');
    expect(cmd.args).toEqual([
      'mcp', 'add', 'ast-graph', '--scope', 'local', '--',
      '/opt/ast-graph', 'mcp', '--db', '/w/.ast-graph/graph.db',
    ]);
  });

  it('registers Codex without a scope flag, because its config is per-user', () => {
    expect(codexMcpRegistrar.configScope).toBe('global');
    expect(codexMcpRegistrar.add(server).args).toEqual([
      'mcp', 'add', 'ast-graph', '--',
      '/opt/ast-graph', 'mcp', '--db', '/w/.ast-graph/graph.db',
    ]);
  });

  it('recognises the server in both list formats', () => {
    expect(claudeMcpRegistrar.isRegistered('ast-graph: /opt/ast-graph mcp - ✓ Connected', 'ast-graph')).toBe(true);
    expect(codexMcpRegistrar.isRegistered('Name       Command\nast-graph  /opt/ast-graph', 'ast-graph')).toBe(true);
  });

  it('does not mistake a mention for a registration', () => {
    expect(claudeMcpRegistrar.isRegistered('No MCP servers configured. Try: ast-graph', 'ast-graph')).toBe(false);
  });

  it('has no registrar for a runner whose CLI we do not configure', () => {
    expect(mcpRegistrarFor('gemini')).toBeUndefined();
    expect(mcpRegistrarFor('custom')).toBeUndefined();
    expect(mcpRegistrarFor('codex')).toBe(codexMcpRegistrar);
  });
});

describe('reading an existing registration', () => {
  function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-mcp-'));
  }

  it('copies the binary path Claude was actually pointed at', () => {
    const dir = tmp();
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({
      projects: { '/w': { mcpServers: { 'ast-graph': { command: '/opt/ast-graph', args: ['mcp', '--db', '/w/g.db'] } } } },
    }));
    expect(readProjectMcpServer('/w', 'ast-graph', file)).toEqual({
      name: 'ast-graph', command: '/opt/ast-graph', args: ['mcp', '--db', '/w/g.db'],
    });
  });

  it('returns null for an unknown project, a missing file, or malformed JSON', () => {
    const dir = tmp();
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ projects: { '/other': {} } }));
    expect(readProjectMcpServer('/w', 'ast-graph', file)).toBeNull();
    expect(readProjectMcpServer('/w', 'ast-graph', path.join(dir, 'nope.json'))).toBeNull();
    fs.writeFileSync(file, 'not json');
    expect(readProjectMcpServer('/w', 'ast-graph', file)).toBeNull();
  });

  it('detects the codex table header, and only a real one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-home-'));
    expect(isCodexMcpConfigured('ast-graph', home)).toBe(false);

    fs.mkdirSync(path.dirname(codexConfigPath(home)), { recursive: true });
    fs.writeFileSync(codexConfigPath(home), '# ast-graph is not configured here\n');
    expect(isCodexMcpConfigured('ast-graph', home)).toBe(false);

    fs.writeFileSync(codexConfigPath(home), '[mcp_servers.ast-graph]\ncommand = "/opt/ast-graph"\n');
    expect(isCodexMcpConfigured('ast-graph', home)).toBe(true);
  });
});

describe('RunnerRegistry — provider resolution', () => {
  const agent = (over: Record<string, unknown> = {}) => ({
    id: 'a', name: 'A', skills: [], runner: 'default', model: 'sonnet', ...over,
  }) as never;

  it('resolves codex to the bundled provider runner', () => {
    const reg = new RunnerRegistry('/w');
    expect(reg.resolve(agent({ runner: 'codex' })).capabilities?.instructionFile).toBe('AGENTS.md');
  });

  it('fails loudly for a runner with no implementation instead of falling back to Claude', () => {
    // D6: silent substitution would make a run's provenance unreproducible.
    expect(() => new RunnerRegistry('/w').resolve(agent({ runner: 'gemini' })))
      .toThrow(/no implementation yet/);
  });
});

describe('portable model resolution', () => {
  it('treats Claude tier aliases as non-portable', () => {
    expect(isClaudeTierAlias('opus')).toBe(true);
    expect(isClaudeTierAlias('gpt-5-codex')).toBe(false);
    expect(resolveProviderModel('codex', 'sonnet')).toBeUndefined();
    expect(resolveProviderModel('codex', 'gpt-5-codex')).toBe('gpt-5-codex');
    expect(resolveProviderModel('codex', undefined)).toBeUndefined();
  });

  it('never passes a model to Claude Code, which resolves tiers itself', () => {
    expect(resolveProviderModel('default', 'opus')).toBeUndefined();
  });
});

describe('shared line sink', () => {
  it('splits across chunk boundaries and flushes the tail', () => {
    const lines: string[] = [];
    const sink = createLineSink((l) => lines.push(l));
    sink.push('one\ntw');
    sink.push('o\nthree');
    expect(lines).toEqual(['one', 'two']);
    sink.flush();
    expect(lines).toEqual(['one', 'two', 'three']);
    sink.flush(); // idempotent — an empty buffer dispatches nothing
    expect(lines).toHaveLength(3);
  });
});
