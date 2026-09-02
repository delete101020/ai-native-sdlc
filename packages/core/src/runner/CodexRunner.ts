/**
 * Codex runner — the first non-Claude harness (MULTI_PROVIDER_ALIGNMENT.md §P1).
 *
 * Shape A: `codex exec` is an agentic CLI with its own tool loop. It reads and
 * writes files itself, so AIDLC hands it a prompt and gets out of the way —
 * exactly the deal `DefaultRunner` has with `claude`. No write-back, no tool
 * shims (P0, D4).
 *
 * Two things differ from Claude and both shape the code below:
 *
 * 1. **There is no system-prompt flag.** `claude` takes
 *    `--append-system-prompt`; `codex exec` takes one prompt. P1a already made
 *    the composed prompt self-contained (persona + project instructions +
 *    skills), so the phase loses nothing by having it prepended to the task
 *    instead of layered underneath it.
 * 2. **Codex reports tokens, not dollars.** `costUsd` is therefore left
 *    `undefined` — the budget guard counts this step as 0 and `aidlc doctor`
 *    says so out loud rather than presenting a confident wrong total (P0, D5).
 *    Tokens land in `usage`, where P3 can price them against a real table.
 *
 * Flags are deliberately few and every one of them is an option: a CLI we do
 * not pin is a CLI that can rename a flag (§6, open question 1), and a wrong
 * flag fails loudly at spawn rather than quietly degrading a run.
 */

import { spawn } from 'child_process';

import type { AidlcRunner, HarnessCapabilities, RunnerContext, RunnerResult } from './types';
import { codexMcpRegistrar } from './mcp';
import { createJsonSink } from './ndjson';
import { resolveProviderModel } from '../presets/models';

export interface CodexRunnerOptions {
  /** Override the codex binary. Default: `codex` on PATH. */
  codexBin?: string;
  /**
   * Sandbox policy handed to `codex exec`. `workspace-write` is the default
   * because AIDLC phases exist to produce artifacts: a read-only sandbox would
   * let `implement` "succeed" having written nothing, which `produces`
   * validation would then report as a missing file with no explanation.
   */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Extra args inserted before the prompt, for flags we do not model. */
  extraArgs?: string[];
}

export class CodexRunner implements AidlcRunner {
  /**
   * What the Codex harness supplies on its own — declared conservatively, per
   * P0/D7. `projectInstructions` is `false` even though Codex does read
   * `AGENTS.md`, because most AIDLC repos carry `CLAUDE.md` and no `AGENTS.md`:
   * saying `true` here would mean the phase silently runs with no project
   * conventions at all whenever the sibling file is absent. Declaring `false`
   * and naming `AGENTS.md` as the preferred file gets both cases right — the
   * composer inlines `AGENTS.md` when the repo has one and `CLAUDE.md` when it
   * does not, and AIDLC still never writes either (P0).
   *
   * `astGraph: false` until `aidlc mcp register` has been run: Codex keeps MCP
   * servers in a per-user config, so AIDLC cannot assume a workspace's graph is
   * reachable the way it can for Claude's project-scoped registration.
   */
  readonly capabilities: HarnessCapabilities = {
    persona: false,
    projectInstructions: false,
    astGraph: false,
    instructionFile: 'AGENTS.md',
  };

  readonly mcp = codexMcpRegistrar;

  constructor(private readonly opts: CodexRunnerOptions = {}) {}

