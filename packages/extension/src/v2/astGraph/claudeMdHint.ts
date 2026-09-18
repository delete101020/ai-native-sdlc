/**
 * Write a small, idempotent block to `<workspace>/.claude/CLAUDE.md`
 * telling Claude *when* to prefer the code-graph MCP tools (ast-graph or
 * codegraph, whichever engine is active) over plain grep/read. Without this
 * hint, Claude has the tools available but no reason to reach for them
 * first — which is the whole point of building the index.
 *
 * Each engine's block is delimited by HTML-comment markers so we can replace
 * it cleanly on rescan / version bump / engine switch without touching the
 * rest of the file.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type GraphEngine = 'ast-graph' | 'codegraph';

const ENGINES: GraphEngine[] = ['ast-graph', 'codegraph'];

function markers(engine: GraphEngine): { start: string; end: string } {
  return { start: `<!-- aidlc:${engine}:start -->`, end: `<!-- aidlc:${engine}:end -->` };
}

/**
 * Ensure the hint block for `engine` exists in `<folder>/.claude/CLAUDE.md`
 * and the other engine's block does not — Claude should only be pointed at
 * the server that is actually registered. Creates the file (and `.claude/`
 * dir) when missing. Replaces the block in-place when found, leaves the rest
 * of the file untouched.
 *
 * Returns the resolved path so callers can surface it in the UI.
 */
export async function ensureClaudeMdHint(
  folder: vscode.WorkspaceFolder,
  engine: GraphEngine = 'ast-graph',
  opts: { rescanOnSave?: boolean } = {},
): Promise<string> {
  const dir = path.join(folder.uri.fsPath, '.claude');
  const file = path.join(dir, 'CLAUDE.md');
  await fs.promises.mkdir(dir, { recursive: true });

  let body = '';
  try {
    body = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  let next = body;
  for (const other of ENGINES) {
    if (other !== engine) next = removeBlock(next, other);
  }
  const block = engine === 'codegraph'
    ? buildCodegraphBlock()
    : buildAstGraphBlock(opts.rescanOnSave ?? false);
  next = upsertBlock(next, block, engine);
  if (next === body) return file;
  await fs.promises.writeFile(file, next, 'utf8');
  return file;
}

/**
 * Remove `engine`'s block from `<folder>/.claude/CLAUDE.md` if present.
 * Safe to call even if the file doesn't exist.
 */
export async function removeClaudeMdHint(
  folder: vscode.WorkspaceFolder,
  engine: GraphEngine = 'ast-graph',
): Promise<void> {
  const file = path.join(folder.uri.fsPath, '.claude', 'CLAUDE.md');
  let body: string;
  try {
    body = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const stripped = removeBlock(body, engine);
  if (stripped === body) return;
  await fs.promises.writeFile(file, stripped.trimEnd() + (stripped.trimEnd() ? '\n' : ''), 'utf8');
}

function upsertBlock(body: string, block: string, engine: GraphEngine): string {
  const m = markers(engine);
  const start = body.indexOf(m.start);
  const end = body.indexOf(m.end);
  if (start !== -1 && end !== -1 && end > start) {
    const before = body.slice(0, start);
    const after = body.slice(end + m.end.length);
    // Drop a stray newline between the existing block and trailing
    // content so we don't bloat the file on every rewrite.
    const tail = after.replace(/^\r?\n/, '');
    return `${before}${block}\n${tail}`;
  }
  // Append — preserve existing content, separate with a blank line.
  const prefix = body.length === 0 ? '' : (body.endsWith('\n') ? body : body + '\n');
  const separator = body.length === 0 ? '' : '\n';
  return `${prefix}${separator}${block}\n`;
}

function removeBlock(body: string, engine: GraphEngine): string {
  const m = markers(engine);
  const start = body.indexOf(m.start);
  const end = body.indexOf(m.end);
  if (start === -1 || end === -1 || end <= start) return body;
  const before = body.slice(0, start).replace(/\n+$/, '');
  const after = body.slice(end + m.end.length).replace(/^\r?\n+/, '');
  if (!before && !after) return '';
  if (!after) return before + '\n';
  if (!before) return after;
  return `${before}\n\n${after}`;
}

// Blocks are written *for Claude* — instructive, not descriptive. Kept tight
// because CLAUDE.md is loaded on every session and we don't want to tax the
// context budget for marginal hint detail.

function buildAstGraphBlock(rescanOnSave: boolean): string {
  const m = markers('ast-graph');
  const freshness = rescanOnSave
    ? `The
extension also rescans automatically a few seconds after any source file save
(incremental), and does a full clean rescan after git operations that change the
working tree — branch switch/checkout, merge, rebase, reset, or pull.`
    : `The
extension does a full clean rescan after git operations that change the working
tree (branch switch/checkout, merge, rebase, reset, pull), but not on every file
save — symbols edited in this session may not be in the graph yet, so read the
file for anything you just changed.`;
  return `${m.start}
## ast-graph (managed by AIDLC extension — do not edit by hand)

This project has a pre-built AST graph at \`.ast-graph/graph.db\`, exposed via the
\`ast-graph\` MCP server (auto-registered by the AIDLC VS Code extension). The
graph stores every function/class/method/import in the codebase plus their
caller→callee edges, so structural questions can be answered without grepping.

**Prefer ast-graph tools over grep/read when the question is structural.** A
single MCP call is typically 10–50 tokens; the equivalent grep+read sweep across
a 500-file repo is 5k–50k.

Reach for ast-graph first for:
- "where is X defined / who calls X / what does X call" → ast-graph \`symbol\`
- "if I change X, what breaks" → ast-graph \`blast-radius\`
- "what does this PR touch structurally" → ast-graph \`changed-symbols\`
- "find unreferenced code" → ast-graph \`dead-code\`
- "list HTTP endpoints" → ast-graph \`routes\`
- "where are the architectural hotspots" → ast-graph \`hotspots\`
- "fuzzy find a symbol by partial name" → ast-graph \`search\`

Keep using grep/read/edit for:
- reading function bodies, comments, docstrings (graph stores skeletons, not source)
- editing or refactoring code
- following intent, naming, or non-AST signals (config files, prose)

If the graph looks stale, ask the user to run \`AIDLC: Rescan AST Graph\`. ${freshness}
${m.end}`;
}

function buildCodegraphBlock(): string {
  const m = markers('codegraph');
  return `${m.start}
## codegraph (managed by AIDLC extension — do not edit by hand)

This project has a CodeGraph index at \`.codegraph/\`, exposed via the
\`codegraph\` MCP server (auto-registered by the AIDLC VS Code extension). The
server watches the project and re-syncs changed files within a couple of
seconds, so the graph reflects edits made in this session too.

**Prefer \`codegraph_explore\` over grep/read sweeps when the question is
structural** — "how does X work", "who calls X", "how does X reach Y", "what
breaks if I change X". One call returns the relevant symbols' source grouped by
file, the call paths between them, and a blast-radius summary.

AIDLC skills and agents may name **ast-graph** tools. This workspace uses
codegraph instead — map them:
- ast-graph \`symbol\` / \`search\` → \`codegraph_explore\` naming the symbol
- ast-graph \`blast-radius\` / \`changed-symbols\` → \`codegraph_explore\` (its blast-radius section)
- ast-graph \`hotspots\` / \`routes\` / \`dead-code\` → \`codegraph_explore\` on the area in question

Keep using grep/read/edit for editing, config files, prose, and non-code signals.

If the index looks missing or stale, ask the user to run \`AIDLC: Rescan AST Graph\`.
${m.end}`;
}
