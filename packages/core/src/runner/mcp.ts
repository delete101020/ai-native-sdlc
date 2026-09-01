/**
 * How to register a stdio MCP server with a given agentic CLI.
 *
 * Every shape-A harness speaks MCP, and every one of them keeps its own
 * configuration file. `packages/extension/src/v2/astGraph/mcpRegister.ts` used
 * to hard-code `claude mcp add …`, which meant a workspace running any other
 * CLI simply had no `ast-graph` server: the phases that ask for `blast-radius`
 * got nothing back and produced a confident answer anyway. That is gap G1 in
 * MULTI_PROVIDER_ALIGNMENT.md §4c.
 *
 * The fix is deliberately *data*, not behaviour. A registrar only builds the
 * argv and reads the output of a `list`; it spawns nothing. That keeps the
 * per-CLI knowledge — the part that ages when a CLI changes its flags — unit
 * testable without a CLI installed, and leaves the process spawning in the one
 * layer that already owns it (the extension) or in an explicit user command
 * (`aidlc mcp register`).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

/** A stdio MCP server: the command a CLI should spawn to reach it. */
export interface StdioMcpServer {
  name: string;
  command: string;
  args: string[];
}

/** A CLI invocation, ready to hand to execFile. */
export interface McpCommand {
  bin: string;
  args: string[];
}

export interface McpRegistrar {
  /** Default binary name of the CLI whose config this writes. */
  readonly bin: string;
  /**
   * Where the registration lands. `project` = scoped to the working directory,
   * so two workspaces can point at their own graph db. `global` = one entry for
   * the whole machine, which means the last workspace registered wins — worth
   * saying out loud rather than discovering it as a wrong-answers bug.
   */
  readonly configScope: 'project' | 'global';
  /** argv that registers (or overwrites) the server. */
  add(server: StdioMcpServer): McpCommand;
  /** argv that lists the currently registered servers. */
  list(): McpCommand;
  /** Whether `list` output mentions this server. */
  isRegistered(listOutput: string, name: string): boolean;
}

/**
 * Shared list parser. Claude prints `name: <command>`, Codex prints a table
 * whose first column is the name, and either may grow a `--json` mode later.
 * Matching "first token on the line, minus a trailing colon" covers all three
 * without pretending we know the exact format.
 */
function mentionsServer(listOutput: string, name: string): boolean {
  const needle = name.toLowerCase();
  return listOutput.split(/\r?\n/).some((line) => {
    const first = line.trim().split(/[\s:]+/)[0];
    return first?.toLowerCase() === needle;
  });
}

/** `claude mcp add <name> --scope local -- <command> <args…>` */
export const claudeMcpRegistrar: McpRegistrar = {
  bin: 'claude',
  configScope: 'project',
  add: (s) => ({
    bin: 'claude',
    args: ['mcp', 'add', s.name, '--scope', 'local', '--', s.command, ...s.args],
  }),
  list: () => ({ bin: 'claude', args: ['mcp', 'list'] }),
  isRegistered: mentionsServer,
};

/**
 * `codex mcp add <name> -- <command> <args…>`
 *
 * Codex keeps MCP servers in `~/.codex/config.toml`, which is per-user, not
 * per-project: there is no `--scope local` equivalent. So registering a
 * workspace's graph db here points *every* Codex session on the machine at that
 * db. AIDLC therefore never registers Codex automatically the way it does
 * Claude — `aidlc mcp register` is an explicit command, and `aidlc doctor`
 * reports which db the global entry is currently pointing at.
 */
export const codexMcpRegistrar: McpRegistrar = {
  bin: 'codex',
  configScope: 'global',
  add: (s) => ({
    bin: 'codex',
    args: ['mcp', 'add', s.name, '--', s.command, ...s.args],
  }),
  list: () => ({ bin: 'codex', args: ['mcp', 'list'] }),
  isRegistered: mentionsServer,
};

/** Registrar for a builtin runner id, or undefined when we do not know the CLI. */
export function mcpRegistrarFor(runner: string): McpRegistrar | undefined {
  if (runner === 'default') { return claudeMcpRegistrar; }
  if (runner === 'codex') { return codexMcpRegistrar; }
  return undefined;
}

/**
 * Read a stdio MCP server out of Claude's project-scoped config.
 *
 * `claude mcp add --scope local` writes into `~/.claude.json` under
 * `projects[<workspaceRoot>].mcpServers`. That entry is the one piece of
 * knowledge another CLI's registration needs and cannot derive: the absolute
 * path of the `ast-graph` binary, which the VS Code extension downloads into
 * its own globalStorage. Copying the entry keeps a single source of truth —
 * whatever Claude is actually pointed at is what Codex gets pointed at — and
 * avoids re-implementing binary discovery in the CLI, where it would drift.
 *
 * Returns null when the file, the project, or the server is absent; the caller
 * turns that into "scan the workspace first", not into a crash.
 */
export function readProjectMcpServer(
  workspaceRoot: string,
  name: string,
  claudeJsonPath: string,
): StdioMcpServer | null {
  let raw: string;
  try {
    raw = readFileSync(claudeJsonPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const projects = (parsed as { projects?: Record<string, unknown> })?.projects;
  const project = projects?.[workspaceRoot] as { mcpServers?: Record<string, unknown> } | undefined;
  const server = project?.mcpServers?.[name] as
    | { command?: unknown; args?: unknown }
    | undefined;
  if (!server || typeof server.command !== 'string') { return null; }
  const args = Array.isArray(server.args)
    ? server.args.filter((a): a is string => typeof a === 'string')
    : [];
  return { name, command: server.command, args };
}

/** Path to Codex's per-user config file (`~/.codex/config.toml`). */
export function codexConfigPath(homeDir: string): string {
  return join(homeDir, '.codex', 'config.toml');
}

/**
 * Whether Codex's config declares an MCP server by this name.
 *
 * A `[mcp_servers.<name>]` table header is the whole signal, so this is a line
 * match rather than a TOML parse: a dependency-free check that is right when it
 * says yes, and says nothing when the file is absent. It reports what is
 * *configured*, not what a running Codex would resolve — `aidlc mcp status`
 * asks the CLI itself when that distinction matters.
 */
export function isCodexMcpConfigured(name: string, homeDir: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(codexConfigPath(homeDir), 'utf8');
  } catch {
    return false;
  }
  const header = new RegExp(`^\\s*\\[mcp_servers\\.["']?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\]`, 'm');
  return header.test(raw);
}
