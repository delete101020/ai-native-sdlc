/**
 * Commit an epic's approved artifacts onto a per-epic branch — **without**
 * checking that branch out.
 *
 * The problem this solves: until a step's artifact is committed somewhere, it
 * is a dirty file in whatever branch the user happens to be standing on. The
 * pipeline itself never touched git (only the `implement` skill told the agent
 * to commit), so `intent.md`, `spec.md` and `plan.md` sat untracked until the
 * engineer's `git add` swept them up — into the right branch if the user was
 * lucky, into the wrong one if they were not, and into the same commit as the
 * code either way.
 *
 * Committing at the human gate fixes that, but a naive `git checkout` at that
 * moment would be intolerable: it would move the user's HEAD out from under an
 * editor mid-epic. So this writes the commit with **plumbing** instead:
 *
 *   read-tree (into a throwaway index)  →  hash-object  →  update-index
 *   →  write-tree  →  commit-tree  →  update-ref
 *
 * `GIT_INDEX_FILE` points at a temp file for the whole sequence, so the real
 * index is untouched; nothing here writes HEAD or the working tree. The result
 * is a real commit on `refs/heads/epic/<id>` while the user stays exactly where
 * they were. When `implement` later opens a feature branch, that branch merges
 * `epic/<id>` and inherits the artifact history instead of having to gather it
 * by hand.
 *
 * The branch is created lazily, at the first approval — an epic that is
 * abandoned before its first gate never grows a ref, and one abandoned later is
 * deleted with `git branch -D`, which is safe precisely because the branch was
 * never checked out anywhere.
 *
 * Note what this does **not** do: the files stay tracked and dirty on the
 * user's own branch. That is deliberate (`docs/epics/` remains tracked so the
 * artifacts ship with the PR and a reviewer reads them there). The epic ref is
 * a durable second home, not a relocation.
 *
 * Off by default — see {@link resolveArtifactCommitConfig}.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { RunState, StepRecord } from './RunState';
import { epicsRoot } from './EpicScaffold';
import { epicPipelinePath } from '../loader/EpicPipelineStore';

/**
 * Runs a git subcommand and returns stdout. Injectable for tests. Unlike
 * {@link GitRunStateStore}'s executor this one takes an env, because the whole
 * technique depends on `GIT_INDEX_FILE`.
 */
export type GitExec = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => string;

const defaultGitExec: GitExec = (args, cwd, env) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Resolved form of the workspace's `artifact_commit:` block. */
export interface ArtifactCommitConfig {
  /** `off` (default) writes nothing; `on_approve` commits at each human gate. */
  mode: 'off' | 'on_approve';
  /** Prefixed to the run id to form the branch name. Default `epic/`. */
  refPrefix: string;
}

const DEFAULT_REF_PREFIX = 'epic/';

/**
 * Read `artifact_commit:` off a workspace doc, defensively.
 *
 * Takes `unknown` on purpose. Callers hand it three different shapes — the raw
 * YAML document, the CLI's `YamlDocument`, the zod-validated config — and a
 * narrower parameter type would only make the two that lack an explicit
 * `artifact_commit` field fail TypeScript's weak-type check for no gain, since
 * every shape has to be probed at runtime anyway. Anything malformed degrades
 * to `off` rather than throwing: a bad key in workspace.yaml must not be able
 * to break an approval.
 */
export function resolveArtifactCommitConfig(doc: unknown): ArtifactCommitConfig {
  const raw =
    doc && typeof doc === 'object'
      ? (doc as { artifact_commit?: unknown }).artifact_commit
      : undefined;
  if (!raw || typeof raw !== 'object') {
    return { mode: 'off', refPrefix: DEFAULT_REF_PREFIX };
  }
  const rec = raw as Record<string, unknown>;
  const mode = rec.mode === 'on_approve' ? 'on_approve' : 'off';
  const prefix =
    typeof rec.ref_prefix === 'string' && rec.ref_prefix.trim()
      ? rec.ref_prefix.trim()
      : DEFAULT_REF_PREFIX;
  return { mode, refPrefix: prefix };
}

