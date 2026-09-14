/**
 * Follow-up hooks in the extension: when to run them, and what a person sees.
 *
 *   - `on_followups_opened` — once, after Open follow-up epics creates a batch,
 *     and again by hand from the parent card's Sync follow-ups.
 *   - `on_followup_done` — when a child opened under a hook reaches done,
 *     however it got there (panel, CLI, autopilot): run files and state.json are
 *     watched, and the parent's ledger keeps it to once per child.
 *
 * Running, placeholders and the ledger live in `@aidlc/core`; this file adds
 * the progress UI, the output channel, and the error a person can act on.
 */

import * as vscode from 'vscode';

import {
  WORKSPACE_DIR,
  collectFollowUpHookIssues,
  resolveFollowUpHooks,
  runFollowUpHook,
  readFollowUpHookLedger,
  writeFollowUpHookLedger,
  trackFollowUpChildren,
  applyFollowUpHookRun,
  pendingFollowUpDone,
  followUpsOf,
  parseFollowUps,
  readEpicFollowUps,
  type FollowUpHookChild,
  type FollowUpHookKey,
  type FollowUpHookPayload,
  type FollowUpHookRun,
} from '@aidlc/core';

import { readYaml, type YamlDocument } from './yamlIO';
import { listEpics } from './epicsList';

const recorded = new vscode.EventEmitter<string>();
/** Fires with the parent epic id whenever its ledger changes. */
export const onDidRecordFollowUpHook = recorded.event;

let channel: vscode.OutputChannel | undefined;
function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('AIDLC · Follow-up hooks');
  return channel;
}

/**
 * One queue per parent. The ledger is a single file, and a sync that overlaps a
 * done hook would otherwise write over its result.
 */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(parentEpicId: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(parentEpicId) ?? Promise.resolve()).then(fn, fn);
  queues.set(parentEpicId, next.catch(() => undefined));
  return next;
}

/** Hook problems in workspace.yaml as one message, or null when it is clean. */
function hookIssues(doc: YamlDocument | null): string | null {
  const issues = collectFollowUpHookIssues(doc);
  if (issues.length === 0) { return null; }
  return `workspace.yaml has invalid follow-up hooks:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`;
}

function notRun(hook: FollowUpHookKey, command: string, payload: FollowUpHookPayload, reason: string): FollowUpHookRun {
  return {
    hook,
    event: payload.event,
    command: command || '(not run)',
    at: new Date().toISOString(),
    ok: false,
    exitCode: null,
    stderr: reason,
    stdout: '',
    durationMs: 0,
    children: payload.children.map((c) => c.epic),
  };
}

/** Run (or refuse to run) one hook, record it on the parent, and report a failure. */
async function execute(
  root: string,
  hook: FollowUpHookKey,
  command: string,
  payload: FollowUpHookPayload,
  refusal: string | null,
  location: vscode.ProgressLocation,
): Promise<FollowUpHookRun> {
  const parent = payload.parent_epic;
  const subject = payload.child ? `${parent} → ${payload.child.epic}` : parent;
  const run = refusal
    ? notRun(hook, command, payload, refusal)
    : await vscode.window.withProgress(
        { location, title: `AIDLC: ${hook} · ${subject}` },
        () => runFollowUpHook({ workspaceRoot: root, hook, command, payload }),
      );

  const doc = readYaml(root);
  writeFollowUpHookLedger(root, doc, parent, applyFollowUpHookRun(readFollowUpHookLedger(root, doc, parent), run, payload));
  recorded.fire(parent);

  const out = output();
  out.appendLine(`[${run.at}] ${hook} (${payload.event}) ${subject} — ${run.ok ? `ok in ${run.durationMs}ms` : `failed, exit ${run.exitCode ?? '—'}`}`);
  out.appendLine(`  $ ${run.command}`);
  if (run.stdout.trim()) { out.appendLine(run.stdout.trimEnd()); }
  if (run.stderr.trim()) { out.appendLine(run.stderr.trimEnd()); }

  if (!run.ok) {
    const firstLine = run.stderr.trim().split(/\r?\n/).pop() ?? '';
    void vscode.window
      .showErrorMessage(
        `AIDLC: ${hook} failed for ${subject}${firstLine ? ` — ${firstLine}` : ''}. ` +
          `Epics already opened are kept; the error is on ${parent}'s card. Fix it, then Sync follow-ups.`,
        'Sync follow-ups',
        'Show output',
      )
      .then((choice) => {
        if (choice === 'Sync follow-ups') { void syncFollowUps(root, parent); }
        if (choice === 'Show output') { out.show(true); }
      });
  }
  return run;
}

/**
 * `on_followups_opened` for a batch of children — just opened (`opened`) or
 * everything the parent has (`sync`).
 *
 * Children are tracked even when only `on_followup_done` is declared: that is
 * what lets the done hook fire for them later.
 */
