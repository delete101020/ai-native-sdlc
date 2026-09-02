/**
 * Turning a provider's reported token counts into a dollar figure
 * (MULTI_PROVIDER_ALIGNMENT.md §P3).
 *
 * Two kinds of number reach the budget guard and they must never be confused:
 *
 *   - **measured** — `RunnerResult.costUsd`. Claude Code computes the cost of
 *     the turn itself and reports it in the final `result` event. It accounts
 *     for cache reads, cache writes and the plan the account is actually on.
 *   - **estimated** — `RunnerResult.usage` multiplied by a rate from this
 *     module. Codex reports tokens, not dollars, so this is the only way its
 *     runs contribute to a ceiling at all.
 *
 * An estimate is carried with `estimated: true` all the way to the report, so
 * a total that contains one is printed as an estimate rather than as a fact.
 * That is the whole reason this module exists as a separate concept instead of
 * quietly writing into `costUsd`: P0/D5 forbids presenting a confident wrong
 * total, not arithmetic.
 */

import type { RunnerUsage } from '../runner/types';
import type { ProviderConfig } from '../schema/WorkspaceSchema';

/** Price of one model, in USD per million tokens. */
export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** `provider → model id → rate`. `*` as a model id is that provider's fallback. */
export type PricingTable = Record<string, Record<string, ModelRate>>;

export interface CostEstimate {
  usd: number;
  /** The table key the rate came from — the model id, or `*`. */
  matched: string;
  rate: ModelRate;
}

/**
 * Deliberately empty.
 *
 * The obvious move here is to ship a table of published per-token prices. We
 * do not, for two reasons that both end in the same place — a number the user
 * would trust and should not:
 *
 *   1. Prices change without warning and this file would not. A stale rate
 *      does not fail loudly like a renamed CLI flag does; it silently produces
 *      a plausible total, which is worse than producing none.
 *   2. What a run actually costs depends on the account — committed-use
 *      discounts, credits, an enterprise agreement, a free tier.
 *
 * So AIDLC ships the mechanism and the honesty, and the user supplies the
 * vendor fact we cannot verify, in `workspace.yaml`:
 *
 * ```yaml
 * providers:
 *   codex:
 *     rates:
 *       "*": { input_per_mtok: 1.25, output_per_mtok: 10.0 }
 * ```
 *
 * Claude needs no entry: `DefaultRunner` reports a measured cost, which always
 * wins over an estimate.
 */
export const BUILTIN_RATES: PricingTable = {};

/**
 * The model-alias map for one runner, with keys lowercased so a lookup of
 * `Sonnet` and `sonnet` behave the same. Lives beside the rate reader because
 * both answer the same question — what did the user declare about this
 * provider that AIDLC is not entitled to assume?
 */
export function providerAliases(
  providers: Record<string, ProviderConfig> | undefined,
  runner: string,
): Record<string, string> {
  const declared = providers?.[runner]?.model_aliases ?? {};
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(declared)) {
    out[from.trim().toLowerCase()] = to;
  }
  return out;
}

/**
 * Read the `providers:` block of a workspace into a pricing table, translating
 * the YAML's snake_case into this module's shape. Providers that declare no
 * rates are simply absent — absent means blind, and blind is reported.
 */
export function ratesFromConfig(providers: Record<string, ProviderConfig> | undefined): PricingTable {
  const table: PricingTable = {};
  for (const [provider, cfg] of Object.entries(providers ?? {})) {
    const models: Record<string, ModelRate> = {};
    for (const [model, rate] of Object.entries(cfg.rates ?? {})) {
      models[model.trim().toLowerCase()] = {
        inputPerMTok: rate.input_per_mtok,
        outputPerMTok: rate.output_per_mtok,
      };
    }
    if (Object.keys(models).length > 0) { table[provider] = models; }
  }
  return mergeRates(table);
}

/** Merge user-declared rates over the builtins, per provider. */
export function mergeRates(user: PricingTable | undefined): PricingTable {
  const merged: PricingTable = {};
  for (const [provider, models] of Object.entries(BUILTIN_RATES)) {
    merged[provider] = { ...models };
  }
  for (const [provider, models] of Object.entries(user ?? {})) {
    merged[provider] = { ...(merged[provider] ?? {}), ...models };
  }
  return merged;
}

/**
 * Estimate what a turn cost, or `undefined` when we cannot say — no usage
 * reported, no rate declared for this provider/model, or a usage object with
 * neither token count in it. `undefined` means *blind*, and blind is reported
 * as blind rather than folded in as zero.
 */
export function estimateCostUsd(args: {
  table: PricingTable;
  provider: string;
  model?: string;
  usage?: RunnerUsage;
}): CostEstimate | undefined {
  const { table, provider, model, usage } = args;
  if (!usage) { return undefined; }

  const input = usage.inputTokens;
  const output = usage.outputTokens;
  if (typeof input !== 'number' && typeof output !== 'number') { return undefined; }

  const models = table[provider];
  if (!models) { return undefined; }

  const key = model?.trim().toLowerCase();
  const matched = key && models[key] ? key : (models['*'] ? '*' : undefined);
  if (!matched) { return undefined; }

  const rate = models[matched];
  const usd = ((input ?? 0) * rate.inputPerMTok + (output ?? 0) * rate.outputPerMTok) / 1_000_000;
  return { usd, matched, rate };
}
