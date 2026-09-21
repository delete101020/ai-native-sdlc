/**
 * Epic tag normalization for the webview — a mirror of `@aidlc/core`'s
 * `loader/epicTags.ts`, copied for the same reason the rest of `lib/types.ts`
 * is: core targets Node and is bundled into the extension host, not into this
 * browser bundle.
 *
 * This copy exists to *show* the user what their typing becomes, live, while
 * they type it. It is never the authority: the host normalizes again before
 * anything reaches `state.json`, so a drift between the two shows up as a chip
 * that looks slightly different after the write, never as an unfilterable tag.
 */

export const MAX_TAG_LENGTH = 48;

/** Fold one free-text tag to canonical form, or `''` if nothing survives. */
export function normalizeTag(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_TAG_LENGTH)
    .replace(/[-_]+$/g, '');
}

/** Canonical tag set: normalized, empties dropped, deduplicated, sorted. */
export function normalizeTags(raw: readonly string[] | string | undefined | null): string[] {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\n]/)
      : [];
  const out = new Set<string>();
  for (const part of parts) {
    const tag = normalizeTag(String(part));
    if (tag) { out.add(tag); }
  }
  return [...out].sort();
}
