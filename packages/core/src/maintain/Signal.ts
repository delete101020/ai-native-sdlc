/**
 * The production signal — stage 6's only input.
 *
 * Stage 6 (`maintain`) turns something going wrong in production into the
 * `intent.md` of a new epic. What it must *not* do is depend on where the news
 * came from: `incident.md` is the artifact the pipeline gates on, so the phase
 * has to work with no integration configured at all (Q3, locked — see
 * AI_NATIVE_SDLC_ALIGNMENT.md).
 *
 * So the schema is the contract, not the transport. A human pasting five lines
 * of JSON, a Sentry webhook, an alert forwarder and an OTel threshold rule all
 * produce the same five fields; adding a source later is an adapter that fills
 * this shape, never a change to the phase.
 *
 * The fields are deliberately prose, not structured telemetry. `symptom` is what
 * a person observed, in their words — the moment you replace it with an error
 * code you have started diagnosing, and stage 6 exists precisely to keep the
 * symptom and the cause apart.
 */

import { z } from 'zod';

const nonEmpty = (field: string) => z.string().trim().min(1, `\`${field}\` is required`);

export const SignalSchema = z.object({
  /** Where it came from: `manual`, `sentry`, `otel`, `pager`, … Free-form on purpose — new sources are adapters, not schema changes. */
  source: nonEmpty('source'),
  /** When it was *seen*, ISO-8601. Not when it was reported, and not when this ran. */
  observedAt: nonEmpty('observedAt'),
  /** What is wrong, in one line, as observed — never as diagnosed. */
  symptom: nonEmpty('symptom'),
  /** Who / what is affected, and how much. */
  scope: nonEmpty('scope'),
  /** Stack trace, log excerpt, metric window, request id. May be empty — "no data yet" is an honest answer. */
  evidence: z.string().default(''),
});

export type Signal = z.infer<typeof SignalSchema>;

export class SignalParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalParseError';
  }
}

/**
 * Parse and validate a signal from JSON text or an already-parsed object.
 *
 * Throws {@link SignalParseError} with every problem listed at once — the caller
 * is usually a webhook or an unattended run, so a message that fixes the payload
 * in one round-trip is worth more than failing on the first bad field.
 */
export function parseSignal(input: string | unknown): Signal {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      throw new SignalParseError(
        `Signal is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const result = SignalSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new SignalParseError(`Signal is missing or malformed — ${issues}`);
  }
  return result.data;
}

/** True when `raw` is a well-formed signal. For callers that would rather branch than catch. */
export function isSignal(raw: unknown): raw is Signal {
  return SignalSchema.safeParse(raw).success;
}
