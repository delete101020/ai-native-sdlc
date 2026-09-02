import { describe, it, expect } from 'vitest';
import {
  BUILTIN_RATES,
  mergeRates,
  ratesFromConfig,
  providerAliases,
  estimateCostUsd,
  checkBudget,
  resolveProviderModel,
  type PricingTable,
} from '../src/index';

const TABLE: PricingTable = {
  codex: {
    'gpt-5-codex': { inputPerMTok: 1.25, outputPerMTok: 10 },
    '*': { inputPerMTok: 2, outputPerMTok: 20 },
  },
};

describe('estimateCostUsd', () => {
  it('prices a turn from the model-specific rate', () => {
    const est = estimateCostUsd({
      table: TABLE, provider: 'codex', model: 'gpt-5-codex',
      usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
    });
    expect(est?.matched).toBe('gpt-5-codex');
    expect(est?.usd).toBeCloseTo(1.25 + 1.0, 6);
  });

  it('falls back to the provider wildcard for an unlisted model', () => {
    const est = estimateCostUsd({
      table: TABLE, provider: 'codex', model: 'some-new-model',
      usage: { inputTokens: 500_000 },
    });
    expect(est?.matched).toBe('*');
    expect(est?.usd).toBeCloseTo(1.0, 6);
  });

  it('is case-insensitive about the model id', () => {
    const est = estimateCostUsd({
      table: TABLE, provider: 'codex', model: 'GPT-5-Codex',
      usage: { outputTokens: 1_000_000 },
    });
    expect(est?.matched).toBe('gpt-5-codex');
  });

  // The three ways of not knowing. Each must yield undefined — "blind" — and
  // never 0, because 0 sums into a budget total as though it were a fact.
  it('returns undefined when the provider declared no rates', () => {
    expect(estimateCostUsd({
      table: TABLE, provider: 'gemini', model: 'x', usage: { inputTokens: 10 },
    })).toBeUndefined();
  });

  it('returns undefined when the CLI reported no usage', () => {
    expect(estimateCostUsd({ table: TABLE, provider: 'codex', model: 'gpt-5-codex' }))
      .toBeUndefined();
  });

  it('returns undefined for a usage object carrying no token counts', () => {
    expect(estimateCostUsd({
      table: TABLE, provider: 'codex', model: 'gpt-5-codex', usage: {},
    })).toBeUndefined();
  });

  it('treats a missing half of the usage as zero rather than bailing', () => {
    const est = estimateCostUsd({
      table: TABLE, provider: 'codex', model: 'gpt-5-codex',
      usage: { outputTokens: 1_000_000 },
    });
    expect(est?.usd).toBeCloseTo(10, 6);
  });
});

describe('rate table sources', () => {
  // Deliberate: AIDLC ships no prices, because a stale rate produces a
  // plausible total instead of failing loudly. See pricing.ts.
  it('ships no built-in rates', () => {
    expect(BUILTIN_RATES).toEqual({});
  });

  it('reads snake_case workspace config into the internal shape', () => {
    const table = ratesFromConfig({
      codex: {
        model_aliases: {},
        rates: { 'GPT-5-Codex': { input_per_mtok: 1.25, output_per_mtok: 10 } },
      },
    });
    expect(table.codex['gpt-5-codex']).toEqual({ inputPerMTok: 1.25, outputPerMTok: 10 });
  });

  it('omits a provider that declares no rates at all', () => {
    const table = ratesFromConfig({ codex: { model_aliases: { sonnet: 'x' }, rates: {} } });
    expect(table.codex).toBeUndefined();
  });

  it('lets user rates win over a builtin for the same model', () => {
    const merged = mergeRates({ codex: { a: { inputPerMTok: 9, outputPerMTok: 9 } } });
    expect(merged.codex.a.inputPerMTok).toBe(9);
  });
});

describe('providerAliases', () => {
  it('lowercases keys so Sonnet and sonnet resolve alike', () => {
    const aliases = providerAliases(
      { codex: { model_aliases: { Sonnet: 'gpt-5-codex' }, rates: {} } }, 'codex');
    expect(aliases.sonnet).toBe('gpt-5-codex');
  });

  it('is empty for a provider with no declaration', () => {
    expect(providerAliases({}, 'gemini')).toEqual({});
  });
});

describe('resolveProviderModel with a declared alias map', () => {
  const aliases = { sonnet: 'gpt-5-codex' };

  it('translates a Claude tier alias the user mapped', () => {
    expect(resolveProviderModel('codex', 'sonnet', aliases)).toBe('gpt-5-codex');
  });

  it('still resolves an unmapped tier alias to nothing', () => {
    expect(resolveProviderModel('codex', 'opus', aliases)).toBeUndefined();
  });

  it('never overrides Claude Code, which resolves its own tiers', () => {
    expect(resolveProviderModel('default', 'sonnet', aliases)).toBeUndefined();
  });

  it('passes an explicit model through even when a map exists', () => {
    expect(resolveProviderModel('codex', 'o4-mini', aliases)).toBe('o4-mini');
  });
});

describe('checkBudget cost confidence', () => {
  it('splits the total into measured and estimated', () => {
    const v = checkBudget({
      stepCosts: [1, 2, undefined],
      stepAccounting: ['measured', 'estimated', 'blind'],
    });
    expect(v.spent).toBe(3);
    expect(v.measured).toBe(1);
    expect(v.estimated).toBe(2);
    expect(v.blindSteps).toBe(1);
  });

  // An estimate is worth less than a measurement but far more than nothing:
  // excluding it would leave a Codex-only run with no ceiling whatsoever.
  it('counts an estimate against the ceiling', () => {
    const v = checkBudget({
      stepCosts: [5],
      stepAccounting: ['estimated'],
      budget: { max_usd: 1, on_exceed: 'pause' },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.exceeded).toBe('total'); }
  });

  it('reports blind steps even while the run is under budget', () => {
    const v = checkBudget({
      stepCosts: [0.5, undefined],
      stepAccounting: ['measured', 'blind'],
      budget: { max_usd: 10, on_exceed: 'pause' },
    });
    expect(v.ok).toBe(true);
    expect(v.blindSteps).toBe(1);
  });

  it('infers measured/absent when no accounting array is supplied', () => {
    const v = checkBudget({ stepCosts: [1, undefined] });
    expect(v.measured).toBe(1);
    expect(v.estimated).toBe(0);
    // A step with no cost and no accounting hint has not necessarily run —
    // counting it as blind would invent a warning out of a queued step.
    expect(v.blindSteps).toBe(0);
  });
});
