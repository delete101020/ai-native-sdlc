import { describe, expect, it } from 'vitest';
import { calcCost, DEFAULT_PRICE, modelPrice } from '../src/v2/tokenPricing';

describe('modelPrice', () => {
  it('matches a point release before its base id', () => {
    expect(modelPrice('claude-opus-5-5').in).toBe(4.0);
    expect(modelPrice('claude-opus-5').in).toBe(5.0);
    expect(modelPrice('claude-fable-5-1').cr).toBe(0.25);
    expect(modelPrice('claude-fable-5').cr).toBe(1.0);
  });

  it('prices Opus 4.8 at the reduced Opus 4.5+ rate, not legacy Opus 4', () => {
    expect(modelPrice('claude-opus-4-8').in).toBe(5.0);
  });

  it('prices Sonnet 5 on its own row', () => {
    expect(modelPrice('claude-sonnet-5')).toMatchObject({ in: 2.0, out: 10.0 });
  });

  it('falls back to the default for an unknown model', () => {
    expect(modelPrice('something-else')).toBe(DEFAULT_PRICE);
  });
});

describe('calcCost', () => {
  it('bills each token kind at its own Opus 5.5 rate', () => {
    const usd = calcCost({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
    }, 'claude-opus-5-5');
    expect(usd).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
  });
});
