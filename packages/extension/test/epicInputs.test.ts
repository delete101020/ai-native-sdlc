/**
 * The Start Epic inputs have two views — a field per capability and the whole
 * inputs.json as JSON. Switching between them must not lose what was typed in
 * either: filled fields show up in the JSON, and keys the form has no field for
 * survive the trip back to the form.
 */
import { describe, expect, it } from 'vitest';
import { inputsToJson, parseInputsJson, RESERVED_INPUT_KEYS } from '../src/webview/lib/epicInputs';
import { RESERVED_INPUT_KEYS as CORE_RESERVED } from '@aidlc/core';

const CAPS = ['files', 'core-business', 'jira'];
const LEGACY = { kind: 'none', note: 'CR tài liệu thuần.' };

describe('Start Epic inputs — form ↔ JSON', () => {
  it('seeds the JSON with the filled fields, in field order, then the extra keys', () => {
    const text = inputsToJson({ jira: 'CR-1', files: ' src/** ', 'core-business': '  ' }, { legacy_source: LEGACY }, CAPS);
    expect(JSON.parse(text)).toEqual({ files: 'src/**', jira: 'CR-1', legacy_source: LEGACY });
    expect(Object.keys(JSON.parse(text))).toEqual(['files', 'jira', 'legacy_source']);
  });

  it('shows an empty object when nothing is filled', () => {
    expect(inputsToJson({}, {}, CAPS)).toBe('{}');
  });

  it('hands string capability values back to their fields and keeps the rest', () => {
    const r = parseInputsJson(JSON.stringify({ jira: 'CR-2', legacy_source: LEGACY, files: ['a', 'b'], note: 'x' }), CAPS);
    expect(r).toEqual({ ok: true, value: { fields: { jira: 'CR-2' }, extra: { legacy_source: LEGACY, files: ['a', 'b'], note: 'x' } } });
  });

  it('round-trips form → JSON → form unchanged', () => {
    const fields = { jira: 'CR-3' };
    const extra = { legacy_source: LEGACY };
    expect(parseInputsJson(inputsToJson(fields, extra, CAPS), CAPS)).toEqual({ ok: true, value: { fields, extra } });
  });

  it('treats blank text as no inputs', () => {
    expect(parseInputsJson('  ', CAPS)).toEqual({ ok: true, value: { fields: {}, extra: {} } });
  });

  it.each([
    ['{"jira":', /Not valid JSON/],
    ['[]', /must be a JSON object/],
    ['null', /must be a JSON object/],
    ['{"from_epic":"CR-0"}', /"from_epic"/],
  ])('rejects %s', (text, msg) => {
    const r = parseInputsJson(text, CAPS);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toMatch(msg); }
  });

  it('reserves the same keys as core', () => {
    expect([...RESERVED_INPUT_KEYS]).toEqual([...CORE_RESERVED]);
  });
});
