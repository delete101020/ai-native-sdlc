/**
 * Epic tags — free-text in, one canonical form on disk.
 *
 * A tag is a label someone types into a box ("thanh toán VNPay", "Payment ",
 * "payment"). Three people type three things and mean one thing, and a filter
 * that compares them literally finds one third of the epics. So the typing stays
 * free and the *storing* does not: every tag is folded to a single canonical
 * spelling before it reaches `state.json`, and the filter compares canonical
 * forms only.
 *
 * The canonical form is SCREAMING-KEBAB ASCII — what GitHub topics, Jira labels
 * and most issue trackers converge on, plus the uppercase the project asked for:
 *
 *   "thanh toán VNPay"  → THANH-TOAN-VNPAY
 *   "  payment  gateway"→ PAYMENT-GATEWAY
 *   "tech_debt"         → TECH_DEBT
 *   "Đợt 2"             → DOT-2
 *
 * Why fold the diacritics rather than keep them: the tag is a *key*, and a key
 * that can be typed two ways (with tone marks, without) is two keys. Folding
 * costs the display a little fidelity and buys the filter the property that
 * makes it worth having — type it however, hit the same bucket.
 */

/** Key under which tags live in an epic's `state.json`. */
export const EPIC_TAGS_KEY = 'tags';

/** Longest canonical tag. Past this it stops being a label and starts being a title. */
export const MAX_TAG_LENGTH = 48;

/**
 * Fold one free-text tag into its canonical form, or `''` when nothing
 * filterable survives (`"---"`, `"  "`, `"…"`).
 */
export function normalizeTag(raw: unknown): string {
  if (typeof raw !== 'string') { return ''; }
  return raw
    // Split accented letters into base + combining mark, then drop the marks:
    // "ố" → "o". `đ`/`Đ` carry their stroke *inside* the letter and survive
    // NFD, so they are mapped by hand.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toUpperCase()
    // Everything that is not a letter, digit or underscore becomes a separator.
    // A run of them collapses to one, so "payment / gateway" is not
    // "PAYMENT---GATEWAY".
    .replace(/[^A-Z0-9_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_TAG_LENGTH)
    // The slice can land on a separator; trim again so no tag ends in one.
    .replace(/[-_]+$/g, '');
}

/**
 * Fold a list (or a comma/space-separated string) of free-text tags into the
 * canonical set written to disk: normalized, empties dropped, deduplicated,
 * sorted. Sorted because the order tags were typed in carries no meaning, and
 * a stable order keeps `state.json` diffs to the tags that actually changed.
 */
export function normalizeTags(raw: unknown): string[] {
  const parts: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\n]/)
      : [];
  const out = new Set<string>();
  for (const part of parts) {
    const tag = normalizeTag(part);
    if (tag) { out.add(tag); }
  }
  return [...out].sort();
}

/**
 * Tags of a parsed `state.json`. Tolerant on purpose: an epic scaffolded before
 * tags existed has no key at all, and a hand-edited one may have anything.
 */
export function readEpicTags(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object') { return []; }
  return normalizeTags((parsed as Record<string, unknown>)[EPIC_TAGS_KEY]);
}

/**
 * Does an epic match a tag filter?
 *
 * The filter terms are normalized here too, so `--tag "thanh toán"` matches what
 * the box stored. Multiple terms are AND — each extra tag narrows the list,
 * which is what "filter by tag" means everywhere it already exists. An empty
 * filter matches everything.
 */
export function epicMatchesTags(epicTags: readonly string[], filter: unknown): boolean {
  const wanted = normalizeTags(filter);
  if (wanted.length === 0) { return true; }
  const have = new Set(normalizeTags(epicTags as unknown));
  return wanted.every((t) => have.has(t));
}

/**
 * Apply an add/remove/set edit to an existing tag list and return the canonical
 * result. `set` replaces outright; `add`/`remove` are applied in that order on
 * top of what is there.
 */
export function applyTagEdit(
  current: readonly string[],
  edit: { set?: unknown; add?: unknown; remove?: unknown },
): string[] {
  const base = edit.set !== undefined ? normalizeTags(edit.set) : normalizeTags(current as unknown);
  const next = new Set(base);
  for (const t of normalizeTags(edit.add)) { next.add(t); }
  for (const t of normalizeTags(edit.remove)) { next.delete(t); }
  return [...next].sort();
}
