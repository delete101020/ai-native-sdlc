/**
 * GitHub Copilot CLI runner — a shape A harness (MULTI_PROVIDER_ALIGNMENT.md §4).
 *
 * `copilot -p` is an agentic CLI with its own tool loop: it reads, writes and
 * runs shell commands itself, so AIDLC hands it the composed prompt and gets out
 * of the way, exactly as it does with `claude` and `codex exec`.
 *
 * Verified live against Copilot CLI 1.0.88 (2026-09-27). Four things differ from
 * the other runners and shape the code below:
 *
 * 1. **The prompt goes in on stdin.** Piped stdin is a documented prompt source,
 *    and the composed prompt (persona + project instructions + skills) easily
 *    passes the ~32 KB command-line limit on Windows.
 * 2. **ast-graph is attached per run, not registered.** `--additional-mcp-config`
 *    adds a server for this session only, so the runner copies the workspace's
 *    graph server out of Claude's project config and passes it in. Codex could
 *    only be given a per-user entry that leaks across workspaces; this closes G1
 *    without writing to any config file.
 * 3. **The built-in GitHub MCP server is disabled.** Asked for a graph tool it
 *    could not reach, Copilot fell back to GitHub code search and confidently
 *    answered from an unrelated public repository. Claude has no such fallback,
 *    and a phase querying public code for a private repo's symbols is both a
 *    wrong answer and a leak.
 * 4. **Copilot reports premium requests, not tokens or dollars.** `costUsd` and
 *    `usage` stay undefined, so the budget guard counts the step as blind and
 *    says so (P0, D5). The request count is kept in `data`.
 */

import { spawn } from 'child_process';

import type { AidlcRunner, HarnessCapabilities, RunnerContext, RunnerResult } from './types';
import { buildPrompt } from './CodexRunner';
import { claudeJsonPath } from '../util/claudeHome';
import { readProjectMcpServer, type StdioMcpServer } from './mcp';
import { createJsonSink } from './ndjson';
import { resolveProviderModel } from '../presets/models';
import { resolveCommand } from '../util/resolveCommand';

/** Graph servers the extension may register, in the order they are looked up. */
const GRAPH_SERVERS = ['ast-graph', 'codegraph'];

export interface CopilotRunnerOptions {
  /** Override the copilot binary. Default: `copilot` on PATH. */
  copilotBin?: string;
  /** Keep Copilot's built-in GitHub MCP server. Default false — see point 3 above. */
  keepBuiltinMcps?: boolean;
  /**
   * Where the graph server definition comes from. Default: Claude's project
   * config, which is where the extension registers it. Injected by tests.
   */
  graphServer?: (workspaceRoot: string) => StdioMcpServer | null;
  /** Extra args inserted before the prompt source, for flags we do not model. */
  extraArgs?: string[];
}

export class CopilotRunner implements AidlcRunner {
  /**
   * `projectInstructions` is `false` although Copilot reads a root `CLAUDE.md`
   * and `AGENTS.md` by itself: it does not read `.claude/CLAUDE.md`, and the
   * composer cannot know which layout a repo uses. Inlining costs a duplicate
   * when the file is at the root; not inlining would cost the conventions when
   * it is not. `CLAUDE.md` is preferred over `AGENTS.md` because a repo that
   * keeps both usually has tool-generated boilerplate in the latter.
   *
   * `astGraph` is `true` because the runner attaches the server on every run
   * that has one registered; `doctor` reports the workspaces that do not.
   */
  readonly capabilities: HarnessCapabilities = {
    persona: false,
    projectInstructions: false,
    astGraph: true,
    instructionFile: 'CLAUDE.md',
  };

  constructor(private readonly opts: CopilotRunnerOptions = {}) {}

