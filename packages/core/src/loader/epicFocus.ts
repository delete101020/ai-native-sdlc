/**
 * The epics one person is working on right now — the active one, the pinned
 * ones, and the ones opened most recently.
 *
 * With dozens of epics on disk, the list is no longer the way to get back to
 * the three you are actually on. This is that short list. It is personal
 * (what I am on says nothing about what you are on), so it lives in
 * `.aidlc/user.yaml` next to `epic_id_prefix` — per checkout, gitignored, and
 * readable by the CLI and by a skill running in a Claude terminal, which is
 * why it is a file and not VS Code's workspaceState.
 *
 *   active_epic: EPIC-012
 *   pinned_epics: [EPIC-012, EPIC-007]
 *   recent_epics: [EPIC-012, EPIC-031, EPIC-007]
 *
 * Ids are stored as given; an epic deleted since is simply skipped by whoever
 * displays the list, so nothing here ever has to be cleaned up.
 */
import { readUserConfig, updateUserConfig } from './userConfig';

export const ACTIVE_EPIC_KEY = 'active_epic';
export const PINNED_EPICS_KEY = 'pinned_epics';
export const RECENT_EPICS_KEY = 'recent_epics';

/** How many recently opened epics are remembered. */
export const RECENT_EPICS_LIMIT = 10;

export interface EpicFocus {
  active: string | null;
  pinned: string[];
  recent: string[];
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
    pinned: asIdList(doc?.[PINNED_EPICS_KEY]),
    recent: asIdList(doc?.[RECENT_EPICS_KEY]),
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

/** Pin or unpin `id`. New pins go to the end, so the order is the user's. */
export function setEpicPinned(root: string, id: string, pinned: boolean): void {
  updateUserConfig(root, (doc) => {
    const list = asIdList(doc[PINNED_EPICS_KEY]).filter((x) => x !== id);
    if (pinned) { list.push(id); }
    writeList(doc, PINNED_EPICS_KEY, list);
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