export interface CommitApprovedArtifactsArgs {
  workspaceRoot: string;
  /** Run state *before* the transition. Used to spot what newly became approved. */
  before: RunState;
  /** Run state *after* the transition. Its steps supply `artifactsProduced`. */
  after: RunState;
  /** Raw workspace doc — supplies `state.root` and `artifact_commit`. */
  doc: { state?: unknown; artifact_commit?: unknown } | null;
  git?: GitExec;
}

export interface CommitApprovedArtifactsResult {
  /** True when a commit was actually written. */
  committed: boolean;
  /** Full ref that was updated, e.g. `refs/heads/epic/EPIC-003`. */
  ref?: string;
  /** SHA of the new commit. */
  commit?: string;
  /** Repo-relative paths that went into it. */
  files?: string[];
  /**
   * Why nothing was written. Present whenever `committed` is false — including
   * the ordinary cases (feature off, no step approved, nothing changed), so a
   * caller that logs this never has to guess between "skipped" and "broke".
   */
  reason?: string;
}

/**
 * Commit the artifacts of every step that just reached `approved`.
 *
 * Best-effort by contract: any git failure comes back as
 * `{ committed: false, reason }` rather than an exception. An approval is a
 * decision the human already made — it must not be undone because the repo has
 * no committer identity configured or the ref moved under us.
 */
