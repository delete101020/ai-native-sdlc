/**
 * Auto-review runner that reads the verdict a verify or review step wrote.
 *
 * The step's artifact (`verify.md`, `review.md`) carries one line
 *
 *   Verdict: pass | fail      (verify)
 *   Verdict: ship | hold      (review)
 *
 * and this validator turns it into `{ decision, reason }`: `pass` / `ship`
 * let the step through, `fail` / `hold` reject it. Bold and heading markup
 * around the line is fine; a comment after a dash is fine
 * (`Verdict: hold — two blockers`).
 *
 * It fails closed. No artifact, no verdict line, a word it does not know,
 * a placeholder left unfilled (`Verdict: ship / hold`) or two lines that
 * disagree all reject — a review nobody can read is not a ship.
 *
 * On a reject, the reason is the report's "Shortest path to …" section (or
 * the lines under the verdict when there is none), so the step that gets the
 * work back is told what to change, not just that it failed.
 *
 * Contract (see packages/core/src/runs/AutoReviewer.ts):
 *   export default async ({ workspaceRoot, state, step, pipeline, paths }) =>
 *     ({ decision: 'pass' | 'reject', reason: string })
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const DECISIONS = { pass: 'pass', ship: 'pass', fail: 'reject', hold: 'reject' };

// `Verdict: hold`, `**Verdict:** hold`, `## Verdict: **hold**`, `> Verdict: hold`
const LINE = /^[\s>#*_-]*verdict[\s*_]*:[\s*_`]*([a-z]+)[*_`]*(.*)$/i;
// What may follow the word: nothing, or a comment set off by a dash or a bracket.
const TAIL = /^\s*(?:$|[—–-]\s|[(.,;])/;

export function readVerdict(text, file = 'the report') {
  const expected = /verify/i.test(file) ? '`Verdict: pass` or `Verdict: fail`' : '`Verdict: ship` or `Verdict: hold`';
  const lines = text.split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    const m = LINE.exec(line);
    if (m) { found.push({ i, word: m[1].toLowerCase(), tail: m[2] }); }
  });

  if (found.length === 0) {
    return { decision: 'reject', reason: `${file} has no verdict line. Add one: ${expected}.` };
  }
  for (const f of found) {
    if (!(f.word in DECISIONS) || !TAIL.test(f.tail)) {
      return {
        decision: 'reject',
        reason: `${file} line ${f.i + 1}: unreadable verdict "${lines[f.i].trim()}". Expected ${expected}.`,
      };
    }
  }
  const decisions = new Set(found.map((f) => DECISIONS[f.word]));
  if (decisions.size > 1) {
    return {
      decision: 'reject',
      reason: `${file} gives conflicting verdicts (${found.map((f) => f.word).join(', ')}). Keep one.`,
    };
  }

  const last = found[found.length - 1];
  if (DECISIONS[last.word] === 'pass') {
    return { decision: 'pass', reason: `Verdict: ${last.word}` };
  }
  const changes = shortestPath(lines) ?? body(lines, last.i + 1);
  return {
    decision: 'reject',
    reason: changes
      ? `Verdict: ${last.word}. Changes needed:\n${changes}`
      : `Verdict: ${last.word}. ${file} lists no changes; read its findings.`,
  };
}

/** Body of the "Shortest path to ship/pass" section, minus template hints. */
function shortestPath(lines) {
  const start = lines.findIndex((l) => /^#+\s.*shortest path/i.test(l));
  return start < 0 ? null : body(lines, start + 1);
}

/** Lines from `from` up to the next heading or rule. */
function body(lines, from) {
  const out = [];
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (/^#+\s/.test(l) || /^---\s*$/.test(l)) { break; }
    if (/^\s*>/.test(l)) { continue; }          // template hint
    if (/^\s*(\d+\.|[-*])\s*$/.test(l)) { continue; } // empty list item
    out.push(l);
  }
  const text = out.join('\n').trim();
  return text || null;
}

export default async function verdict({ paths }) {
  const file = paths.produces.find((p) => p.endsWith('.md'));
  if (!file) {
    return { decision: 'reject', reason: 'This step declares no .md artifact to read a verdict from.' };
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { decision: 'reject', reason: `Cannot read ${basename(file)}: ${err.message}` };
  }
  return readVerdict(text, basename(file));
}
