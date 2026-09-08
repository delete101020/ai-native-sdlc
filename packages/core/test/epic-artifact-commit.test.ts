/**
 * Committing an epic's artifacts to a branch of its own, without checking that
 * branch out.
 *
 * The whole point of the plumbing route is what it does *not* do, so most of
 * these tests assert absence: HEAD unmoved, branch unchanged, index untouched,
 * working tree exactly as it was. Those are the properties that make the
 * feature usable mid-epic, and the ones a refactor toward `git checkout` or
 * `git add` would silently destroy.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  commitApprovedArtifacts,
  resolveArtifactCommitConfig,
  type RunState,
} from '../src';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'test@aidlc',
  GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'test@aidlc',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...GIT_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const ON: { state?: unknown; artifact_commit?: unknown } = {
  artifact_commit: { mode: 'on_approve' },
};

let repo: string;

/** A repo with one commit on `main` and an epic whose intent.md is on disk. */
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-artifact-'));
  git(['init', '-q', '-b', 'main', '.'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-qm', 'seed'], repo);

  const epicDir = path.join(repo, 'docs', 'epics', 'EPIC-001');
  fs.mkdirSync(path.join(epicDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(epicDir, 'artifacts', 'intent.md'), '# Intent\n');
  fs.writeFileSync(path.join(epicDir, 'state.json'), '{"status":"in_progress"}\n');
});

function state(overrides: {
  status: 'awaiting_review' | 'approved';
  produces?: string[];
  revision?: number;
}): RunState {
  return {
    schemaVersion: 2,
    runId: 'EPIC-001',
    pipelineId: 'ai-native-full',
    context: {},
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    currentStepIdx: 0,
    status: 'running',
    steps: [{
      stepIdx: 0,
      agent: 'aidlc-native-originator',
      name: 'intent',
      revision: overrides.revision ?? 1,
      status: overrides.status,
      artifactsProduced: overrides.produces ?? ['docs/epics/EPIC-001/artifacts/intent.md'],
    }],
  } as unknown as RunState;
}

const before = () => state({ status: 'awaiting_review' });
const after = () => state({ status: 'approved' });

describe('resolveArtifactCommitConfig', () => {
  it('defaults to off with the epic/ prefix', () => {
    expect(resolveArtifactCommitConfig(null)).toEqual({ mode: 'off', refPrefix: 'epic/' });
    expect(resolveArtifactCommitConfig({})).toEqual({ mode: 'off', refPrefix: 'epic/' });
  });

  it('reads mode and ref_prefix', () => {
    expect(resolveArtifactCommitConfig({
      artifact_commit: { mode: 'on_approve', ref_prefix: 'aidlc/epic-' },
    })).toEqual({ mode: 'on_approve', refPrefix: 'aidlc/epic-' });
  });

  it('degrades a malformed block to off rather than throwing', () => {
    expect(resolveArtifactCommitConfig({ artifact_commit: 'yes' }).mode).toBe('off');
    expect(resolveArtifactCommitConfig({ artifact_commit: { mode: 'sometimes' } }).mode).toBe('off');
  });
});

describe('commitApprovedArtifacts', () => {
  it('writes the artifact and state.json onto epic/<runId>', () => {
    const r = commitApprovedArtifacts({
      workspaceRoot: repo, before: before(), after: after(), doc: ON, git,
    });

    expect(r.committed).toBe(true);
    expect(r.ref).toBe('refs/heads/epic/EPIC-001');
    expect(r.files).toEqual([
      'docs/epics/EPIC-001/artifacts/intent.md',
      'docs/epics/EPIC-001/state.json',
    ]);

    const tree = git(['ls-tree', '-r', '--name-only', 'refs/heads/epic/EPIC-001'], repo).split('\n');
    expect(tree).toContain('docs/epics/EPIC-001/artifacts/intent.md');
    expect(tree).toContain('docs/epics/EPIC-001/state.json');
    // The base commit's content rides along — the branch is the user's branch
    // plus artifacts, not an orphan holding documents alone.
    expect(tree).toContain('README.md');
  });

  it('leaves HEAD, the branch, the index and the working tree untouched', () => {
    const headBefore = git(['rev-parse', 'HEAD'], repo).trim();
    const branchBefore = git(['branch', '--show-current'], repo).trim();
    const statusBefore = git(['status', '--porcelain'], repo);

    commitApprovedArtifacts({ workspaceRoot: repo, before: before(), after: after(), doc: ON, git });

    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(headBefore);
    expect(git(['branch', '--show-current'], repo).trim()).toBe(branchBefore);
    expect(git(['status', '--porcelain'], repo)).toBe(statusBefore);
    // Nothing staged: the artifacts are still untracked on main.
    expect(git(['diff', '--cached', '--name-only'], repo).trim()).toBe('');
  });

  it('is off unless the workspace asks for it', () => {
    const r = commitApprovedArtifacts({
      workspaceRoot: repo, before: before(), after: after(), doc: {}, git,
    });
    expect(r.committed).toBe(false);
    expect(r.reason).toMatch(/off/);
    expect(() => git(['rev-parse', 'refs/heads/epic/EPIC-001'], repo)).toThrow();
  });

  it('does nothing when no step newly reached approved', () => {
    const r = commitApprovedArtifacts({
      workspaceRoot: repo, before: after(), after: after(), doc: ON, git,
    });
    expect(r.committed).toBe(false);
    expect(r.reason).toMatch(/no step reached approved/);
  });

  it('chains the second approval onto the first commit', () => {
    const first = commitApprovedArtifacts({
      workspaceRoot: repo, before: before(), after: after(), doc: ON, git,
    });

    fs.writeFileSync(path.join(repo, 'docs/epics/EPIC-001/artifacts/spec.md'), '# Spec\n');
    const specBefore = state({ status: 'awaiting_review', produces: ['docs/epics/EPIC-001/artifacts/spec.md'] });
    const specAfter = state({ status: 'approved', produces: ['docs/epics/EPIC-001/artifacts/spec.md'] });
    const second = commitApprovedArtifacts({
      workspaceRoot: repo, before: specBefore, after: specAfter, doc: ON, git,
    });

    expect(second.committed).toBe(true);
    const parents = git(['rev-list', '--parents', '-n', '1', second.commit!], repo).trim().split(' ');
    expect(parents[1]).toBe(first.commit);
    // Both artifacts present — the second commit built on the first's tree.
    const tree = git(['ls-tree', '-r', '--name-only', second.commit!], repo).split('\n');
    expect(tree).toContain('docs/epics/EPIC-001/artifacts/intent.md');
    expect(tree).toContain('docs/epics/EPIC-001/artifacts/spec.md');
  });

  it('refuses to write an empty commit when the artifact has not changed', () => {
    commitApprovedArtifacts({ workspaceRoot: repo, before: before(), after: after(), doc: ON, git });
    const tip = git(['rev-parse', 'refs/heads/epic/EPIC-001'], repo).trim();

    const again = commitApprovedArtifacts({
      workspaceRoot: repo,
      before: state({ status: 'awaiting_review', revision: 2 }),
      after: state({ status: 'approved', revision: 2 }),
      doc: ON, git,
    });

    expect(again.committed).toBe(false);
    expect(again.reason).toMatch(/nothing changed/);
    expect(git(['rev-parse', 'refs/heads/epic/EPIC-001'], repo).trim()).toBe(tip);
  });

  it('skips a produces path that does not exist, and commits the rest', () => {
    const r = commitApprovedArtifacts({
      workspaceRoot: repo,
      before: state({ status: 'awaiting_review', produces: ['docs/epics/EPIC-001/artifacts/nope.md'] }),
      after: state({ status: 'approved', produces: ['docs/epics/EPIC-001/artifacts/nope.md'] }),
      doc: ON, git,
    });
    // state.json still exists, so the commit happens and carries only that.
    expect(r.committed).toBe(true);
    expect(r.files).toEqual(['docs/epics/EPIC-001/state.json']);
  });

  it('honours a custom ref_prefix', () => {
    const r = commitApprovedArtifacts({
      workspaceRoot: repo, before: before(), after: after(), git,
      doc: { artifact_commit: { mode: 'on_approve', ref_prefix: 'aidlc/epic-' } },
    });
    expect(r.ref).toBe('refs/heads/aidlc/epic-EPIC-001');
  });

  it('reports a git failure instead of throwing', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-nogit-'));
    const r = commitApprovedArtifacts({
      workspaceRoot: outside, before: before(), after: after(), doc: ON, git,
    });
    expect(r.committed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('records the approved step name in the commit subject', () => {
    const r = commitApprovedArtifacts({
      workspaceRoot: repo, before: before(), after: after(), doc: ON, git,
    });
    const subject = git(['log', '-1', '--format=%s', r.commit!], repo).trim();
    expect(subject).toBe('docs(EPIC-001): intent approved');
  });
});
