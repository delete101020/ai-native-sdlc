/**
 * The epics one person is working on right now — the active one and the ones
 * opened most recently — plus the set they keep an eye on.
 *
 * With dozens of epics on disk, the list is no longer the way to get back to
 * the few you are actually on. This is that short list. It is personal
 * (what I am on says nothing about what you are on), so it lives in
 * `.aidlc/user.yaml` next to `epic_id_prefix` — per checkout, gitignored, and
 * readable by the CLI and by a skill running in a Claude terminal, which is
 * why it is a file and not VS Code's workspaceState.
 *
 *   active_epic: EPIC-012
 *   recent_epics: [EPIC-012, EPIC-031, EPIC-007]
 *   watched_epics: [EPIC-003, EPIC-015]
 *   epic_sort: { by: activity, reversed: true }
 *
 * Watched is the list the sidebar shows as My epics: what I am working on,
 * an epic waiting on my review, a colleague's that mine depends on.
 *
 * `pinned_epics`, from an earlier version, is no longer read; a file that still
 * has it keeps it, untouched.
 *
 * The Epics list order sits here too, for the same reason: how I like the
 * list sorted is mine, and the sidebar's My epics follows it.
 *
 * Ids are stored as given; an epic deleted since is simply skipped by whoever
 * displays the list, so nothing here ever has to be cleaned up.
 */
import { readUserConfig, updateUserConfig } from './userConfig';

export const ACTIVE_EPIC_KEY = 'active_epic';
export const RECENT_EPICS_KEY = 'recent_epics';
export const WATCHED_EPICS_KEY = 'watched_epics';
export const EPIC_SORT_KEY = 'epic_sort';

/** How many recently opened epics are remembered. */
export const RECENT_EPICS_LIMIT = 10;

export interface EpicFocus {
  active: string | null;
  recent: string[];
  watched: string[];
}

function asId(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function asIdList(v: unknown): string[] {
  if (!Array.isArray(v)) { return []; }
  const out: string[] = [];
  for (const item of v) {
    const id = asId(item);
    if (id && !out.includes(id)) { out.push(id); }
  }
  return out;
}

/** Parse the working set out of a user config document (or `null`). */
export function epicFocusFrom(doc: Record<string, unknown> | null): EpicFocus {
  return {
    active: asId(doc?.[ACTIVE_EPIC_KEY]),
    recent: asIdList(doc?.[RECENT_EPICS_KEY]),
    watched: asIdList(doc?.[WATCHED_EPICS_KEY]),
  };
}

export function readEpicFocus(root: string): EpicFocus {
  return epicFocusFrom(readUserConfig(root));
}

/** `id` moved to the front of `list`, trimmed to `limit`. */
export function pushRecent(list: string[], id: string, limit = RECENT_EPICS_LIMIT): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, limit);
}

function writeList(doc: Record<string, unknown>, key: string, list: string[]): void {
  if (list.length > 0) { doc[key] = list; }
  else { delete doc[key]; }
}

/** Remember that `id` was opened. */
export function recordEpicOpened(root: string, id: string): void {
  updateUserConfig(root, (doc) => {
    writeList(doc, RECENT_EPICS_KEY, pushRecent(asIdList(doc[RECENT_EPICS_KEY]), id));
  });
}

/**
 * Make `id` the epic being worked on (it also counts as opened), or clear it
 * with `null`.
 */
export function setActiveEpic(root: string, id: string | null): void {
  updateUserConfig(root, (doc) => {
    if (id) {
      doc[ACTIVE_EPIC_KEY] = id;
      writeList(doc, RECENT_EPICS_KEY, pushRecent(asIdList(doc[RECENT_EPICS_KEY]), id));
    } else {
      delete doc[ACTIVE_EPIC_KEY];
    }
  });
}

/**
 * Watch or unwatch `id`. Watching one already watched keeps its place; the
 * sidebar shows the list in the Epics view's order, not this one.
 */
export function setEpicWatched(root: string, id: string, watched: boolean): void {
  updateUserConfig(root, (doc) => {
    const list = asIdList(doc[WATCHED_EPICS_KEY]);
    if (watched === list.includes(id)) { return; }
    writeList(doc, WATCHED_EPICS_KEY, watched ? [...list, id] : list.filter((x) => x !== id));
  });
}

/**
 * How this user sorts the Epics list. `by` is the sort's id as the extension
 * names it (`created`, `attention`, `activity`, `mine`, `name`); it is kept as
 * given and checked by whoever applies it, so a newer id survives an older
 * reader.
 */
export interface EpicSortPref {
  by: string;
  reversed: boolean;
}

/** The saved Epics order, or `null` when none was picked. */
export function epicSortFrom(doc: Record<string, unknown> | null): EpicSortPref | null {
  const v = doc?.[EPIC_SORT_KEY];
  if (!v || typeof v !== 'object' || Array.isArray(v)) { return null; }
  const by = asId((v as Record<string, unknown>).by);
  return by ? { by, reversed: (v as Record<string, unknown>).reversed === true } : null;
}

export function readEpicSort(root: string): EpicSortPref | null {
  return epicSortFrom(readUserConfig(root));
}

/** Save the Epics order. `reversed` is written only when set. */
export function setEpicSort(root: string, pref: EpicSortPref): void {
  updateUserConfig(root, (doc) => {
    doc[EPIC_SORT_KEY] = pref.reversed ? { by: pref.by, reversed: true } : { by: pref.by };
  });
}

/** Whether this user reads the Epics list flat rather than grouped by family. */
export const EPIC_LIST_FLAT_KEY = 'epic_list_flat';

export function readEpicListFlat(root: string): boolean {
  return readUserConfig(root)?.[EPIC_LIST_FLAT_KEY] === true;
}

/** Written only when set; grouped is the default. */
export function setEpicListFlat(root: string, flat: boolean): void {
  updateUserConfig(root, (doc) => {
    if (flat) { doc[EPIC_LIST_FLAT_KEY] = true; }
    else { delete doc[EPIC_LIST_FLAT_KEY]; }
  });
}

/**
 * Which of `knownIds` a git branch name refers to, or `null`.
 *
 * `feature/EPIC-012-login` → `EPIC-012`. The id has to stand as its own token
 * (not followed by another digit), so `EPIC-1` never claims `EPIC-12`; when
 * several ids fit, the longest wins — `EPIC-260901-NG-003` over `EPIC-003`
 * would otherwise be a coin toss. Case is ignored, because branch names are
 * often lower-cased by habit or by tooling.
 */
export function epicIdFromBranch(branch: string | null | undefined, knownIds: Iterable<string>): string | null {
  if (!branch) { return null; }
  const hay = branch.toLowerCase();
  let best: string | null = null;
  for (const id of knownIds) {
    const needle = id.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) { break; }
      const before = at === 0 ? '' : hay[at - 1];
      const after = hay[at + needle.length] ?? '';
      if (!/[a-z0-9]/.test(before) && !/[0-9]/.test(after)) {
        if (!best || id.length > best.length) { best = id; }
        break;
      }
      from = at + 1;
    }
  }
  return best;
}
