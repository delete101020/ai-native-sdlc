/**
 * Register a code-graph MCP server (ast-graph or codegraph) with Claude at
 * `local` scope via the `claude mcp` CLI. Local scope = scoped to one project
 * dir, which matches our per-workspace index.
 *
 * The per-CLI argv lives in `@aidlc/core`'s registrars, so the same spawn code
 * serves any agentic CLI (gap G1) and the flag knowledge stays unit-testable
 * without that CLI installed.
 *
 * "Is it already registered?" is answered by reading Claude's own config file
 * (`~/.claude.json` → `projects[<root>].mcpServers`), not `claude mcp list`:
 * `list` health-checks every configured server, which cost several seconds on
 * every extension activation. We only spawn `claude` when the entry is missing
 * or points somewhere else (binary moved, version bump, db path changed).
 *
 * Failure modes (all non-fatal, surfaced via the returned status):
 *   - `claude` not on PATH (user installed extension but not the CLI)
 *   - `claude mcp add` returns non-zero
 *   - The CLI takes longer than 15s to respond
 */

import { execFile } from 'child_process';

import { claudeConfigEnv, claudeJsonPath, claudeMcpRegistrar, readProjectMcpServer, resolveCommand } from '@aidlc/core';
import type { McpCommand, McpRegistrar, StdioMcpServer } from '@aidlc/core';

export interface McpRegistration {
  ok: boolean;
  /** When false, this string explains why (CLI missing, timeout, error). */
  reason: string;
}

const CLI_TIMEOUT_MS = 15_000;

interface EnsureOpts {
  server: StdioMcpServer;
  cwd: string;
  /** Skip the config-file short-circuit and always rewrite the entry. */
  force?: boolean;
  /**
   * Which CLI's config to write. Defaults to Claude, which is the only one the
   * extension registers automatically: Claude's `--scope local` is per-project,
   * so a registration cannot leak into the user's other workspaces. Codex keeps
   * MCP servers per-user, so it is registered only on explicit request —
   * `aidlc mcp register --runner codex`. See MULTI_PROVIDER_ALIGNMENT.md §4c G1.
   */
  registrar?: McpRegistrar;
}

/** The entry Claude currently has for `name` in this project, or null. */
export function registeredServer(cwd: string, name: string): StdioMcpServer | null {
  return readProjectMcpServer(cwd, name, claudeJsonPath());
}

function sameServer(a: StdioMcpServer, b: StdioMcpServer): boolean {
  const env = (s: StdioMcpServer) => JSON.stringify(Object.entries(s.env ?? {}).sort());
  return a.command === b.command
    && a.args.length === b.args.length
    && a.args.every((x, i) => x === b.args[i])
    && env(a) === env(b);
}

/**
 * Make Claude's local-scope entry for `server.name` match `server` exactly.
 * No-op (no spawn) when it already does. An entry that differs is removed
 * first — `claude mcp add` refuses to overwrite an existing name.
 */
export async function ensureMcpServer(opts: EnsureOpts): Promise<McpRegistration> {
  const registrar = opts.registrar ?? claudeMcpRegistrar;
  const existing = registeredServer(opts.cwd, opts.server.name);
  if (!opts.force && existing && sameServer(existing, opts.server)) {
    return { ok: true, reason: 'already registered' };
  }
  if (existing) {
    await runCli(registrar.remove(opts.server.name), opts.cwd);
  }
  return runCli(registrar.add(opts.server), opts.cwd);
}

/** Drop our local-scope entry for `name`, if Claude has one. */
export async function removeMcpServer(
  cwd: string,
  name: string,
  registrar: McpRegistrar = claudeMcpRegistrar,
): Promise<McpRegistration> {
  if (!registeredServer(cwd, name)) return { ok: true, reason: 'not registered' };
  return runCli(registrar.remove(name), cwd);
}

function runCli(cmd: McpCommand, cwd: string): Promise<McpRegistration> {
  return new Promise((resolve) => {
    // resolveCommand: on Windows `claude` is usually an npm .cmd shim, which
    // execFile cannot start (ENOENT) — unwrap it to the real executable.
    const exe = resolveCommand(cmd.bin);
    execFile(
      exe.command,
      [...exe.args, ...cmd.args],
      { timeout: CLI_TIMEOUT_MS, cwd, env: { ...process.env, ...claudeConfigEnv() } },
      (err, _stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            resolve({ ok: false, reason: `\`${cmd.bin}\` not found on PATH — install that CLI to enable MCP.` });
            return;
          }
          if ((err as { killed?: boolean }).killed) {
            resolve({ ok: false, reason: `${cmd.bin} ${cmd.args.slice(0, 2).join(' ')} timed out (>15s).` });
            return;
          }
          resolve({
            ok: false,
            reason: (stderr || err.message).toString().trim().split(/\r?\n/).slice(-3).join(' | '),
          });
          return;
        }
        resolve({ ok: true, reason: '' });
      },
    );
  });
}