export function commitApprovedArtifacts(
  args: CommitApprovedArtifactsArgs,
): CommitApprovedArtifactsResult {
  const { workspaceRoot, before, after, doc } = args;
  const git = args.git ?? defaultGitExec;

  const cfg = resolveArtifactCommitConfig(doc);
  if (cfg.mode !== 'on_approve') {
    return { committed: false, reason: 'artifact_commit is off' };
  }

  const approved = newlyApproved(before, after);
  if (approved.length === 0) {
    return { committed: false, reason: 'no step reached approved' };
  }

  try {
    return writeCommit(workspaceRoot, after, approved, doc, cfg, git);
  } catch (err) {
    return { committed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Steps that are `approved` in `after` but were not in `before`.
 *
 * Matched by `stepIdx` rather than by array position so a run whose step list
 * was edited between the two snapshots (see EpicStepEdit) cannot make an
 * unrelated step look freshly approved.
 */
function newlyApproved(before: RunState, after: RunState): StepRecord[] {
  const wasApproved = new Map<number, boolean>();
  for (const s of before.steps) {
    wasApproved.set(s.stepIdx, s.status === 'approved');
  }
  return after.steps.filter((s) => s.status === 'approved' && !wasApproved.get(s.stepIdx));
}

function writeCommit(
  workspaceRoot: string,
  state: RunState,
  approved: StepRecord[],
  doc: { state?: unknown } | null,
  cfg: ArtifactCommitConfig,
  git: GitExec,
): CommitApprovedArtifactsResult {
  const repoRoot = path.resolve(git(['rev-parse', '--show-toplevel'], workspaceRoot).trim());

  // Every produces path of every newly-approved step, plus the epic's
  // state.json — the artifact and the record of its approval belong in the
  // same commit, or the branch shows work with no verdict attached to it.
  const abs = new Set<string>();
  for (const step of approved) {
    for (const rel of step.artifactsProduced ?? []) {
      abs.add(path.isAbsolute(rel) ? rel : path.resolve(workspaceRoot, rel));
    }
  }
  abs.add(path.join(epicsRoot(workspaceRoot, doc), state.runId, 'state.json'));
  // …and the pipeline the epic owns, when it has one of its own. state.json
  // names the pipeline but does not describe it, so a branch without the
  // definition records which steps were approved and nothing about what they
  // were. Absent for an epic running a shared pipeline, and skipped below.
  abs.add(epicPipelinePath(workspaceRoot, doc, state.runId));

  const files: Array<{ abs: string; rel: string }> = [];
  for (const p of abs) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) { continue; }
    const rel = path.relative(repoRoot, p).split(path.sep).join('/');
    // A produces path pointing outside the repo cannot be indexed. Skip it
    // rather than fail the whole commit — the epic's own files still land.
    if (rel.startsWith('../')) { continue; }
    files.push({ abs: p, rel });
  }
  if (files.length === 0) {
    return { committed: false, reason: 'no artifact file exists on disk' };
  }

  const ref = `refs/heads/${cfg.refPrefix}${state.runId}`;
  if (!trySilently(git, repoRoot, ['check-ref-format', ref])) {
    return { committed: false, reason: `invalid branch name from ref_prefix: ${ref}` };
  }

  // Parent: the epic branch if it exists, otherwise wherever the user is
  // standing right now. That anchors a new epic ref to the branch the work was
  // started from, which is what a later merge wants.
  const existing = tryRevParse(git, repoRoot, ref);
  const parent = existing ?? tryRevParse(git, repoRoot, 'HEAD');
  if (!parent) {
    return { committed: false, reason: 'repository has no commit to build on' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-artifact-idx-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmpDir, 'index') };
    git(['read-tree', parent], repoRoot, env);
    for (const f of files) {
      // `--path` makes git apply the same filters (line endings, clean filters)
      // it would apply if the file were staged at that path — without it, a
      // CRLF working copy would be stored verbatim and the branch would differ
      // from a normal commit of the same file.
      const blob = git(['hash-object', '-w', '--path', f.rel, f.abs], repoRoot, env).trim();
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${f.rel}`], repoRoot, env);
    }
    const tree = git(['write-tree'], repoRoot, env).trim();

    const parentTree = git(['rev-parse', `${parent}^{tree}`], repoRoot).trim();
    if (tree === parentTree) {
      return { committed: false, reason: 'artifacts already committed — nothing changed' };
    }

    // Message via file, never via argv: these bodies are multi-line and quoting
    // them through a shell has broken before.
    const msgFile = path.join(tmpDir, 'msg');
    fs.writeFileSync(msgFile, commitMessage(state, approved, files, ref), 'utf8');
    const commit = git(['commit-tree', tree, '-p', parent, '-F', msgFile], repoRoot).trim();

    // Compare-and-swap: the third argument is the value the ref must currently
    // have — the empty string meaning "must not exist". A concurrent approval
    // that moved the ref fails here instead of silently discarding its commit.
    git(['update-ref', '-m', `aidlc: ${state.runId} artifacts`, ref, commit, existing ?? ''], repoRoot);

    return { committed: true, ref, commit, files: files.map((f) => f.rel) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function commitMessage(
  state: RunState,
  approved: StepRecord[],
  files: Array<{ rel: string }>,
  ref: string,
): string {
  const names = approved.map((s) => s.name ?? s.agent).join(', ');
  const revisions = approved
    .filter((s) => s.revision > 1)
    .map((s) => `${s.name ?? s.agent} at revision ${s.revision}`);

  const lines = [
    `docs(${state.runId}): ${names} approved`,
    '',
    `Written by ${approved.map((s) => s.agent).join(', ')} and approved at the human gate.`,
  ];
  if (revisions.length > 0) {
    lines.push(`Reruns before this: ${revisions.join('; ')}.`);
  }
  lines.push('', 'Files:');
  for (const f of files) { lines.push(`  ${f.rel}`); }
  lines.push(
    '',
    `Written straight to ${ref} with git plumbing — HEAD, the index and the`,
    'working tree were not touched, so the epic keeps a branch of its own without',
    'ever moving the checkout. Merge this branch into the feature branch when',
    'implementation starts.',
    '',
  );
  return lines.join('\n');
}

function tryRevParse(git: GitExec, cwd: string, rev: string): string | null {
  try {
    const out = git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], cwd).trim();
    return out || null;
  } catch {
    return null;
  }
}

function trySilently(git: GitExec, cwd: string, args: string[]): boolean {
  try { git(args, cwd); return true; } catch { return false; }
}
