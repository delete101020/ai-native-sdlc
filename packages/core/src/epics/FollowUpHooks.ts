/**
 * Running a workspace's follow-up hooks, and remembering what they did.
 *
 * `on_followups_opened` runs once per batch of children, never once per child,
 * so the children never race each other to edit the same file.
 * `on_followup_done` runs when one child reaches done. Both are declared on the
 * parent's pipeline — see `schema/FollowUpHookSchema.ts`.
 *
 * A hook is the workspace's business: it gets the parent, the children and
 * their keys, and a non-zero exit is reported, never rolled back. Epics that
 * were opened stay opened; the failure is written to the parent's ledger, where
 * the epic card shows it until a sync succeeds.
 *
 * The ledger (`followups-hooks.json`, beside the manifest) is also what keeps
 * `on_followup_done` to once per child. It lives with the epic, tracked, so a
 * teammate pulling a finished child does not run the hook a second time.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

import { stepDagId } from '../schema/WorkspaceSchema';
import type { PipelineStepConfig } from '../schema/WorkspaceSchema';
import { stepProducesFollowUps, type FollowUpHookKey } from '../schema/FollowUpHookSchema';
import { epicsRoot } from '../runs/EpicScaffold';

/** The parent's record of hook runs. */
export const FOLLOW_UP_HOOKS_LEDGER = 'followups-hooks.json';

/** Longest stderr/stdout tail kept — enough to read the error, not a log. */
const OUTPUT_TAIL = 8_000;

/** Default ceiling for one hook run. */
export const FOLLOW_UP_HOOK_TIMEOUT_MS = 5 * 60_000;

type RawDoc = { state?: unknown; pipelines?: unknown } | null;
type RawStep = Record<string, unknown>;

export interface FollowUpHooks {
  /** Step identity (`name`, else `agent`) the hooks were declared on. */
  stepName: string;
  on_followups_opened?: string;
  on_followup_done?: string;
}

function hookValue(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function stepsOf(pipeline: Record<string, unknown> | undefined): RawStep[] {
  const steps = pipeline?.steps;
  return Array.isArray(steps) ? steps.filter((s): s is RawStep => !!s && typeof s === 'object') : [];
}

/** Pipeline id recorded in the epic's `state.json`, or null. */
export function epicPipelineId(workspaceRoot: string, doc: RawDoc, epicId: string): string | null {
  const file = path.join(epicsRoot(workspaceRoot, doc), epicId, 'state.json');
  if (!fs.existsSync(file)) { return null; }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { pipeline?: unknown };
    return typeof parsed.pipeline === 'string' && parsed.pipeline ? parsed.pipeline : null;
  } catch {
    return null;
  }
}

/**
 * Hooks declared for the work `parentEpicId` handed forward, or null.
 *
 * An epic's own pipeline is assembled from a recipe and copies only what a
 * runner needs, so hooks are read from the pipeline it was `derived_from` —
 * the one in `workspace.yaml` a person edits. That is also what makes a change
 * to the hook reach epics that were started before it. A pipeline with no
 * source is hand-authored and read as is.
 */
export function resolveFollowUpHooks(
  workspaceRoot: string,
  doc: RawDoc,
  parentEpicId: string,
): FollowUpHooks | null {
  const pipelineId = epicPipelineId(workspaceRoot, doc, parentEpicId);
  if (!pipelineId) { return null; }
  const pipelines = (Array.isArray(doc?.pipelines) ? doc.pipelines : []) as Array<Record<string, unknown>>;
  const own = pipelines.find((p) => p.id === pipelineId);
  if (!own) { return null; }

  const sourceId = typeof own.derived_from === 'string' ? own.derived_from : undefined;
  const source = sourceId ? pipelines.find((p) => p.id === sourceId) : undefined;
  const ownIds = new Set(stepsOf(own).map((s) => stepDagId(s as PipelineStepConfig)));
  const candidates = source
    ? stepsOf(source).filter((s) => ownIds.has(stepDagId(s as PipelineStepConfig)))
    : stepsOf(own);

  for (const step of candidates) {
    if (!stepProducesFollowUps(step)) { continue; }
    const opened = hookValue(step.on_followups_opened);
    const done = hookValue(step.on_followup_done);
    if (!opened && !done) { continue; }
    return {
      stepName: stepDagId(step as PipelineStepConfig),
      ...(opened && { on_followups_opened: opened }),
      ...(done && { on_followup_done: done }),
    };
  }
  return null;
}

// ── Running ───────────────────────────────────────────────────────────

