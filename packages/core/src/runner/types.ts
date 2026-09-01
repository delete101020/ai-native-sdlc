/**
 * Runner plugin contract — every agent invocation goes through one of these.
 *
 * The default implementation shells out to the `claude` CLI; users on Pro
 * tier can ship a custom JS module via `runner_path` in their workspace.yaml
 * to take full control of execution (custom system prompts, tool injection,
 * external API calls, etc.).
 */

import type { McpRegistrar } from './mcp';

export interface RunnerContext {
  /** Skill markdown content (system prompt). */
  skill: string;
  /** Resolved environment variables (workspace + agent layered, secrets expanded). */
  env: Record<string, string>;
  /** Slash command args, already split. */
  args: string[];
  /** Absolute path to the user's project root (where .aidlc/ lives). */
  workspaceRoot: string;
  /** Stream chunk to terminal/output channel. Always full UTF-8 strings. */
  onOutput: (chunk: string) => void;
  /** Stream stderr / error chunk. */
  onError: (chunk: string) => void;
  /**
   * Optional shorthand wrapper around the claude CLI. Custom runners MAY use
   * this for convenience but are free to bypass it. Phase 1 leaves this `null`
   * — the wrapper is fleshed out in Phase 2 once the extension wires terminals.
   */
  claude: AgentCliWrapper | null;
  /**
   * Model the workspace asked this agent to run on (`agent.model`), verbatim.
   *
   * A runner is free to ignore it, and `DefaultRunner` deliberately does: Claude
   * Code already resolves the tier itself, and passing `--model` where we never
   * passed one would change which model answers — a quality change, not a
   * feature. Provider runners need it, because `sonnet` means nothing to them.
   */
  model?: string;
}

/** @deprecated Renamed to `AgentCliWrapper`. Kept so existing custom runners compile. */
export type ClaudeCliWrapper = AgentCliWrapper;

/**
 * Minimal interface the bundled agent-CLI helper will satisfy. Defined here so
 * custom runner authors can type-check against it without depending on the
 * concrete implementation (which lives in the extension layer).
 *
 * Named for the shape, not the vendor: `claude`, `codex exec` and the Gemini
 * CLI are all "spawn a CLI with a prompt and stream its output".
 */
export interface AgentCliWrapper {
  /**
   * Spawn `claude` with the given system prompt + user message + env. Streams
   * output through the runner's onOutput / onError. Resolves with the final
   * collected output and exit code.
   */
  run(opts: {
    systemPrompt: string;
    userMessage: string;
    env?: Record<string, string>;
  }): Promise<{ content: string; exitCode: number }>;
}

export interface RunnerResult {
  success: boolean;
  /** Final assembled output. May be empty if the runner streamed only. */
  output: string;
  /**
   * Total LLM cost of this invocation in USD, when the runner can report it
   * (the default runner reads claude's `total_cost_usd`). Undefined when the
   * runner doesn't track cost — budget accumulation treats that as 0.
   */
  costUsd?: number;
  /**
   * Token usage, when the CLI reports it. Codex reports tokens but not dollars,
   * so `usage` and `costUsd` are independent: a runner fills in whichever its
   * CLI actually gives it, and neither is ever derived from the other. Pricing
   * tokens we did not measure is P3's problem, and only with a real price table.
   */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Optional structured payload (parsed JSON, file paths produced, etc.). */
  data?: unknown;
}

/**
 * What a runner's harness already supplies on its own, without AIDLC putting it
 * in the prompt. Each flag means "the model will see this even if we say
 * nothing" — so the prompt composer inlines exactly the flags that are false.
 *
 * The point is that the *composed prompt* differs per harness while the
 * *information reaching the model* does not. Claude Code loads `CLAUDE.md`
 * itself, so inlining it there would duplicate a document, not add one; it does
 * not load `.claude/agents/<id>.md` for a `--print` invocation, so the persona
 * has to be inlined even for Claude.
 *
 * See MULTI_PROVIDER_ALIGNMENT.md §4c (gaps G1–G3).
 */
export interface HarnessCapabilities {
  /** The harness loads the agent's persona file by itself. */
  persona: boolean;
  /** The harness loads the repository's instruction file (CLAUDE.md / AGENTS.md / …). */
  projectInstructions: boolean;
  /** The harness can reach the `ast-graph` MCP server. */
  astGraph: boolean;
  /**
   * Instruction filename this harness reads natively, when it reads one. Used
   * to pick which file to inline for harnesses that read none — a repo keeping
   * both `CLAUDE.md` and `AGENTS.md` should give Codex the latter.
   */
  instructionFile?: string;
}

/**
 * What we assume when a runner declares nothing — a custom runner written
 * against the Phase 1 SPI, whose harness we cannot inspect. Assume it supplies
 * nothing and inline everything: an unnecessary inline costs tokens, a missing
 * one costs the phase its persona or the project's conventions.
 */
export const NO_HARNESS_CAPABILITIES: HarnessCapabilities = {
  persona: false,
  projectInstructions: false,
  astGraph: false,
};

export interface AidlcRunner {
  run(ctx: RunnerContext): Promise<RunnerResult>;
  /**
   * Optional. Omitted ⇒ `NO_HARNESS_CAPABILITIES`, so existing custom runners
   * keep working and simply start receiving a fuller prompt.
   */
  readonly capabilities?: HarnessCapabilities;
  /**
   * How to register a stdio MCP server with this runner's CLI, when it has one.
   * Omitted ⇒ AIDLC has no way to give this harness the `ast-graph` server, and
   * `doctor` says so instead of implying the tools are there.
   */
  readonly mcp?: McpRegistrar;
}

/** Capabilities of a runner, with the conservative default applied. */
export function harnessCapabilities(runner: AidlcRunner): HarnessCapabilities {
  return runner.capabilities ?? NO_HARNESS_CAPABILITIES;
}

/** Thrown by CustomRunnerLoader when a user's runner_path file is malformed. */
export class RunnerValidationError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`[runner ${path}] ${message}`);
    this.name = 'RunnerValidationError';
  }
}