  async run(ctx: RunnerContext): Promise<RunnerResult> {
    const bin = this.opts.codexBin ?? 'codex';
    const model = resolveProviderModel('codex', ctx.model, ctx.modelAliases);

    const args = [
      'exec',
      '--json',
      '--sandbox', this.opts.sandbox ?? 'workspace-write',
      ...(model ? ['--model', model] : []),
      ...(this.opts.extraArgs ?? []),
      buildPrompt(ctx),
    ];

    const proc = spawn(bin, args, {
      cwd: ctx.workspaceRoot,
      env: { ...process.env, ...ctx.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let streamed = '';
    let lastMessage = '';
    let sawDelta = false;
    let usage: RunnerResult['usage'];

    const emit = (text: string): void => {
      streamed += text;
      ctx.onOutput(text);
    };

    const handle = (evt: CodexEvent): void => {
      // Codex has carried more than one envelope over its releases: events used
      // to arrive wrapped in `msg`, newer builds emit `item.*` at the top level.
      // Unwrapping both costs three lines and saves a silent blackout the day a
      // user upgrades their CLI.
      const body = (evt.msg ?? evt.item ?? evt) as CodexEventBody;
      const type = body.type ?? evt.type ?? '';

      if (type.includes('agent_message_delta') || type.includes('output_text.delta')) {
        const delta = body.delta ?? body.text ?? '';
        if (delta) { sawDelta = true; emit(delta); }
        return;
      }
      if (type.includes('agent_message') || type === 'item.completed') {
        const text = body.message ?? body.text ?? '';
        if (!text) { return; }
        lastMessage = text;
        // Deltas already streamed this message — printing it again would double
        // every phase's output in the terminal.
        if (!sawDelta) { emit(text); }
        sawDelta = false;
        return;
      }
      if (type.includes('token_count') || type.includes('usage')) {
        usage = readUsage(body) ?? usage;
        return;
      }
      if (type === 'task_complete' || type === 'turn.completed') {
        if (body.last_agent_message) { lastMessage = body.last_agent_message; }
        return;
      }
      if (type === 'error' || type === 'stream_error') {
        ctx.onError(`${body.message ?? 'codex reported an error'}\n`);
      }
    };

    const sink = createJsonSink<CodexEvent>(handle, (line) => ctx.onOutput(line + '\n'));

    proc.stdout.on('data', (d: Buffer) => sink.push(d.toString('utf8')));
    proc.stderr.on('data', (d: Buffer) => ctx.onError(d.toString('utf8')));

    return new Promise<RunnerResult>((resolve) => {
      proc.on('error', (err) => {
        ctx.onError(`Failed to spawn ${bin}: ${err.message}\n`);
        resolve({ success: false, output: '', usage });
      });
      proc.on('close', (code) => {
        sink.flush();
        resolve({
          success: code === 0,
          output: lastMessage || streamed,
          // No costUsd: Codex does not report dollars, and inventing one from
          // tokens would make the budget guard confidently wrong (P0, D5).
          usage,
        });
      });
    });
  }
}

/**
 * One prompt out of a system prompt and a task, because `codex exec` takes no
 * system-prompt flag. The headings mirror the composer's own so a phase reads
 * the same whichever harness runs it.
 */
export function buildPrompt(ctx: Pick<RunnerContext, 'skill' | 'args'>): string {
  const task = ctx.args.join(' ').trim();
  const skill = ctx.skill.trim();
  if (!task) { return skill; }
  if (!skill) { return task; }
  return `${skill}\n\n---\n\n## Task\n\n${task}\n`;
}

/**
 * Token counts, wherever this Codex build puts them. Returns undefined rather
 * than zeros when nothing is recognisable — a missing number and a measured
 * zero must not look alike downstream.
 */
function readUsage(body: CodexEventBody): RunnerResult['usage'] | undefined {
  const info = body.info ?? body.usage ?? body;
  const totals = (info as Record<string, unknown>)?.total_token_usage ?? info;
  const t = totals as Record<string, unknown> | undefined;
  if (!t) { return undefined; }
  const input = numberAt(t, 'input_tokens', 'inputTokens', 'prompt_tokens');
  const output = numberAt(t, 'output_tokens', 'outputTokens', 'completion_tokens');
  if (input === undefined && output === undefined) { return undefined; }
  return { inputTokens: input, outputTokens: output };
}

function numberAt(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) { return v; }
  }
  return undefined;
}

/** The slice of Codex's JSONL we read. Everything else is ignored on purpose. */
interface CodexEventBody {
  type?: string;
  message?: string;
  text?: string;
  delta?: string;
  last_agent_message?: string;
  info?: unknown;
  usage?: unknown;
}

interface CodexEvent extends CodexEventBody {
  msg?: CodexEventBody;
  item?: CodexEventBody;
}