export interface FollowUpHookChild {
  /** Manifest key the child was opened from; null for an incident follow-up. */
  follow_up_key: string | null;
  epic: string;
  recipe: string | null;
  /** Epic status at the time of the run, when the caller knows it. */
  status?: string;
}

/**
 * `opened` — children just opened; `sync` — every child the parent has, re-run
 * by hand; `done` — one child finished.
 */
export type FollowUpHookEvent = 'opened' | 'sync' | 'done';

export interface FollowUpHookPayload {
  event: FollowUpHookEvent;
  parent_epic: string;
  children: FollowUpHookChild[];
  /** The finished child, for `done`. */
  child?: FollowUpHookChild;
}

export interface FollowUpHookRun {
  hook: FollowUpHookKey;
  event: FollowUpHookEvent;
  /** Command as run, placeholders filled. */
  command: string;
  at: string;
  ok: boolean;
  /** Null when the process never started or was killed. */
  exitCode: number | null;
  /** Tail of stderr — with a reason appended when there was no exit code. */
  stderr: string;
  stdout: string;
  durationMs: number;
  /** Child epic ids the run covered. */
  children: string[];
}

export interface RunFollowUpHookArgs {
  workspaceRoot: string;
  hook: FollowUpHookKey;
  command: string;
  payload: FollowUpHookPayload;
  timeoutMs?: number;
  /** Base environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Fill `{epic}`, `{child}`, `{key}`. Unknown placeholders are left as written. */
export function fillFollowUpHookCommand(command: string, payload: FollowUpHookPayload): string {
  const values: Record<string, string | undefined> = {
    epic: payload.parent_epic,
    child: payload.child?.epic,
    key: payload.child?.follow_up_key ?? undefined,
  };
  return command.replace(/\{([a-zA-Z0-9_-]+)\}/g, (match, key: string) => values[key] ?? match);
}

function tail(s: string): string {
  return s.length > OUTPUT_TAIL ? `…${s.slice(-OUTPUT_TAIL)}` : s;
}

/**
 * Run one hook in the workspace root, through the shell.
 *
 * The command gets the parent and children twice over: as environment
 * variables for a one-line script, and as a JSON file (`AIDLC_FOLLOWUPS_PAYLOAD`)
 * for anything that wants the whole list. The file is removed afterwards.
 * Never rejects: a hook that cannot start is a failed run like any other.
 */
export function runFollowUpHook(args: RunFollowUpHookArgs): Promise<FollowUpHookRun> {
  const { workspaceRoot, hook, payload } = args;
  const command = fillFollowUpHookCommand(args.command, payload);
  const timeoutMs = args.timeoutMs ?? FOLLOW_UP_HOOK_TIMEOUT_MS;
  const started = Date.now();
  const at = new Date(started).toISOString();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-followups-'));
  const payloadFile = path.join(tmpDir, 'payload.json');
  fs.writeFileSync(payloadFile, `${JSON.stringify(payload, null, 2)}\n`);

  const env: NodeJS.ProcessEnv = {
    ...(args.env ?? process.env),
    AIDLC_HOOK: hook,
    AIDLC_HOOK_EVENT: payload.event,
    AIDLC_PARENT_EPIC: payload.parent_epic,
    AIDLC_FOLLOWUPS_PAYLOAD: payloadFile,
    AIDLC_CHILD_EPICS: payload.children.map((c) => c.epic).join(','),
    ...(payload.child && {
      AIDLC_CHILD_EPIC: payload.child.epic,
      AIDLC_FOLLOW_UP_KEY: payload.child.follow_up_key ?? '',
    }),
  };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, reason?: string) => {
      if (settled) { return; }
      settled = true;
      if (timer) { clearTimeout(timer); }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      const err = reason ? `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}${reason}` : stderr;
      resolve({
        hook,
        event: payload.event,
        command,
        at,
        ok: exitCode === 0 && !reason,
        exitCode,
        stderr: tail(err),
        stdout: tail(stdout),
        durationMs: Date.now() - started,
        children: payload.children.map((c) => c.epic),
      });
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, { cwd: workspaceRoot, env, shell: true, windowsHide: true });
    } catch (e) {
      finish(null, `could not start: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.stdout?.on('data', (d: Buffer) => { stdout = tail(stdout + d.toString()); });
    proc.stderr?.on('data', (d: Buffer) => { stderr = tail(stderr + d.toString()); });
    proc.on('error', (e) => finish(null, `could not start: ${e.message}`));
    proc.on('close', (code) => {
      if (timedOut) { finish(null, `timed out after ${Math.round(timeoutMs / 1000)}s`); return; }
      finish(code);
    });
  });
}

// ── Ledger ────────────────────────────────────────────────────────────

/** A done hook that was not run because a sync already covered the child. */
export interface FollowUpDoneBySync {
  via: 'sync';
  at: string;
}

export type LedgerRun = Omit<FollowUpHookRun, 'stdout'> & {
  /** Set when a later successful sync covers this failure. */
  supersededAt?: string;
};

export interface FollowUpHookLedger {
  version: 1;
  /** Children the parent's hooks are responsible for — only these get `on_followup_done`. */
  children: Record<string, { key: string | null; recipe: string | null; at: string }>;
  /** Last `opened` or `sync` run. */
  opened?: LedgerRun;
  /** Per child: the `on_followup_done` run, or the sync that stood in for it. */
  done: Record<string, LedgerRun | FollowUpDoneBySync>;
}

function emptyLedger(): FollowUpHookLedger {
  return { version: 1, children: {}, done: {} };
}

export function followUpHookLedgerPath(workspaceRoot: string, doc: RawDoc, parentEpicId: string): string {
  return path.join(epicsRoot(workspaceRoot, doc), parentEpicId, FOLLOW_UP_HOOKS_LEDGER);
}

/** The parent's ledger — empty when it has none or it cannot be read. */
export function readFollowUpHookLedger(workspaceRoot: string, doc: RawDoc, parentEpicId: string): FollowUpHookLedger {
  const file = followUpHookLedgerPath(workspaceRoot, doc, parentEpicId);
  if (!fs.existsSync(file)) { return emptyLedger(); }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<FollowUpHookLedger>;
    return {
      version: 1,
      children: parsed.children && typeof parsed.children === 'object' ? parsed.children : {},
      ...(parsed.opened && { opened: parsed.opened }),
      done: parsed.done && typeof parsed.done === 'object' ? parsed.done : {},
    };
  } catch {
    return emptyLedger();
  }
}

export function writeFollowUpHookLedger(
  workspaceRoot: string,
  doc: RawDoc,
  parentEpicId: string,
  ledger: FollowUpHookLedger,
): void {
  const file = followUpHookLedgerPath(workspaceRoot, doc, parentEpicId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Make the ledger responsible for these children. Returns the same ledger. */
export function trackFollowUpChildren(ledger: FollowUpHookLedger, children: FollowUpHookChild[], at = new Date().toISOString()): FollowUpHookLedger {
  for (const c of children) {
    const prev = ledger.children[c.epic];
    ledger.children[c.epic] = {
      key: c.follow_up_key ?? prev?.key ?? null,
      recipe: c.recipe ?? prev?.recipe ?? null,
      at: prev?.at ?? at,
    };
  }
  return ledger;
}

function withoutStdout(run: FollowUpHookRun): LedgerRun {
  const { stdout: _stdout, ...rest } = run;
  return rest;
}

/**
 * Record a run. A successful sync hands every child the whole state, finished
 * ones included, so it stands in for their pending done hooks and clears the
 * failures it re-ran.
 */
export function applyFollowUpHookRun(
  ledger: FollowUpHookLedger,
  run: FollowUpHookRun,
  payload: FollowUpHookPayload,
): FollowUpHookLedger {
  trackFollowUpChildren(ledger, payload.children, run.at);
  if (run.event === 'done') {
    const child = payload.child?.epic;
    if (child) { ledger.done[child] = withoutStdout(run); }
    return ledger;
  }
  ledger.opened = withoutStdout(run);
  if (run.event === 'sync' && run.ok) {
    for (const c of payload.children) {
      const prev = ledger.done[c.epic];
      if (!prev && c.status === 'done') {
        ledger.done[c.epic] = { via: 'sync', at: run.at };
      } else if (prev && 'ok' in prev && !prev.ok && !prev.supersededAt) {
        prev.supersededAt = run.at;
      }
    }
  }
  return ledger;
}

/** Tracked children that are done and have no done hook on record. */
export function pendingFollowUpDone(ledger: FollowUpHookLedger, doneChildIds: Iterable<string>): string[] {
  return [...doneChildIds].filter((id) => ledger.children[id] && !ledger.done[id]);
}

/** Failed runs a person still has to look at, newest first. */
export function followUpHookFailures(ledger: FollowUpHookLedger): LedgerRun[] {
  const out: LedgerRun[] = [];
  if (ledger.opened && !ledger.opened.ok) { out.push(ledger.opened); }
  for (const entry of Object.values(ledger.done)) {
    if ('ok' in entry && !entry.ok && !entry.supersededAt) { out.push(entry); }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
