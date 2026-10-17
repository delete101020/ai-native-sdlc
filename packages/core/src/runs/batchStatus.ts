/**
 * Is a batched step finished, or does it want another session?
 *
 * A step with `batches: true` runs as a series of fresh agent sessions, each
 * doing one slice of the plan. The session says which it was in its report:
 * the last `Status:` line of the step's first `produces` file reads
 * `Status: continue` or `Status: done`. The loop reads nothing else — not the
 * plan, not the progress table — so how the work is sliced stays the skill's
 * business.
 *
 * Fail closed: a report with no such line, or whose last `Status:` line says
 * something else (the template's own `**Status:** Draft`, a placeholder), is
 * an error. Guessing `done` would send half the plan to review; guessing
 * `continue` would loop a session that does not know it is batched.
 */

import * as fs from 'fs';
import * as path from 'path';

export type BatchStatus = 'continue' | 'done';

// `Status: done`, `**Status:** continue`, `## Status: **done**`, `> Status: done`
const LINE = /^[\s>#*_-]*status[\s*_]*:[\s*_`]*([a-z]+)[*_`]*(.*)$/i;
// What may follow the word: nothing, a dash and a note, or punctuation.
const TAIL = /^\s*(?:$|[—–-]\s|[(.,;])/;

/** The status `text` ends on, or why it cannot be read. */
export function readBatchStatus(text: string, file = 'the report'): { status: BatchStatus } | { error: string } {
  let last: { word: string; tail: string } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) { last = { word: m[1].toLowerCase(), tail: m[2] }; }
  }
  if (!last) {
    return { error: `${file} has no \`Status: continue\` or \`Status: done\` line.` };
  }
  if ((last.word === 'continue' || last.word === 'done') && TAIL.test(last.tail)) {
    return { status: last.word };
  }
  return {
    error: `The last Status line in ${file} reads "${last.word}${last.tail}", not \`Status: continue\` or ` +
      '`Status: done`.',
  };
}

/** {@link readBatchStatus} on a file under `root`. */
export function readBatchStatusFile(root: string, rel: string): { status: BatchStatus } | { error: string } {
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return { error: `${rel} does not exist, so the batch did not say whether it is done.` };
  }
  return readBatchStatus(text, rel);
}
