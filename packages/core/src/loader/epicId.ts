/**
 * How a new epic's id is proposed.
 *
 * The id used to be `EPIC-` plus a running number, and both front doors
 * derived the number the same way: list the directories under the epic root,
 * keep the ones matching `/^EPIC-(\d+)$/`, take the max and add one. That is
 * fine for one person. It breaks in two ways once a repo has several.
 *
 * The first is collision. Two developers on the same repo are both offered
 * `EPIC-003`, and the second one to scaffold walks into "Epic dir already
 * exists". The second is that the scan is blind to anything it did not
 * generate: a folder named `EPIC-KF-003` does not match, so it does not
 * count, so the suggester keeps proposing a number that is already taken.
 * Hand-written prefixes were possible before this module — nothing validates
 * epic ids — but they were never *kept*, which is the part that matters.
 *
 * `epic_id_prefix:` in workspace.yaml gives each checkout two letters of its
 * own, and the id becomes `EPIC-<yymmdd>-<XX>-<nnn>`:
 *
 *     EPIC-260908-NG-001
 *
 * ## Why the date comes first
 *
 * `docs/epics/` is shared. Sorting it by name with the person first groups the
 * listing by author and scatters time within each group; with the date first
 * the same listing is a team-wide timeline, which is the question people
 * actually ask of a folder full of epics. The date is *local* — see
 * {@link epicIdDateStamp} — and it is the date the epic was opened, frozen
 * from then on. An epic that runs into the next month still reads as the month
 * it started, which is what "when did this begin" means.
 *
 * The epic's `createdAt` in `state.json` is unaffected and stays ISO-UTC: that
 * one is a timestamp for machines, this one is a label for people.
 *
 * Unset means what it has always meant. With no prefix the suggestion is the
 * old `EPIC-<nnn>`, byte for byte.
 */

/** The workspace.yaml key. */
export const EPIC_ID_PREFIX_KEY = 'epic_id_prefix';

/**
 * Exactly two letters — no more, no less.
 *
 * Two is enough to separate the people on one repo and short enough that the
 * id stays typeable: it is not only a directory name, it is the argument of
 * every slash command the epic runs and the branch `artifact_commit` writes
 * to. A free-length prefix would quietly turn `/ai-native-full-intent` into a
 * line nobody wants to type twice.
 */
export const EPIC_ID_PREFIX_PATTERN = /^[A-Z]{2}$/;

/**
 * The workspace's declared prefix, or `null` when it declares none.
 *
 * Lower case is accepted and upper-cased rather than rejected: the value is
 * typed by hand into YAML, and `ng` is a spelling of the same intent. Anything
 * that is not two letters degrades to `null` — no prefix, old behaviour —
 * because a bad key in workspace.yaml must not be able to stop someone from
 * starting an epic.
 *
 * Takes a loosely-typed doc so the extension and CLI can pass a freshly-parsed
 * `workspace.yaml` that has not been through the schema.
 */
export function resolveEpicIdPrefix(
  doc: { epic_id_prefix?: unknown } | null | undefined,
): string | null {
  const raw = doc?.epic_id_prefix;
  if (typeof raw !== 'string') { return null; }
  const upper = raw.trim().toUpperCase();
  return EPIC_ID_PREFIX_PATTERN.test(upper) ? upper : null;
}

/**
 * `yymmdd` for a date, read in the machine's own timezone.
 *
 * Deliberately not `toISOString().slice(2, 10)`. `toISOString` is UTC, so in
 * UTC+7 every epic opened before 07:00 would be stamped with the previous
 * day — the id would disagree with the calendar on the wall for a quarter of
 * every working morning, on precisely the mornings someone starts early.
 */
export function epicIdDateStamp(now: Date = new Date()): string {
  const yy = String(now.getFullYear() % 100).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/** Escape a string for literal use inside a `RegExp`. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The id to offer for the next epic.
 *
 * @param existing Directory names already under the epic root.
 * @param prefix The workspace's prefix, or `null` for the unprefixed scheme.
 * @param now Injectable for tests; defaults to right now, locally.
 *
 * With a prefix the counter is scoped to *this prefix on this day*, so it
 * restarts at `001` each morning. That is the point: the date already
 * separates the epics, and a number that only ever grows would say the same
 * thing twice while getting longer forever.
 */
export function suggestEpicId(
  existing: readonly string[],
  prefix: string | null,
  now: Date = new Date(),
): string {
  const stamp = epicIdDateStamp(now);
  const pattern = prefix
    ? new RegExp(`^EPIC-${escapeRe(stamp)}-${escapeRe(prefix)}-(\\d+)$`, 'i')
    : /^EPIC-(\d+)$/i;

  const numbered = existing
    .map((name) => name.match(pattern))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => parseInt(m[1], 10))
    .filter((n) => Number.isFinite(n));

  const next = numbered.length > 0 ? Math.max(...numbered) + 1 : 1;
  const seq = String(next).padStart(3, '0');
  return prefix ? `EPIC-${stamp}-${prefix}-${seq}` : `EPIC-${seq}`;
}
