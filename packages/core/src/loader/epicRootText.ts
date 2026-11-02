/**
 * The bundled personas and skills spell epic paths as `docs/epics/...`, the
 * default for `state.root`. A project that moved its epics needs them to say
 * where the epics really are, and there are two cases:
 *
 * - Text this project owns (a composed slash command, a headless prompt) knows
 *   the root when it is built, so the path is rewritten.
 * - Files installed once per machine (`~/.claude/agents`, `~/.claude/skills`)
 *   are shared by every project and cannot name one root. What loads them gets
 *   {@link epicRootSection}, which says how to read them.
 *
 * A project on the default root sees neither, so its text does not change.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import { resolvePath } from '../runs/RunState';

export const DEFAULT_EPIC_ROOT = 'docs/epics';

const EPIC_ROOT_HEADING = '## Epic folder';

/** Matches the default root as a path prefix, not inside a longer path. */
const DEFAULT_ROOT_PATH = /(?<![\w./-])docs\/epics(?=\/)/g;

/** The line every generated command body opens its work with. */
const STATE_FILE_LINE = /`([^`\n]+)\/(?:<epic>|\$ARGUMENTS)\/state\.json`/;

const LEGACY_ARTIFACT_PREFIX = /^(?:\.\/)?docs\/epics\/(?=\{epic\}\/)/;

function cleanRoot(epicRoot: string): string {
  const trimmed = epicRoot.trim().replace(/^\.\//, '');
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

/** `state.root` of a workspace doc, as written, or the default. */
export function epicRootOf(doc: { state?: unknown } | null | undefined): string {
  const root = (doc?.state as { root?: unknown } | undefined)?.root;
  return typeof root === 'string' && root.trim() ? root : DEFAULT_EPIC_ROOT;
}

/**
 * `state.root` for code that only has the workspace folder. Read on each call
 * so a root changed while the window is open applies to the next gate check.
 */
export function readEpicRoot(workspaceRoot: string): string {
  try {
    const file = path.join(workspaceRoot, '.aidlc', 'workspace.yaml');
    return epicRootOf(yaml.load(fs.readFileSync(file, 'utf8')) as { state?: unknown } | null);
  } catch {
    return DEFAULT_EPIC_ROOT;
  }
}

/**
 * Put the epic root into a `produces` / `requires` path. Pipelines installed
 * before `{epic_root}` existed spell the same location `docs/epics/{epic}/`,
 * and epics carry their own copy of the pipeline, so that spelling follows the
 * root too rather than every such file having to be rewritten.
 */
export function expandEpicRoot(template: string, epicRoot: string): string {
  const root = cleanRoot(epicRoot);
  return template
    .replace(LEGACY_ARTIFACT_PREFIX, () => `${root}/`)
    .replace(/\{epic_root\}/g, () => root);
}

/** `resolvePath` for a `produces` / `requires` path, which may name the epic root. */
export function resolveArtifactPath(
  template: string,
  context: Record<string, string>,
  epicRoot: string,
): string {
  return resolvePath(expandEpicRoot(template, epicRoot), context);
}

function isCustomRoot(epicRoot: string | null | undefined): epicRoot is string {
  return !!epicRoot?.trim() && cleanRoot(epicRoot) !== DEFAULT_EPIC_ROOT;
}

/** Rewrite `docs/epics/...` paths in `text` to the project's epic root. */
export function localizeEpicRoot(text: string, epicRoot: string | null | undefined): string {
  if (!isCustomRoot(epicRoot)) { return text; }
  const root = cleanRoot(epicRoot);
  return text.replace(DEFAULT_ROOT_PATH, () => root);
}

/**
 * Tells an agent how to read the machine-wide files it loads, which still say
 * `docs/epics`. Null on the default root, where they are already correct.
 */
export function epicRootSection(epicRoot: string | null | undefined): string | null {
  if (!isCustomRoot(epicRoot)) { return null; }
  const root = cleanRoot(epicRoot);
  return `${EPIC_ROOT_HEADING}\n\nThis project keeps its epics in \`${root}\`, not the default \`${DEFAULT_EPIC_ROOT}\`. Wherever a persona or skill says \`${DEFAULT_EPIC_ROOT}/...\`, read and write \`${root}/...\` instead.`;
}

/**
 * Was this generated command body written for a different epic root? A body
 * with no state-file line is not one of ours, so it is left alone.
 */
export function commandBodyPredatesEpicRoot(existing: string, epicRoot: string): boolean {
  const named = STATE_FILE_LINE.exec(existing)?.[1];
  if (!named) { return false; }
  if (cleanRoot(named) !== cleanRoot(epicRoot)) { return true; }
  return isCustomRoot(epicRoot) && !existing.includes(EPIC_ROOT_HEADING);
}
