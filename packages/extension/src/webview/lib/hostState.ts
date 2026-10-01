/**
 * How a `{ type: 'state' }` message becomes the state a webview renders.
 *
 * Two things keep a re-post cheap on this side. A host may send only the list
 * items that changed (`lists`), naming the rest by id; and whatever arrives,
 * every part equal to what was already held keeps its old object. That second
 * part is what lets a memoised component — an epic card — skip a post that
 * did not touch it: without it every post is a brand-new tree and every card
 * renders again.
 */

/** A list sent as its order plus the items that differ from the last post. */
export interface ListDelta {
  ids: string[];
  changed: Array<{ id: string }>;
}

/**
 * Fill each delta'd list of `next` from `prev`. Null when an id the host
 * counts on is not held here — the caller asks for the whole state again.
 */
export function applyListDeltas<T>(
  prev: T | null,
  next: T,
  lists: Record<string, ListDelta> | undefined,
): T | null {
  if (!lists) { return next; }
  const out = { ...next } as Record<string, unknown>;
  for (const [key, delta] of Object.entries(lists)) {
    const held = prev ? (prev as Record<string, unknown>)[key] : undefined;
    const byId = new Map<string, unknown>();
    if (Array.isArray(held)) {
      for (const item of held) {
        const id = (item as { id?: unknown })?.id;
        if (typeof id === 'string') { byId.set(id, item); }
      }
    }
    for (const item of delta.changed) { byId.set(item.id, item); }
    const items: unknown[] = [];
    for (const id of delta.ids) {
      if (!byId.has(id)) { return null; }
      items.push(byId.get(id));
    }
    out[key] = items;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

/** The `id` of every item, or null unless all are distinct strings. */
function idsOf(list: unknown[]): string[] | null {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const id = isPlainObject(item) ? item.id : undefined;
    if (typeof id !== 'string' || seen.has(id)) { return null; }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * `next`, with every subtree deep-equal to the same place in `prev` replaced
 * by `prev`'s object — so `prev === result` when nothing changed at all.
 * Lists of items with distinct ids are matched by id, so a re-sorted list
 * keeps each item's identity.
 */
export function shareStructure<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) { return prev as T; }
  if (Array.isArray(prev) && Array.isArray(next)) {
    const prevIds = idsOf(prev);
    const nextIds = prevIds ? idsOf(next) : null;
    const prevById = prevIds && nextIds ? new Map(prevIds.map((id, i) => [id, prev[i]])) : null;
    let same = prev.length === next.length;
    const out = next.map((item, i) => {
      const before = prevById ? prevById.get(nextIds![i]) : prev[i];
      const shared = shareStructure(before, item);
      if (shared !== prev[i]) { same = false; }
      return shared;
    });
    return (same ? prev : out) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(prev).length;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const shared = shareStructure(prev[key], next[key]);
      if (!(key in prev) || shared !== prev[key]) { same = false; }
      out[key] = shared;
    }
    return (same ? prev : out) as T;
  }
  return next;
}