export function runFollowUpsOpened(
  root: string,
  parentEpicId: string,
  children: FollowUpHookChild[],
  event: 'opened' | 'sync',
): Promise<void> {
  return serial(parentEpicId, async () => {
    const doc = readYaml(root);
    const hooks = resolveFollowUpHooks(root, doc, parentEpicId);
    const refusal = hookIssues(doc);

    if (!hooks && !refusal) {
      if (event === 'sync') {
        void vscode.window.showInformationMessage(
          `AIDLC: ${parentEpicId}'s pipeline declares no follow-up hook. Add \`on_followups_opened\` to the step that produces followups.json in .aidlc/workspace.yaml.`,
        );
      }
      return;
    }

    if (hooks && !hooks.on_followups_opened && !refusal) {
      writeFollowUpHookLedger(root, doc, parentEpicId, trackFollowUpChildren(readFollowUpHookLedger(root, doc, parentEpicId), children));
      recorded.fire(parentEpicId);
      if (event === 'sync') {
        void vscode.window.showInformationMessage(
          `AIDLC: no \`on_followups_opened\` on "${hooks.stepName}"; ${children.length} follow-up(s) of ${parentEpicId} are tracked for \`on_followup_done\`.`,
        );
      }
      return;
    }

    const run = await execute(
      root,
      'on_followups_opened',
      hooks?.on_followups_opened ?? '',
      { event, parent_epic: parentEpicId, children },
      refusal,
      vscode.ProgressLocation.Notification,
    );
    if (run.ok && event === 'sync') {
      void vscode.window.showInformationMessage(`AIDLC: synced ${children.length} follow-up(s) of ${parentEpicId}.`);
    }
  });
}

/**
 * Every child the parent has right now — found by `from_epic`, the same edge
 * the epic list draws — with its key, recipe and status.
 */
function currentChildren(root: string, doc: YamlDocument | null, parentEpicId: string, defaultRecipe?: string): FollowUpHookChild[] {
  const ledger = readFollowUpHookLedger(root, doc, parentEpicId);
  const manifestRecipes = new Map<string, string | undefined>();
  const raw = readEpicFollowUps(root, doc, parentEpicId);
  if (raw) {
    try {
      for (const item of parseFollowUps(raw).items) { manifestRecipes.set(item.key.toUpperCase(), item.recipe); }
    } catch { /* a broken manifest leaves recipes unknown — the sync still runs */ }
  }
  const statuses = new Map(listEpics(root, doc).map((e) => [e.id, e.status] as const));
  return followUpsOf(root, doc, parentEpicId).map((f) => {
    const fromManifest = f.key && manifestRecipes.has(f.key.toUpperCase())
      ? manifestRecipes.get(f.key.toUpperCase()) ?? defaultRecipe
      : undefined;
    return {
      follow_up_key: f.key ?? null,
      epic: f.epicId,
      recipe: ledger.children[f.epicId]?.recipe ?? fromManifest ?? null,
      ...(statuses.has(f.epicId) && { status: statuses.get(f.epicId) }),
    };
  });
}

/** Sync follow-ups: re-run `on_followups_opened` over every child the parent has. */
export async function syncFollowUps(root: string, parentEpicId: string, defaultRecipe?: string): Promise<void> {
  const children = currentChildren(root, readYaml(root), parentEpicId, defaultRecipe);
  if (children.length === 0) {
    void vscode.window.showInformationMessage(`AIDLC: ${parentEpicId} has no follow-up epics to sync.`);
    return;
  }
  await runFollowUpsOpened(root, parentEpicId, children, 'sync');
}

/** Last hook-issue message shown by the done watcher — shown once per distinct problem. */
let lastRefusal = '';

async function runPendingDoneHooks(root: string): Promise<void> {
  let doc: YamlDocument | null;
  try { doc = readYaml(root); } catch { return; }

  const doneByParent = new Map<string, Map<string, string | null>>();
  for (const e of listEpics(root, doc)) {
    const parent = String(e.inputs?.from_epic ?? '').trim();
    if (!parent || e.status !== 'done') { continue; }
    const key = String(e.inputs?.follow_up_key ?? '').trim() || null;
    if (!doneByParent.has(parent)) { doneByParent.set(parent, new Map()); }
    doneByParent.get(parent)!.set(e.id, key);
  }

  for (const [parent, done] of doneByParent) {
    const pending = pendingFollowUpDone(readFollowUpHookLedger(root, doc, parent), done.keys());
    if (pending.length === 0) { continue; }
    const command = resolveFollowUpHooks(root, doc, parent)?.on_followup_done;
    if (!command) { continue; }

    // Not recorded: once workspace.yaml is fixed, the hook should just run.
    const refusal = hookIssues(doc);
    if (refusal) {
      if (refusal !== lastRefusal) {
        lastRefusal = refusal;
        void vscode.window.showErrorMessage(`AIDLC: on_followup_done not run for ${pending.join(', ')} — ${refusal}`);
      }
      continue;
    }

    for (const childId of pending) {
      void serial(parent, async () => {
        // Another scan may have queued the same child and already run it.
        const ledger = readFollowUpHookLedger(root, readYaml(root), parent);
        if (ledger.done[childId]) { return; }
        const child: FollowUpHookChild = {
          follow_up_key: ledger.children[childId]?.key ?? done.get(childId) ?? null,
          epic: childId,
          recipe: ledger.children[childId]?.recipe ?? null,
          status: 'done',
        };
        await execute(
          root,
          'on_followup_done',
          command,
          { event: 'done', parent_epic: parent, children: [child], child },
          null,
          vscode.ProgressLocation.Window,
        );
      });
    }
  }
}

/**
 * Watch for follow-up epics reaching done. Also scans once at activation, so a
 * child finished while the window was closed still gets its hook.
 */
export function registerFollowUpDoneHooks(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return; }
  const root = folder.uri.fsPath;

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) { clearTimeout(timer); }
    // A transition rewrites the run file and state.json back to back.
    timer = setTimeout(() => { void runPendingDoneHooks(root); }, 1500);
  };

  for (const glob of ['**/state.json', `${WORKSPACE_DIR}/runs/*.json`]) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob));
    watcher.onDidChange(schedule, null, context.subscriptions);
    watcher.onDidCreate(schedule, null, context.subscriptions);
    context.subscriptions.push(watcher);
  }
  context.subscriptions.push(recorded, { dispose: () => { if (timer) { clearTimeout(timer); } channel?.dispose(); } });
  schedule();
}
