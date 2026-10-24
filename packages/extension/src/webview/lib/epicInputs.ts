/**
 * The Start Epic modal's two views of one `inputs.json`: a field per
 * capability, or the whole object as free JSON. Switching views round-trips
 * through these helpers so nothing typed in either one is lost — a capability
 * filled in the form shows up in the JSON, and a key the form has no field for
 * (`legacy_source: { kind, root, entry[] }`) waits in `extra` until submit.
 *
 * The reserved keys mirror `@aidlc/core`'s `RESERVED_INPUT_KEYS`; the host
 * checks again with `parseExtraInputs`, so this copy only decides how early the
 * user hears about a clash.
 */

export const RESERVED_INPUT_KEYS: readonly string[] = ['from_epic', 'follow_up_key', 'also_from', 'extra_projects'];

export interface SplitInputs {
  /** Capability → string value, the part the form can show. */
  fields: Record<string, string>;
  /** Everything else: keys with no field, and capability keys holding a non-string. */
  extra: Record<string, unknown>;
}

/** The JSON view of the form: filled capabilities in field order, then the extra keys. */
export function inputsToJson(
  fields: Record<string, string>,
  extra: Record<string, unknown>,
  capabilities: string[],
): string {
  const obj: Record<string, unknown> = {};
  for (const cap of capabilities) {
    const v = (fields[cap] ?? '').trim();
    if (v) { obj[cap] = v; }
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in obj)) { obj[k] = v; }
  }
  return Object.keys(obj).length === 0 ? '{}' : JSON.stringify(obj, null, 2);
}

/**
 * Parse the JSON view back into form fields plus extra keys. Blank text is an
 * empty object. Returns an error message fit for the user instead of throwing.
 */
export function parseInputsJson(
  text: string,
  capabilities: string[],
): { ok: true; value: SplitInputs } | { ok: false; error: string } {
  if (!text.trim()) { return { ok: true, value: { fields: {}, extra: {} } }; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Inputs must be a JSON object, e.g. {"legacy_source": {"kind": "none"}}' };
  }
  const clash = Object.keys(parsed).filter((k) => RESERVED_INPUT_KEYS.includes(k));
  if (clash.length > 0) {
    return { ok: false, error: `${clash.map((k) => `"${k}"`).join(', ')} is written by AIDLC itself — remove it` };
  }
  const fields: Record<string, string> = {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (capabilities.includes(k) && typeof v === 'string') { fields[k] = v; } else { extra[k] = v; }
  }
  return { ok: true, value: { fields, extra } };
}
