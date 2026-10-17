/**
 * Stopping an agent mid-step.
 *
 * Killing the `claude` (or `codex`, `copilot`) process is not enough: it runs
 * the agent's tools as children of its own — a test suite, a dev server, a
 * build — and those outlive a killed parent, still writing to the working
 * tree. So the runners spawn the CLI as the leader of a process group of its
 * own and signal the group: SIGTERM first so the CLI can flush and the tools
 * can clean up, SIGKILL for whatever is left after a grace period. On Windows
 * `taskkill /T /F` walks the tree instead.
 */

import { spawn, type ChildProcess } from 'child_process';

/** How long a stopped process tree gets between SIGTERM and SIGKILL. */
export const STOP_GRACE_MS = 10_000;

/**
 * Spawn options that make the child a process-group leader, so
 * {@link stopProcessTree} can reach its descendants. Not on Windows, where
 * `detached` opens a console window and `taskkill /T` needs no group.
 */
export function processGroupSpawnOptions(): { detached?: boolean } {
  return process.platform === 'win32' ? {} : { detached: true };
}

/**
 * Stop `proc` and everything it started when `signal` aborts. Returns a
 * function that detaches the listener — call it once the process has exited.
 */
export function stopOnAbort(
  proc: ChildProcess,
  signal: AbortSignal | undefined,
  graceMs: number = STOP_GRACE_MS,
): () => void {
  if (!signal) { return () => {}; }
  let timer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    stopProcessTree(proc, 'SIGTERM');
    timer = setTimeout(() => stopProcessTree(proc, 'SIGKILL'), graceMs);
    timer.unref?.();
  };
  if (signal.aborted) { onAbort(); } else { signal.addEventListener('abort', onAbort, { once: true }); }
  return () => {
    signal.removeEventListener('abort', onAbort);
    // The leader exiting does not mean its group did; finish the job on the
    // stragglers rather than leave the escalation timer to do it later.
    if (timer) {
      clearTimeout(timer);
      stopProcessTree(proc, 'SIGKILL');
    }
  };
}

/** Signal `proc`'s whole process group (POSIX) or tree (Windows). Best-effort. */
export function stopProcessTree(proc: ChildProcess, sig: 'SIGTERM' | 'SIGKILL'): void {
  const pid = proc.pid;
  if (!pid) { return; }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    // Not a group leader (spawned without `detached`), or already gone.
    try { proc.kill(sig); } catch { /* already gone */ }
  }
}
