import type { EpicSummary } from './types';

/**
 * How the Epics list is ordered.
 *
 * The host hands the list over newest-created first, and for a long time that
 * was the only order. It answers "what did we open lately", which is rarely the
 * question — the list is read to find what needs a human, or to get back to
 * whatever was touched last, and on a shared `docs/epics/` to find one's own.
 */
export type EpicSort = 'attention' | 'activity' | 'created' | 'name' | 'mine';

export const EPIC_SORTS: { id: EpicSort; label: string; hint: string }[] = [
  { id: 'created', label: 'Created', hint: 'Oldest created first' },
  { id: 'attention', label: 'Needs attention', hint: 'Awaiting review / rejected, then failed, stale, running, pending, done' },
  { id: 'activity', label: 'Last activity', hint: 'Most recently started, finished or reviewed step first' },
  { id: 'mine', label: 'My epics', hint: 'Epics carrying your ID prefix first, by ID' },
  { id: 'name', label: 'Name', hint: 'Title A → Z' },
];

export const DEFAULT_EPIC_SORT: EpicSort = 'created';

export function isEpicSort(v: unknown): v is EpicSort {
  return EPIC_SORTS.some((s) => s.id === v);
}

function time(iso: string | null | undefined): number {
  if (!iso) { return 0; }
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * The latest thing that happened to an epic: any step starting, finishing, or
 * being reviewed, rerun or rejected. An epic nothing has happened to yet falls
 * back to when it was created, so it still has a place on the timeline.
 */
export function lastActivity(epic: EpicSummary): number {
  let latest = time(epic.createdAt);
  for (const s of epic.stepDetails ?? []) {
    latest = Math.max(latest, time(s.startedAt), time(s.finishedAt));
    for (const h of s.history ?? []) { latest = Math.max(latest, time(h.at)); }
  }
  return latest;
}

/**
 * Lower is more urgent.
 *
 * A step parked on a human gate comes first: nothing moves until someone looks
 * at it, and it is the only rank a person can clear on their own. A failure
 * next, then work built on an upstream step that has since been rerun — done,
 * but possibly wrong. Running work sits after those because it needs no one.
 */
export function attentionRank(epic: EpicSummary): number {
  const steps = epic.stepDetails ?? [];
  if (steps.some((s) => s.runStatus === 'awaiting_review' || s.runStatus === 'rejected')) { return 0; }
  if (epic.status === 'failed') { return 1; }
  if (steps.some((s) => s.dirty || (s.dirtyUpstream?.length ?? 0) > 0)) { return 2; }
  if (epic.status === 'in_progress') { return 3; }
  if (epic.status === 'pending') { return 4; }
  return 5;
}

/**
 * Whether this checkout opened the epic, read off its id.
 *
 * Ids are `EPIC-<yymmdd>-<XX>-<nnn>` (see core `loader/epicId`), and the
 * hand-written `EPIC-XX-<nnn>` the prefix grew out of still counts. Not
 * anchored at the end: a follow-up's id extends its parent's, and it belongs to
 * whoever opened the parent.
 */
export function isOwnEpic(id: string, prefix: string | null | undefined): boolean {
  if (!prefix) { return false; }
  const p = prefix.replace(/[^A-Za-z]/g, '');
  if (!p) { return false; }
  return new RegExp(`^EPIC-(?:\\d{6}-)?${p}-\\d+`, 'i').test(id);
}

const natural = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Sort a copy of `epics`.
 *
 * `reversed` flips the order the chosen key reads in — except for "My epics",
 * where it flips the order within each group but never puts other people's
 * epics on top, since that is the one thing the option is for.
 *
 * Every key breaks ties the way the host's list already does — newest created,
 * then id. "Created" itself reads the other way, oldest first.
 */
export function sortEpics(
  epics: readonly EpicSummary[],
  sort: EpicSort,
  reversed: boolean,
  prefix: string | null | undefined,
): EpicSummary[] {
  const dir = reversed ? -1 : 1;
  const fallback = (a: EpicSummary, b: EpicSummary) =>
    time(b.createdAt) - time(a.createdAt) || natural(b.id, a.id);

  const cmp = (a: EpicSummary, b: EpicSummary): number => {
    switch (sort) {
      case 'attention':
        return dir * (attentionRank(a) - attentionRank(b) || lastActivity(b) - lastActivity(a)) || fallback(a, b);
      case 'activity':
        return dir * (lastActivity(b) - lastActivity(a)) || fallback(a, b);
      case 'name':
        return dir * natural(a.title || a.id, b.title || b.id) || fallback(a, b);
      case 'mine': {
        const mine = Number(isOwnEpic(b.id, prefix)) - Number(isOwnEpic(a.id, prefix));
        if (mine !== 0) { return mine; }
        // The id carries the date and the day's counter, so newest-id first is
        // a timeline of one's own work.
        return isOwnEpic(a.id, prefix)
          ? dir * natural(b.id, a.id)
          : dir * fallback(a, b);
      }
      case 'created':
      default:
        // Oldest first, so the list reads as a timeline top to bottom. The
        // panel's UI state does not survive a close, so this is what it opens on.
        return -dir * fallback(a, b);
    }
  };

  return [...epics].sort(cmp);
}