  async run(ctx: RunnerContext): Promise<RunnerResult> {
    const bin = this.opts.copilotBin ?? 'copilot';
    const model = resolveProviderModel('copilot', ctx.model, ctx.modelAliases);
    const graph = (this.opts.graphServer ?? copilotGraphServer)(ctx.workspaceRoot);

    const args = [
      // Required for non-interactive runs: without it every tool call waits for
      // a confirmation nobody is there to give.
      '--allow-all-tools',
      '--output-format', 'json',
      '--no-color',
      ...(this.opts.keepBuiltinMcps ? [] : ['--disable-builtin-mcps']),
      ...(graph ? ['--additional-mcp-config', copilotMcpConfig(graph)] : []),
      ...(model ? ['--model', model] : []),
      ...(this.opts.extraArgs ?? []),
    ];

    const cmd = resolveCommand(bin);
    const proc = spawn(cmd.command, [...cmd.args, ...args], {
      cwd: ctx.workspaceRoot,
      env: { ...process.env, ...ctx.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let streamed = '';
    let lastMessage = '';
    const deltaSeen = new Set<string>();
    let premiumRequests: number | undefined;

    const emit = (text: string): void => {
      streamed += text;
      ctx.onOutput(text);
    };

    const handle = (evt: CopilotEvent): void => {
      const d = evt.data ?? {};
      switch (evt.type) {
        case 'assistant.message_delta':
          if (d.deltaContent) {
            if (d.messageId) { deltaSeen.add(d.messageId); }
            emit(d.deltaContent);
          }
          return;
        case 'assistant.message':
          if (!d.content) { return; }
          lastMessage = d.content;
          // Deltas already streamed this message; printing it again would
          // double every phase's output in the terminal.
          if (!d.messageId || !deltaSeen.has(d.messageId)) { emit(d.content); }
          emit('\n');
          return;
        case 'tool.execution_start':
          if (d.toolName) { ctx.onOutput(`[${d.toolTitle ?? d.toolName}]\n`); }
          return;
        case 'session.mcp_server_status_changed':
          // A graph server that fails to start leaves the phase blind while the
          // run still succeeds — say so where the user is looking.
          if (d.status === 'failed') {
            ctx.onError(`MCP server ${d.serverName ?? '?'} failed to start: ${d.error ?? 'unknown error'}\n`);
          }
          return;
        case 'result':
          if (typeof evt.usage?.premiumRequests === 'number') { premiumRequests = evt.usage.premiumRequests; }
          return;
        default:
          if (evt.type?.endsWith('.error')) {
            ctx.onError(`${d.message ?? d.error ?? 'copilot reported an error'}\n`);
          }
      }
    };

    const sink = createJsonSink<CopilotEvent>(handle, (line) => ctx.onOutput(line + '\n'));

    proc.stdout.on('data', (d: Buffer) => sink.push(d.toString('utf8')));
    proc.stderr.on('data', (d: Buffer) => ctx.onError(d.toString('utf8')));
    proc.stdin.on('error', () => { /* surfaced by 'error' / exit code */ });
    proc.stdin.end(buildPrompt(ctx));

    return new Promise<RunnerResult>((resolve) => {
      proc.on('error', (err) => {
        ctx.onError(`Failed to spawn ${bin}: ${err.message}\n`);
        resolve({ success: false, output: '' });
      });
      proc.on('close', (code) => {
        sink.flush();
        resolve({
          success: code === 0,
          output: lastMessage || streamed,
          // No costUsd or usage: Copilot bills premium requests, and turning
          // those into dollars or tokens would be a guess (P0, D5).
          ...(premiumRequests !== undefined ? { data: { premiumRequests } } : {}),
        });
      });
    });
  }
}

/** The workspace's graph server, as the extension registered it for Claude. */
export function copilotGraphServer(workspaceRoot: string): StdioMcpServer | null {
  for (const name of GRAPH_SERVERS) {
    const server = readProjectMcpServer(workspaceRoot, name, claudeJsonPath());
    if (server) { return server; }
  }
  return null;
}

/** `--additional-mcp-config` JSON for one stdio server. */
export function copilotMcpConfig(server: StdioMcpServer): string {
  return JSON.stringify({
    mcpServers: {
      [server.name]: {
        type: 'local',
        command: server.command,
        args: server.args,
        ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
        tools: ['*'],
      },
    },
  });
}

/** The slice of Copilot's JSONL we read. Everything else is ignored on purpose. */
interface CopilotEvent {
  type?: string;
  data?: {
    messageId?: string;
    deltaContent?: string;
    content?: string;
    toolName?: string;
    toolTitle?: string;
    serverName?: string;
    status?: string;
    error?: string;
    message?: string;
  };
  usage?: { premiumRequests?: number };
}
