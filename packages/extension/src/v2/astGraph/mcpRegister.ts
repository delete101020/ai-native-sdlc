/**
 * Register the bundled `ast-graph` binary as a `local`-scoped MCP server
 * via the `claude mcp` CLI. Local scope = scoped to one project dir,
 * which matches our per-workspace db.
 *
 * The per-CLI argv lives in `@aidlc/core`'s registrars, so the same spawn code
 * serves any agentic CLI (gap G1) and the flag knowledge stays unit-testable
 * without that CLI installed.
 *
 * We re-run `claude mcp add` whenever the binary path or db path change
 * (e.g. version bump, workspace switch). `claude mcp` is idempotent —
 * it overwrites an existing entry with the same name.
 *
 * Failure modes (all non-fatal, surfaced via the returned status):
 *   - `claude` not on PATH (user installed extension but not the CLI)
 *   - `claude mcp add` returns non-zero
 *   - The CLI takes longer than 15s to respond
 */

import { execFile } from 'child_process';

import { claudeConfigEnv, claudeMcpRegistrar } from '@aidlc/core';
import type { McpRegistrar } from '@aidlc/core';

export interface McpRegistration {
  ok: boolean;
  /** When false, this string explains why (CLI missing, timeout, error). */
  reason: string;
}

export const MCP_NAME = 'ast-graph';
const ADD_TIMEOUT_MS = 15_000;

interface RegisterOpts {
  binPath: string;
  dbPath: string;
  cwd: string;
  claudeBin?: string;
  /**
   * Which CLI's config to write. Defaults to Claude, which is the only one the
   * extension registers automatically: Claude's `--scope local` is per-project,
   * so a registration cannot leak into the user's other workspaces. Codex keeps
   * MCP servers per-user, so it is registered only on explicit request —
   * `aidlc mcp register --runner codex`. See MULTI_PROVIDER_ALIGNMENT.md §4c G1.
   */
  registrar?: McpRegistrar;
}

/**
 * Run `claude mcp add ast-graph --scope local -- <binPath> mcp --db <dbPath>`
 * inside `cwd` (the workspace folder). Returns a status object — callers
 * decide whether to surface the failure to the user.
 */
export function registerMcpServer(opts: RegisterOpts): Promise<McpRegistration> {
  const registrar = opts.registrar ?? claudeMcpRegistrar;
  const cmd = registrar.add({
    name: MCP_NAME,
    command: opts.binPath,
    args: ['mcp', '--db', opts.dbPath],
  });
  const claude = opts.claudeBin ?? cmd.bin;

  return new Promise((resolve) => {
    execFile(
      claude,
      cmd.args,
      { timeout: ADD_TIMEOUT_MS, cwd: opts.cwd, env: { ...process.env, ...claudeConfigEnv() } },
      (err, _stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            resolve({ ok: false, reason: `\`${claude}\` not found on PATH — install that CLI to enable MCP.` });
            return;
          }
          if (code === 'ETIMEDOUT') {
            resolve({ ok: false, reason: `${claude} mcp add timed out (>15s).` });
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

/**
 * Check whether ast-graph is already registered locally for `cwd`.
 * Reads `claude mcp list` and looks for our name. Failure = "unknown",
 * we still attempt to register in that case.
 */
export function isAlreadyRegistered(
  cwd: string,
  claudeBin?: string,
  registrar: McpRegistrar = claudeMcpRegistrar,
): Promise<boolean> {
  const cmd = registrar.list();
  return new Promise((resolve) => {
    execFile(
      claudeBin ?? cmd.bin,
      cmd.args,
      { timeout: 20_000, cwd, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...claudeConfigEnv() } },
      (err, stdout) => {
        if (err) { resolve(false); return; }
        resolve(registrar.isRegistered(stdout, MCP_NAME));
      },
    );
  });
}
