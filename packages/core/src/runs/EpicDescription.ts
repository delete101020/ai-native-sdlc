/**
 * Editing an epic's one-line description after it was created.
 *
 * The description is captured once, in the Start Epic wizard, and then lands in
 * two places that disagree the moment either is touched by hand:
 *
 *   <epic>/state.json   `description` — machine state, what the panels render
 *   <epic>/<epicId>.md  the lead paragraph — prose, what the first phase's
 *                       skill actually reads for context
 *
 * So "change the description" is not a one-line JSON write: an edit that only
 * moves state.json leaves every agent reading the sentence the user just
 * replaced. {@link setEpicDescription} moves both, and is the only supported
 * way to do it — the webview, the palette command and the CLI all go through
 * here so none of them can drift.
 */

import * as fs from 'fs';
import * as path from 'path';

export class EpicDescriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpicDescriptionError';
  }
}

/**
 * What happened to `<epicId>.md`, which — unlike state.json — is a file agents
 * and people also write to.
 *
 * `kept` is the interesting one: the lead paragraph no longer matches the
 * description we were replacing, so somebody has rewritten the brief by hand.
 * Overwriting it would silently delete their work, so the doc is left alone and
 * the caller is told, and can offer to open it.
 */
export type EpicDocOutcome = 'updated' | 'created' | 'unchanged' | 'kept';

export interface EpicDescriptionEdit {
  epicId: string;
  /** Description as written (trimmed). */
  description: string;
  /** What state.json held before. */
  previous: string;
  doc: EpicDocOutcome;
  /** Absolute path of `<epicId>.md`, whatever the outcome. */
  docFile: string;
}

function readState(stateFile: string, epicId: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile, 'utf8');
  } catch (err) {
    throw new EpicDescriptionError(
      `Cannot read ${path.basename(stateFile)} for ${epicId}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EpicDescriptionError(
      `${stateFile} is not valid JSON — fix it by hand before editing the description. ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EpicDescriptionError(`${stateFile} does not hold an epic state object.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Split `<epicId>.md` into (h1 line, lead paragraph, rest).
 *
 * The lead is everything between the `# ` heading and the first `##` section —
 * that is exactly the slot `scaffoldEpic` writes the description into. A doc
 * with no h1 has no lead slot we can be sure about, so it reports one of
 * length zero and the caller keeps its hands off.
 */
function splitDoc(text: string): { head: string; lead: string; rest: string } | null {
  const lines = text.split(/\r?\n/);
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 === -1) { return null; }
  let end = lines.length;
  for (let i = h1 + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  }
  return {
    head: lines.slice(0, h1 + 1).join('\n'),
    lead: lines.slice(h1 + 1, end).join('\n'),
    rest: lines.slice(end).join('\n'),
  };
}

/**
 * Rewrite an epic's description in `state.json` and in its markdown brief.
 *
 * `epicDir` is the epic's own folder (`<state.root>/<epicId>`). Returns what
 * was done, so a UI can say "state updated, brief left alone" rather than
 * claiming more than happened.
 */
export function setEpicDescription(
  epicDir: string,
  epicId: string,
  description: string,
): EpicDescriptionEdit {
  const next = description.trim();
  const stateFile = path.join(epicDir, 'state.json');
  const docFile = path.join(epicDir, `${epicId}.md`);

  // Read-modify-write: state.json also carries the mirrored run (stepStates,
  // history), and none of that is ours to rewrite.
  const state = readState(stateFile, epicId);
  const previous = typeof state.description === 'string' ? state.description : '';
  state.description = next;
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (err) {
    throw new EpicDescriptionError(
      `Cannot write ${stateFile}: ${(err as Error).message}`,
    );
  }

  const title = typeof state.title === 'string' ? state.title.trim() : '';
  const doc = writeDoc(docFile, epicId, title, previous, next);
  return { epicId, description: next, previous, doc, docFile };
}

function writeDoc(
  docFile: string,
  epicId: string,
  title: string,
  previous: string,
  next: string,
): EpicDocOutcome {
  let text: string | null = null;
  try {
    text = fs.readFileSync(docFile, 'utf8');
  } catch {
    text = null;
  }

  // No brief at all — an epic scaffolded before the doc existed, or one whose
  // file was deleted. Write the same thing `scaffoldEpic` would have.
  if (text === null) {
    const body = `# ${epicId}${title ? ` — ${title}` : ''}\n` + (next ? `\n${next}\n` : '');
    try {
      fs.mkdirSync(path.dirname(docFile), { recursive: true });
      fs.writeFileSync(docFile, body, 'utf8');
    } catch (err) {
      throw new EpicDescriptionError(`Cannot write ${docFile}: ${(err as Error).message}`);
    }
    return 'created';
  }

  const parts = splitDoc(text);
  if (!parts) { return 'kept'; }
  const leadText = parts.lead.trim();
  // The lead is ours to replace only while it still says what state.json said.
  // Anything else is a brief someone wrote, and it outranks a one-line edit.
  if (leadText !== previous.trim()) { return 'kept'; }
  if (leadText === next) { return 'unchanged'; }

  const rebuilt =
    parts.head + '\n' + (next ? `\n${next}\n` : '') + (parts.rest ? `\n${parts.rest}` : '');
  try {
    fs.writeFileSync(docFile, rebuilt, 'utf8');
  } catch (err) {
    throw new EpicDescriptionError(`Cannot write ${docFile}: ${(err as Error).message}`);
  }
  return 'updated';
}
