/**
 * A webview-side mirror of core's `followUpEpicId`, for the placeholder in the
 * Report-signal form.
 *
 * The host derives the real id — only it can see which epics already exist, and
 * only it can resolve a collision. This exists so the field can show what the
 * id is *going* to be while the user is still typing the symptom, which is the
 * moment the id is worth seeing: the symptom is what it is made of.
 *
 * Kept deliberately dumb and free of imports so it stays a copy of one function
 * rather than a reason to bundle core into the webview. `test/incidentId.test.ts`
 * asserts it against the real thing so the two cannot drift silently.
 */

/** The prefix core defaults to when a caller passes none. */
export const DEFAULT_INCIDENT_PREFIX = 'INC';

export function previewIncidentEpicId(symptom: string, prefix = DEFAULT_INCIDENT_PREFIX): string {
  const p = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '') || DEFAULT_INCIDENT_PREFIX;
  const slug = symptom
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return slug ? `${p}-${slug}` : p;
}
