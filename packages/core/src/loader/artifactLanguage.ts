/**
 * The natural language a workspace's artifacts are written in.
 *
 * Nothing used to say. A phase's prompt carried the persona, the project's
 * instructions and the skill, and left the output language to whatever the
 * model inferred from the epic brief — which meant a Vietnamese brief could
 * still produce an English PRD, and worse, could produce a Vietnamese intent
 * followed by an English spec. The pipeline's whole point is that phase N+1
 * reads phase N; having them drift languages mid-run is a correctness problem,
 * not a cosmetic one.
 *
 * `artifact_language:` in workspace.yaml settles it once for the workspace.
 * Unset means what it has always meant: no opinion, no section emitted, the
 * prompt byte-identical to before.
 *
 * ## Why the skeleton stays English
 *
 * The rule deliberately governs prose only. Headings are load-bearing:
 * `IncidentLoop` *generates* an intent document with the literal strings
 * `## 1. Problem` … `## 7. Open questions`, and the auto-review contract
 * (`AutoReviewer`) invites rules of the form `prd.includes('## Acceptance
 * Criteria')`. Translating headings would produce a document the pipeline that
 * asked for it can no longer read.
 */

/**
 * The section heading, which is also the marker for "this command body knows
 * about `artifact_language`". See {@link commandBodyPredatesArtifactLanguage}.
 */
export const ARTIFACT_LANGUAGE_HEADING = '## Output language';

/**
 * True when an on-disk command body was generated before this feature existed.
 *
 * Command bodies are written once and left alone — `writeWorkflowCommands` and
 * `writeTwoLayerCommands` both skip a file that is already there, so hand edits
 * survive an upgrade. That courtesy has a cost: a body written by an older
 * build never mentions `artifact_language`, so setting it in workspace.yaml
 * changes nothing for any agent launched through a slash command, and the user
 * gets a Vietnamese intent followed by an English spec with no clue why.
 *
 * A missing section is safe to treat as staleness rather than as a hand edit.
 * The section is emitted unconditionally by every generator, so a body without
 * it cannot have come from this build; and it carries no project-specific
 * content anyone would have deliberately deleted.
 */
export function commandBodyPredatesArtifactLanguage(existing: string): boolean {
  return !existing.includes(ARTIFACT_LANGUAGE_HEADING);
}

/**
 * The rule text, shared by every path that composes a phase prompt so the two
 * cannot drift apart.
 *
 * @param language A resolved language (name or tag — `Vietnamese`, `vi`) to
 *   state outright, or `null` to tell the reader to resolve it from
 *   workspace.yaml at runtime. The headless composer passes a value because it
 *   has the config loaded; the slash-command bodies pass `null` because they
 *   are written to disk once and must not go stale when the setting changes.
 */
export function artifactLanguageSection(language: string | null): string {
  const opening = language
    ? `Write this phase's artifact in **${language}** (\`artifact_language: ${language}\` in \`.aidlc/workspace.yaml\`).`
    : [
      'Read `artifact_language` from `.aidlc/workspace.yaml`. If it is set, write',
      'this phase\'s artifact in that language and follow the rest of this section.',
      'If it is absent, ignore this section and use your normal judgement.',
    ].join('\n');

  return [
    ARTIFACT_LANGUAGE_HEADING,
    '',
    opening,
    '',
    'This governs the prose you author: problem statements, rationale, acceptance',
    'criteria, open questions, table cells, commit-message bodies, and the summary',
    'you give the user at the end.',
    '',
    'It does **not** govern the document skeleton. Leave these exactly as the',
    'template has them, in English:',
    '',
    '- Markdown headings and their numbering (`## 1. Problem`). AIDLC generates and',
    '  matches these strings — a translated heading is a section the pipeline can no',
    '  longer find.',
    '- Field labels (`**Epic ID:**`, `**Status:**`) and table column names.',
    '- File names, paths, identifiers, code, API routes, and any value quoted from',
    '  the codebase.',
    '',
    'The test: diffing your artifact against its template should show a change in',
    'the prose and nowhere else.',
  ].join('\n');
}

/**
 * The workspace's declared artifact language, or `null` when it declares none.
 *
 * Accepts a loosely-typed doc so the extension and CLI can call it with a
 * freshly-parsed `workspace.yaml` that has not been through the schema.
 */
export function resolveArtifactLanguage(
  doc: { artifact_language?: unknown } | null | undefined,
): string | null {
  const raw = doc?.artifact_language;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}
