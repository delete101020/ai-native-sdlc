/**
 * `strict_mode` — how deep a phase goes for one epic.
 *
 * The pipeline's artifacts are written by agents reading a template, and the
 * templates are built for the largest thing an epic can be: a spec with
 * non-functional requirements, risks, alternatives considered, a migration and
 * rollback plan. That is right for an epic that earns it. It is wrong for the
 * kind of epic most teams actually run — one migration task, one endpoint, one
 * bug — where the same template produces pages of invented content nobody asked
 * for, every phase after it has more to read, and a two-hour piece of work
 * takes a day to get through the pipeline.
 *
 * Depth is a property of the work item, not of the team, so this setting lives
 * per epic (`strict_mode` in `<epic>/state.json`) rather than in the shared
 * `workspace.yaml`. It is the second half of a pair: the recipe decides *which
 * steps* an epic runs (`native-lite` drops steps), `strict_mode` decides *how
 * far each step goes*.
 *
 * Absent means `true` — every epic written before this existed keeps the
 * behaviour it had, and the prompt it composes stays byte-identical.
 *
 * ## Why the skeleton stays
 *
 * Non-strict shrinks the *content*, never the document's structure. Headings
 * are load-bearing here for the same reason they are under `artifact_language`:
 * `AutoReviewer` rules assert on strings like `prd.includes('## Acceptance
 * Criteria')`, and a profile's `mandatory_sections` are checked by the
 * traceability validator. An agent that drops a section to be brief fails the
 * gate it was about to reach. So the rule is "one honest line under a heading
 * that does not apply", not "delete the heading".
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * The section heading, which doubles as the marker for "this command body
 * knows about `strict_mode`". See {@link commandBodyPredatesStrictMode}.
 */
export const STRICT_MODE_HEADING = '## Depth of work';

/** The key as it appears in an epic's `state.json`. */
export const STRICT_MODE_KEY = 'strict_mode';

/**
 * True when an on-disk command body was generated before this feature existed.
 *
 * Same reasoning as `commandBodyPredatesArtifactLanguage`: bodies are written
 * once and never overwritten, so without this a workspace provisioned by an
 * older build would set `strict_mode: false` on an epic and see no change at
 * all in what its agents do. The section is emitted unconditionally by every
 * generator, so a body missing it cannot have come from this build.
 */
export function commandBodyPredatesStrictMode(existing: string): boolean {
  return !existing.includes(STRICT_MODE_HEADING);
}

/**
 * Whether an epic runs strict. Accepts a parsed `state.json` (or anything
 * shaped like one); anything that is not literally `false` reads as strict, so
 * a hand-edited `"strict_mode": "no"` fails closed rather than silently
 * shortening every artifact.
 */
export function epicStrictMode(state: { strict_mode?: unknown } | null | undefined): boolean {
  return state?.strict_mode !== false;
}

/**
 * Read `strict_mode` off an epic's `state.json` on disk.
 *
 * Never throws: a missing or unparseable file is an epic we know nothing
 * about, and the safe thing to assume about an unknown epic is that it is
 * strict — the behaviour it had before this setting existed.
 */
export function resolveEpicStrictMode(epicsRootDir: string, epicId: string): boolean {
  if (!epicId) { return true; }
  try {
    const file = path.join(epicsRootDir, epicId, 'state.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') { return true; }
    return epicStrictMode(parsed as { strict_mode?: unknown });
  } catch {
    return true;
  }
}

/**
 * The rule text, shared by every path that composes a phase prompt so the two
 * cannot drift apart.
 *
 * @param strict `false` to state the relaxed rule outright; `null` to tell the
 *   reader to resolve it from the epic's `state.json` at runtime. Returns
 *   `null` for `true`, because strict *is* the composed prompt as it has
 *   always been and there is nothing to add. The headless composer passes a
 *   resolved boolean because it has the epic loaded; the slash-command bodies
 *   pass `null` because they are written to disk once and must not go stale
 *   when a later epic is created with a different setting.
 */
export function strictModeSection(strict: boolean | null): string | null {
  if (strict === true) { return null; }

  const opening = strict === false
    ? [
      'This epic runs with `strict_mode: false` (in its `state.json`). Match the',
      'artifact to the size of the work: cover what this change actually needs,',
      'and stop there.',
    ].join('\n')
    : [
      'Read `strict_mode` from this epic\'s `state.json`. If it is absent or',
      '`true`, ignore this section and work at your normal depth. If it is',
      '`false`, match the artifact to the size of the work: cover what this',
      'change actually needs, and stop there.',
    ].join('\n');

  return [
    STRICT_MODE_HEADING,
    '',
    opening,
    '',
    'Under a relaxed depth:',
    '',
    '- Keep every heading the template has, in the same order. The auto-reviewer',
    '  and the traceability validator match on those exact strings — a section',
    '  you delete for brevity is a gate you fail.',
    '- A section with nothing real to say gets **one line**: what does not apply',
    '  and why (`No new persistence — reuses the existing table.`). Do not invent',
    '  content to fill a heading.',
    '- Raise a non-functional concern — performance, security, scalability,',
    '  migration, rollback, observability — only when this change actually moves',
    '  it, or when the brief or the code you read raises it. Say it in one or two',
    '  sentences under the heading it belongs to; it does not need a sub-analysis.',
    '- Skip alternatives-considered and risk registers unless a decision here is',
    '  genuinely contested. One sentence on why the obvious approach was taken is',
    '  enough when it is not.',
    '- Prefer the specific to the exhaustive: the file, the endpoint, the table,',
    '  the acceptance criterion someone can test. Three concrete criteria beat',
    '  twelve generic ones.',
    '',
    'This is a budget on breadth, never on correctness. Do not skip reading the',
    'code you are about to change, do not guess at an interface you could look',
    'up, and do not leave out something the next phase needs — a shorter artifact',
    'that sends the phase after it back to ask is not shorter.',
  ].join('\n');
}
