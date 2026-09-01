/**
 * `aidlc mcp` — give a non-Claude harness the same ast-graph server Claude has.
 *
 * This is gap G1 from MULTI_PROVIDER_ALIGNMENT.md §4c. Steps 2, 3, 6 and 7 ask
 * for `blast-radius`; under a CLI that never had the server registered they get
 * nothing back and answer anyway. The VS Code extension registers Claude
 * automatically because `claude mcp add --scope local` is scoped to one project
 * directory. Codex is not: it keeps MCP servers in a per-user config, so
 * registering it silently would repoint every Codex session on the machine at
 * this workspace's graph. That is a decision for the user to make knowingly,
 * which is why it lives behind an explicit command instead of `init`.
 */

import { execFileSync } from 'child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  WorkspaceLoader,
  claudeJsonPath,
  mcpRegistrarFor,
  readProjectMcpServer,
  type McpRegistrar,
  type StdioMcpServer,
} from '@aidlc/core';
import { resolveWorkspaceRoot } from '../workspaceRoot';
import { info } from '../output';

const SERVER_NAME = 'ast-graph';
const PROBE_TIMEOUT_MS = 20_000;

/** Runner ids that name a CLI we know how to configure. */
function registrarOrExit(runner: string): McpRegistrar {
  const registrar = mcpRegistrarFor(runner);
  if (!registrar) {
    console.error(chalk.red(
      `No MCP registration is known for runner "${runner}". Known: default (claude), codex.`,
    ));
    process.exit(1);
  }
  return registrar;
}

/**
 * The server definition to copy, taken from Claude's own project config so the
 * binary path is whatever the extension actually installed. Exits with an
 * actionable message rather than guessing a path.
 */
function serverOrExit(root: string): StdioMcpServer {
  const server = readProjectMcpServer(root, SERVER_NAME, claudeJsonPath());
  if (!server) {
    console.error(chalk.red(
      `No "${SERVER_NAME}" server registered for this workspace yet.`,
    ));
    console.error(
      'Run "AIDLC: Rescan AST Graph" in VS Code once — that downloads the binary and\n'
      + 'registers it with Claude. This command then copies that same registration.',
    );
    process.exit(1);
  }
  return server;
}

/** Run a registrar command, returning stdout, or null when the CLI is unusable. */
function probe(cmd: { bin: string; args: string[] }, cwd: string): string | null {
  try {
    return execFileSync(cmd.bin, cmd.args, {
      cwd, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

export function registerMcp(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('Register the ast-graph MCP server with a provider CLI (Codex, Claude)');

  mcp
    .command('status')
    .description('Show which agentic CLIs can currently reach the ast-graph server')
    .action((_opts: unknown, cmd: Command) => {
      const root = resolveWorkspaceRoot(cmd);
      const server = readProjectMcpServer(root, SERVER_NAME, claudeJsonPath());

      info(chalk.bold('\nast-graph MCP'));
      if (!server) {
        info(`  ${chalk.yellow('⚠')}  not registered for this workspace — run "AIDLC: Rescan AST Graph" in VS Code`);
        return;
      }
      info(`  ${chalk.green('✔')}  db: ${server.args[server.args.indexOf('--db') + 1] ?? '(unknown)'}`);

      // One probe per distinct CLI the workspace actually uses. Shelling out is
      // acceptable here because the whole point of the command is to report
      // what a CLI thinks, which nothing else can tell us.
      const ws = WorkspaceLoader.load(root);
      const runners = [...new Set(ws.config.agents.map((a) => a.runner))];
      for (const runner of runners) {
        const registrar = mcpRegistrarFor(runner);
        if (!registrar) {
          info(`  ${chalk.gray('–')}  runner "${runner}": no MCP registration is defined for it`);
          continue;
        }
        const out = probe(registrar.list(), root);
        if (out === null) {
          info(`  ${chalk.yellow('⚠')}  ${registrar.bin}: could not run "${registrar.bin} mcp list" (not installed?)`);
        } else if (registrar.isRegistered(out, SERVER_NAME)) {
          info(`  ${chalk.green('✔')}  ${registrar.bin}: registered`);
        } else {
          info(`  ${chalk.yellow('⚠')}  ${registrar.bin}: not registered — run "aidlc mcp register --runner ${runner}"`);
        }
      }
      info('');
    });

  mcp
    .command('register')
    .description('Copy this workspace\'s ast-graph registration into another CLI\'s config')
    .option('--runner <id>', 'Runner whose CLI to configure (codex, default)', 'codex')
    .option('--dry-run', 'Print the command that would run, and change nothing')
    .action((opts: { runner: string; dryRun?: boolean }, cmd: Command) => {
      const root = resolveWorkspaceRoot(cmd);
      const registrar = registrarOrExit(opts.runner);
      const server = serverOrExit(root);
      const addCmd = registrar.add(server);

      if (registrar.configScope === 'global') {
        info(chalk.yellow(
          `Note: ${registrar.bin} stores MCP servers per user, not per project. This points\n`
          + `every ${registrar.bin} session on this machine at ${root}'s graph.`,
        ));
      }

      const printable = `${addCmd.bin} ${addCmd.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
      if (opts.dryRun) {
        info(printable);
        return;
      }

      try {
        execFileSync(addCmd.bin, addCmd.args, {
          cwd: root, timeout: PROBE_TIMEOUT_MS, stdio: 'inherit',
        });
      } catch (err) {
        console.error(chalk.red(`Failed: ${printable}`));
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      info(chalk.green(`✔ ${SERVER_NAME} registered with ${registrar.bin}.`));
    });
}
