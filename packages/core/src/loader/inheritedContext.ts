/**
 * What a follow-up epic inherits from the epics it follows.
 *
 * `from_epic` (and `also_from`, for a follow-up of more than one epic) used to
 * be a link the epic list drew and nothing else: the agent writing the child's
 * spec never saw the parent's, so "change how seals are classified" was
 * specified from the one-paragraph intent alone. The parents' artifacts are
 * named by path rather than copied in, so a parent revised later is read as it
 * is now.
 */

/** Present in every command body that carries the note. See {@link commandBodyPredatesInheritedContext}. */
export const INHERITED_CONTEXT_MARKER = '`also_from`';

/** One sentence, appended to the "read inputs.json" step of every phase prompt. */
export function inheritedContextNote(epicRoot: string): string {
  return `If it has \`from_epic\` (and ${INHERITED_CONTEXT_MARKER}, comma-separated), this epic follows those epics and inherits their business rules: before writing, read each one's \`${epicRoot}/<parent>/artifacts/intent.md\` and \`spec.md\` (whichever exist), keep what this epic does not change, and say what it changes.`;
}

/** True when an on-disk command body was generated before this note existed. */
export function commandBodyPredatesInheritedContext(existing: string): boolean {
  return !existing.includes(INHERITED_CONTEXT_MARKER);
}
