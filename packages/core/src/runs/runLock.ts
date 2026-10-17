/**
 * One exec loop per run.
 *
 * The loop reloads state every iteration, so a human clicking Approve in the
 * extension while `aidlc run exec` drives the same run is fine. Two loops on
 * one run are not: both would spawn an agent on the same step, in the same
 * working tree. `.aidlc/runs/<id>.lock` holds the pid of the loop that owns
 * the run; a lock whose process is gone (crash, kill -9, closed editor) is
 * taken over rather than left to block the run forever.
 */

import * as fs from 'fs';
import * as path from 'path';

import { RunStateStore } from './RunStateStore';

export type RunLock = { release(): void } | { heldBy: number };

export function runLockFile(root: string, runId: string): string {
  return RunStateStore.file(root, runId).replace(/\.json$/, '.lock');
}

/** Take the run's lock, or say which live process holds it. */
export function acquireRunLock(root: string, runId: string): RunLock {
  const file = runLockFile(root, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Two tries: the second follows taking over a lock left by a dead process.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return {
        release: () => {
          // Only our own: a lock taken over after ours was judged stale is not.
          if (lockPid(file) === process.pid) { fs.rmSync(file, { force: true }); }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
    }
    const pid = lockPid(file);
    if (pid !== null && isAlive(pid)) { return { heldBy: pid }; }
    fs.rmSync(file, { force: true });
  }
  // Lost a race for the stale lock to another process that just took it.
  return { heldBy: lockPid(file) ?? -1 };
}

function lockPid(file: string): number | null {
  try {
    const pid = (JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, it just is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
