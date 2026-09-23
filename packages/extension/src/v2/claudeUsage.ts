/**
 * How much of the Claude plan this window's account has left.
 *
 * The token monitor next door answers "what has been spent" by summing the
 * local JSONL transcripts. That is consumption, and it is not the question a
 * user asks at 4pm — which is "can I still run this epic, or am I about to hit
 * the wall". Only the server knows that, because the limit is per plan window
 * and counts every machine signed into the account.
 *
 * Source: `GET /api/oauth/usage` on the Anthropic API — the same call Claude
 * Code's own `/usage` makes, authenticated with the OAuth access token that
 * lives in the config dir. It is NOT a documented, contracted endpoint, so
 * every failure here is a shrug, never an error dialog: the feature goes quiet
 * and the rest of the extension carries on. The shape below was read off a live
 * response, not off the CLI bundle — the bundle carries an older `unifiedWindows`
 * schema the server no longer sends, which is exactly the kind of drift the
 * defensive parsing here exists for.
 *
 * Reading credentials rather than the active session is what makes this fit
 * {@link ./claudeAccounts}: each account is a config dir with its own
 * `.credentials.json`, so the switch picker can show what is left on *every*
 * saved account and the user picks the one with room. On macOS the credentials
 * are in the login keychain instead of a file; `security` is the documented way
 * in, and a locked keychain simply yields nothing.
 *
 * Nothing here ever writes a credential, refreshes a token, or logs one. An
 * expired token is reported as "re-run claude" — repairing someone else's auth
 * file behind their back is how two processes end up fighting over it.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

import * as vscode from 'vscode';

import { claudeConfigDir } from '@aidlc/core';

export const SHOW_USAGE_CMD = 'aidlcNative.showClaudePlanUsage';
export const REFRESH_USAGE_CMD = 'aidlcNative.refreshClaudePlanUsage';

const ENABLED_KEY = 'aidlcNative.claude.planUsage.enabled';
const REFRESH_KEY = 'aidlcNative.claude.planUsage.refreshSeconds';
const STATUS_BAR_KEY = 'aidlcNative.claude.planUsage.statusBar';
const RESET_IN_KEY = 'aidlcNative.claude.planUsage.showResetIn';
const WARN_KEY = 'aidlcNative.claude.planUsage.warnBelowPercent';
const CRITICAL_KEY = 'aidlcNative.claude.planUsage.criticalBelowPercent';

/** All read fresh on every render, so changing a setting lands on the next tick. */
function statusBarStyle(): StatusBarStyle {
  return vscode.workspace.getConfiguration().get<string>(STATUS_BAR_KEY, 'windows') === 'tightest'
    ? 'tightest'
    : 'windows';
}

function showResetIn(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(RESET_IN_KEY, true);
}

/**
 * Amber and red, from settings. Clamped to 0–100 and kept in order: a critical
 * threshold above the warning one would mean red never fires, and a typo in a
 * settings file should not quietly disable the alarm.
 */
function thresholds(): AlertThresholds {
  const cfg = vscode.workspace.getConfiguration();
  const clamp = (n: number, fallback: number): number =>
    Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
  const warnBelow = clamp(cfg.get<number>(WARN_KEY, 20), 20);
  const criticalBelow = Math.min(warnBelow, clamp(cfg.get<number>(CRITICAL_KEY, 5), 5));
  return { warnBelow, criticalBelow };
}

const API_HOST = 'api.anthropic.com';
const API_PATH = '/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

// ── Shape ────────────────────────────────────────────────────────────────────

/**
 * Names for the windows seen in the wild. Anything unknown still shows — a new
 * plan window is worth reporting under its raw name, not dropping.
 */
const LABELS: Record<string, string> = {
  session: '5-hour session',
  five_hour: '5-hour session',
  weekly_all: 'Weekly (all models)',
  seven_day: 'Weekly (all models)',
  weekly_opus: 'Weekly (Opus)',
  seven_day_opus: 'Weekly (Opus)',
  weekly_sonnet: 'Weekly (Sonnet)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  weekly_fable: 'Weekly (Fable)',
  seven_day_fable: 'Weekly (Fable)',
  weekly_haiku: 'Weekly (Haiku)',
  seven_day_haiku: 'Weekly (Haiku)',
};

function labelFor(key: string): string {
  return LABELS[key] ?? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * The status bar has room for a couple of characters per window, not a label —
 * `5h 51% · wk 34%` has to fit next to everything else the user keeps down
 * there. Unknown keys get their first word, which is still better than a bare
 * number whose window nobody can name.
 */
const SHORT_LABELS: Record<string, string> = {
  session: '5h',
  five_hour: '5h',
  weekly_all: 'wk',
  seven_day: 'wk',
  weekly_opus: 'opus',
  seven_day_opus: 'opus',
  weekly_sonnet: 'sonnet',
  seven_day_sonnet: 'sonnet',
  weekly_fable: 'fable',
  seven_day_fable: 'fable',
  weekly_haiku: 'haiku',
  seven_day_haiku: 'haiku',
};

function shortLabelFor(key: string): string {
  return SHORT_LABELS[key] ?? key.split('_')[0];
}

/**
 * Which clock a window is on. The server says so in `limits[].group`; the named
 * windows do not, so the key answers for them. Everything else is its own
 * group, so a window we have never seen is never silently folded into one of
 * these two and hidden behind a tighter sibling.
 */
function groupFor(key: string, declared: unknown): string {
  if (typeof declared === 'string' && declared) { return declared; }
  if (key === 'session' || key === 'five_hour') { return 'session'; }
  if (key.startsWith('weekly') || key.startsWith('seven_day')) { return 'weekly'; }
  return key;
}

export interface UsageWindow {
  key: string;
  label: string;
  /** Two or three characters for the status bar — `5h`, `wk`, `opus`. */
  shortLabel: string;
  /** Which clock this window is on: `session`, `weekly`, or its own key. */
  group: string;
  /** 0–100 percent of the window consumed. */
  usedPct: number;
  remainingPct: number;
  /** Epoch ms when the window rolls over; 0 when the server did not say. */
  resetsAt: number;
  /** The server's own read on how alarming this is — `normal` unless it says otherwise. */
  severity: string;
  /** How fast it is going, once there is enough history to say. See {@link estimateBurn}. */
  burn?: BurnRate;
}

/** How fast a window is being spent, and where that lands. */
export interface BurnRate {
  /** Percentage points of the window consumed per hour. */
  pctPerHour: number;
  /** Epoch ms the window is projected to run out; absent when it resets first. */
  exhaustsAt?: number;
}

/** One reading of a window, kept so the next one can be compared against it. */
export interface UsageSample {
  at: number;
  usedPct: number;
}

export type UsageState =
  | { kind: 'ok'; windows: UsageWindow[]; tightest: UsageWindow; fetchedAt: number }
  /** Signed in, but no plan window reported — API-key auth, or a plan the endpoint stays silent about. */
  | { kind: 'no-plan' }
  | { kind: 'no-credentials' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

// ── Credentials ──────────────────────────────────────────────────────────────

interface OAuthCredentials {
  accessToken: string;
  /** Epoch ms, when known. */
  expiresAt?: number;
}

/**
 * Unlike `.claude.json`, the credentials file lives *inside* the config dir in
 * every layout, the default one included — so it follows the active account
 * with no special case.
 */
function credentialsPath(configDir: string): string {
  return path.join(configDir, '.credentials.json');
}

function parseCredentials(raw: string): OAuthCredentials | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) { return undefined; }
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/** The macOS login keychain, where Claude Code keeps credentials instead of a file. */
function readKeychainCredentials(): Promise<OAuthCredentials | undefined> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-a', os.userInfo().username, '-w', '-s', 'Claude Code-credentials'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
      (err, stdout) => resolve(err ? undefined : parseCredentials(String(stdout).trim())),
    );
  });
}

async function readCredentials(configDir: string): Promise<OAuthCredentials | undefined> {
  try {
    const raw = await fs.promises.readFile(credentialsPath(configDir), 'utf8');
    const parsed = parseCredentials(raw);
    if (parsed) { return parsed; }
  } catch {
    // Falls through: absent by design on macOS, and unreadable is the same
    // answer as absent for our purposes.
  }
  return process.platform === 'darwin' ? readKeychainCredentials() : undefined;
}

// ── The call ─────────────────────────────────────────────────────────────────

/**
 * The response carries the same facts twice: a self-describing `limits` array,
 * and a top-level object per named window. `limits` is preferred — it names its
 * own windows, so a plan with a window we have never heard of still renders —
 * with the named keys as the fallback for a response that omits it.
 */
interface RawLimit {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  severity?: unknown;
  resets_at?: unknown;
}
interface RawWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

/** `resets_at` is an ISO string today and was unix seconds before. Accept both. */
function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) { return value * 1000; }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) { return parsed; }
  }
  return 0;
}

function toWindow(
  key: string,
  percent: unknown,
  resetsAt: unknown,
  severity: unknown,
  group?: unknown,
): UsageWindow | undefined {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) { return undefined; }
  const usedPct = Math.min(100, Math.max(0, Math.round(percent)));
  return {
    key,
    label: labelFor(key),
    shortLabel: shortLabelFor(key),
    group: groupFor(key, group),
    usedPct,
    remainingPct: 100 - usedPct,
    resetsAt: toEpochMs(resetsAt),
    severity: typeof severity === 'string' ? severity : 'normal',
  };
}

const NAMED_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

export function parseUsageWindows(body: Record<string, unknown>): UsageWindow[] {
  const limits = Array.isArray(body.limits) ? (body.limits as RawLimit[]) : undefined;
  if (limits?.length) {
    const parsed = limits
      .map((l) => toWindow(
        typeof l.kind === 'string' ? l.kind : 'limit',
        l.percent,
        l.resets_at,
        l.severity,
        l.group,
      ))
      .filter((w): w is UsageWindow => w !== undefined);
    if (parsed.length) { return parsed; }
  }
  return NAMED_WINDOWS
    .map((key) => {
      const raw = body[key] as RawWindow | null | undefined;
      return raw ? toWindow(key, raw.utilization, raw.resets_at, undefined) : undefined;
    })
    .filter((w): w is UsageWindow => w !== undefined);
}

function get(token: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: API_HOST,
        path: API_PATH,
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          accept: 'application/json',
          'user-agent': 'aidlc-native',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchState(configDir: string, timeoutMs: number): Promise<UsageState> {
  const creds = await readCredentials(configDir);
  if (!creds) { return { kind: 'no-credentials' }; }
  // A minute of slack: a token that dies mid-flight reads as 401 anyway, and
  // this keeps us from spending a request on one already known to be done.
  if (creds.expiresAt !== undefined && creds.expiresAt <= Date.now() + 60_000) {
    return { kind: 'expired' };
  }

  let res: { status: number; body: string };
  try {
    res = await get(creds.accessToken, timeoutMs);
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  if (res.status === 401 || res.status === 403) { return { kind: 'expired' }; }
  if (res.status !== 200) { return { kind: 'error', message: `HTTP ${res.status}` }; }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return { kind: 'error', message: 'unreadable response' };
  }

  const windows = parseUsageWindows(parsed);
  if (!windows.length) { return { kind: 'no-plan' }; }

  // The tightest window is the honest headline: what stops the next run is
  // whichever limit is closest, not the one that happens to be listed first.
  const tightest = windows.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
  return { kind: 'ok', windows, tightest, fetchedAt: Date.now() };
}

// ── Burn rate ────────────────────────────────────────────────────────────────

/** Readings older than this say nothing about the pace of the last hour. */
const BURN_WINDOW_MS = 3 * 60 * 60_000;
/** Two readings a minute apart are noise; the poll is five minutes by default. */
const BURN_MIN_SPAN_MS = 10 * 60_000;
/** Below this the projection is further out than the window's own reset. */
const BURN_MIN_RATE = 0.5;
const BURN_MAX_SAMPLES = 64;

/**
 * How fast this window is going, from readings taken while it was running.
 *
 * The percentages are the only history there is — this extension polls a
 * server that reports a level, not a rate — so the pace is the slope between
 * the oldest reading still worth trusting and the newest. A drop means the
 * window rolled over, and readings from the previous window say nothing about
 * this one, so the slope is measured from the roll-over onwards.
 *
 * Deliberately refuses to answer rather than guess: too few readings, too
 * short a span, or a pace slow enough to be rounding all yield `undefined`.
 * "Out in about an hour" is worth reading; "out in about nine days, probably,
 * from two samples" is worth nothing and costs the rest its credibility.
 */
export function estimateBurn(
  samples: readonly UsageSample[],
  opts: { now?: number; resetsAt?: number } = {},
): BurnRate | undefined {
  const now = opts.now ?? Date.now();
  const latest = samples[samples.length - 1];
  if (!latest) { return undefined; }

  // Only the readings since the last roll-over, and only recent ones.
  let from = 0;
  for (let i = samples.length - 1; i > 0; i--) {
    if (samples[i].usedPct < samples[i - 1].usedPct || now - samples[i - 1].at > BURN_WINDOW_MS) {
      from = i;
      break;
    }
  }
  const first = samples[from];
  const spanMs = latest.at - first.at;
  if (spanMs < BURN_MIN_SPAN_MS) { return undefined; }

  const pctPerHour = ((latest.usedPct - first.usedPct) / spanMs) * 3600_000;
  if (pctPerHour < BURN_MIN_RATE) { return undefined; }

  const remaining = Math.max(0, 100 - latest.usedPct);
  const exhaustsAt = now + (remaining / pctPerHour) * 3600_000;
  return {
    pctPerHour: Math.round(pctPerHour * 10) / 10,
    // A window that resets before it runs out is not going to run out. Saying
    // so anyway is the kind of alarm that gets the whole tooltip ignored.
    exhaustsAt: opts.resetsAt && exhaustsAt >= opts.resetsAt ? undefined : exhaustsAt,
  };
}

/** Readings per config dir and window key. In memory only: a reload starts over. */
const history = new Map<string, UsageSample[]>();

/** Record this answer's levels and hang the resulting pace off each window. */
function annotateBurn(configDir: string, state: UsageState, now = Date.now()): void {
  if (state.kind !== 'ok') { return; }
  for (const w of state.windows) {
    const key = `${configDir}\u0000${w.key}`;
    const samples = history.get(key) ?? [];
    samples.push({ at: now, usedPct: w.usedPct });
    if (samples.length > BURN_MAX_SAMPLES) { samples.splice(0, samples.length - BURN_MAX_SAMPLES); }
    history.set(key, samples);
    w.burn = estimateBurn(samples, { now, resetsAt: w.resetsAt || undefined });
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface Entry {
  state: UsageState;
  at: number;
  pending?: Promise<UsageState>;
}

const cache = new Map<string, Entry>();

const changed = new vscode.EventEmitter<string>();
/** Fires with the config dir whenever a fresh answer lands, so borrowed views can repaint. */
export const onDidChangePlanUsage = changed.event;

function remember(key: string, state: UsageState): void {
  annotateBurn(key, state);
  cache.set(key, { state, at: Date.now() });
  changed.fire(key);
}

/**
 * The state for a config dir, served from cache unless older than `maxAgeMs`.
 * Concurrent callers (status bar tick, tooltip, switch picker) share one
 * in-flight request — this endpoint is not ours to hammer.
 */
export async function planUsage(
  configDir: string,
  opts: { maxAgeMs?: number; timeoutMs?: number } = {},
): Promise<UsageState> {
  const maxAge = opts.maxAgeMs ?? 5 * 60_000;
  const key = path.resolve(configDir);
  const entry = cache.get(key);
  if (entry?.pending) { return entry.pending; }
  if (entry && Date.now() - entry.at < maxAge) { return entry.state; }

  const pending = fetchState(key, opts.timeoutMs ?? 10_000)
    .catch((err: unknown): UsageState => ({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    }))
    .then((state) => {
      remember(key, state);
      return state;
    });

  // Keep the previous answer visible while the new one is in flight, so a
  // refresh never blanks the status bar.
  cache.set(key, {
    state: entry?.state ?? { kind: 'error', message: 'loading' },
    at: entry?.at ?? 0,
    pending,
  });
  return pending;
}

/** Whatever is already known, without going to the network. */
export function cachedPlanUsage(configDir: string): UsageState | undefined {
  const entry = cache.get(path.resolve(configDir));
  return entry && entry.at > 0 ? entry.state : undefined;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function fmtReset(at: number): string {
  if (!at) { return 'unknown'; }
  const ms = at - Date.now();
  if (ms <= 0) { return 'now'; }
  const mins = Math.round(ms / 60_000);
  if (mins < 60) { return `in ${mins}m`; }
  const hours = Math.floor(mins / 60);
  if (hours < 24) { return `in ${hours}h ${mins % 60}m`; }
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** How much the status bar item says. */
export type StatusBarStyle = 'windows' | 'tightest';

/** Groups get a slot in this order; anything else follows, in the server's order. */
const GROUP_ORDER = ['session', 'weekly'];

/** The all-models weekly window leads its group — the model-specific ones qualify it. */
const WEEKLY_ALL = new Set(['weekly_all', 'seven_day']);

/**
 * The windows that earn a slot on the status bar, in reading order.
 *
 * Every window gets its own number. Headlining only the single tightest one
 * answered a question nobody asked: on a plan that reports a weekly window per
 * model, the bar showed one percentage — whichever model the user happened to
 * lean on — and the 5-hour window, the one that bites first, was nowhere to be
 * seen. The order is the order they run out in: the session window, then the
 * all-models week, then the per-model weeks that qualify it, tightest first —
 * a plan with more model windows than fit loses the roomiest, not a random one.
 *
 * Capped at four, because the status bar is shared with everything else.
 */
export function statusBarWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  const rank = (w: UsageWindow): number => {
    const i = GROUP_ORDER.indexOf(w.group);
    const group = i >= 0 ? i : GROUP_ORDER.length;
    // Only breaks ties inside a group, so the server's order survives elsewhere.
    return group * 2 + (WEEKLY_ALL.has(w.key) ? 0 : 1);
  };
  return [...windows]
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank(a.w) - rank(b.w) || b.w.usedPct - a.w.usedPct || a.i - b.i)
    .map(({ w }) => w)
    .slice(0, 4);
}

/**
 * The status bar text: `5h 51% · wk 34%`, percentages *left*, same as the
 * tooltip. `tightest` keeps the older one-number form for anyone who wants the
 * bar back the way it was.
 */
export function usageStatusText(
  state: UsageState | undefined,
  opts: { style?: StatusBarStyle; resetIn?: boolean } = {},
): string | undefined {
  if (state?.kind !== 'ok') { return undefined; }
  if (opts.style === 'tightest') { return `${state.tightest.remainingPct}% left`; }
  const picked = statusBarWindows(state.windows);
  if (!picked.length) { return `${state.tightest.remainingPct}% left`; }
  return picked
    .map((w) => {
      // Only the session window gets a countdown. It is the one people plan
      // the next hour around, and it is the only one short enough for the
      // answer to change anything — a weekly window resetting "in 3d 3h" is
      // three characters of bar spent on a fact nobody acts on.
      const countdown = opts.resetIn && w.group === 'session' ? fmtCountdown(w.resetsAt) : '';
      return `${w.shortLabel} ${w.remainingPct}%${countdown ? ` ${countdown}` : ''}`;
    })
    .join(' · ');
}

/** Where amber and red begin, as percentages *left*. Both settings, both here. */
export interface AlertThresholds {
  warnBelow: number;
  criticalBelow: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = { warnBelow: 20, criticalBelow: 5 };

/** How loudly the status bar should say it, and which window is saying it. */
export interface UsageAlert {
  level: 'critical' | 'warning' | 'none';
  /** The window the level came from — `undefined` only when the level is `none`. */
  window?: UsageWindow;
}

/** A window whose exhaustion stops *all* work, not just one model's. */
function blocksEverything(w: UsageWindow): boolean {
  return w.group === 'session' || WEEKLY_ALL.has(w.key);
}

/**
 * What the status bar's background colour should be, and why.
 *
 * Red has to keep meaning "you are about to be refused". Only the 5-hour and
 * all-models weekly windows can say that: they gate every model, so running
 * one down stops the work outright. A per-model weekly window running down is
 * a different, smaller event — the fix is to run the next step on another
 * model, not to stop — so it is worth amber and never worth red. Colouring by
 * the tightest window of all made a nearly-spent Fable week look exactly like
 * a spent account, which is how you teach someone to ignore the colour.
 *
 * The server's own `severity` wins where it has an opinion: it knows about
 * overage and locks, which no percentage here can tell us about.
 */
export function usageAlert(
  state: UsageState | undefined,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): UsageAlert {
  if (state?.kind !== 'ok' || !state.windows.length) { return { level: 'none' }; }
  const { warnBelow, criticalBelow } = thresholds;

  const severe = (w: UsageWindow): boolean => w.severity === 'critical';
  const flagged = (w: UsageWindow): boolean => w.severity !== 'normal' && w.severity !== 'none';

  const gating = state.windows.filter(blocksEverything);
  // A plan that reports only per-model windows still deserves a warning, so
  // fall back to all of them rather than going silent.
  const primary = (gating.length ? gating : state.windows)
    .reduce((a, b) => (b.usedPct > a.usedPct ? b : a));

  if (severe(primary) || primary.remainingPct <= criticalBelow) {
    return { level: 'critical', window: primary };
  }
  if (flagged(primary) || primary.remainingPct <= warnBelow) {
    return { level: 'warning', window: primary };
  }

  // Nothing gating is close, but a model window may be: amber, capped there.
  const model = state.windows
    .filter((w) => !blocksEverything(w) && (severe(w) || flagged(w) || w.remainingPct <= warnBelow))
    .reduce<UsageWindow | undefined>((a, b) => (!a || b.usedPct > a.usedPct ? b : a), undefined);
  return model ? { level: 'warning', window: model } : { level: 'none' };
}

/** The same span as {@link fmtReset}, in as few characters as the bar can spare. */
function fmtCountdown(at: number): string {
  if (!at) { return ''; }
  const mins = Math.round((at - Date.now()) / 60_000);
  if (mins <= 0) { return 'now'; }
  if (mins < 60) { return `${mins}m`; }
  const hours = Math.floor(mins / 60);
  if (hours < 24) { return `${hours}h${String(mins % 60).padStart(2, '0')}m`; }
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** One line for a status bar or a QuickPick row. `undefined` = say nothing. */
export function usageSummary(state: UsageState | undefined): string | undefined {
  switch (state?.kind) {
    case 'ok': return `${state.tightest.remainingPct}% left`;
    case 'expired': return 'sign-in expired';
    case 'no-credentials': return 'not signed in';
    default: return undefined;
  }
}

/**
 * The pace, as a tooltip suffix. Empty when there is no reading worth showing —
 * this is an estimate off a handful of samples, and it has to read like one.
 */
function fmtBurn(burn: BurnRate | undefined): string {
  if (!burn) { return ''; }
  const rate = `${burn.pctPerHour}%/hr`;
  if (burn.exhaustsAt === undefined) { return ` — ${rate}, resets before it runs out`; }
  // A clock time alone reads as "today"; a weekly window projected three days
  // out would then look like it goes this morning.
  const when = new Date(burn.exhaustsAt);
  const sameDay = when.toDateString() === new Date().toDateString();
  const at = when.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit',
  });
  return ` — ${rate}, out ~${at}`;
}

/** Markdown bullets for a tooltip. Empty when there is nothing worth saying. */
export function usageMarkdown(state: UsageState | undefined): string[] {
  switch (state?.kind) {
    case 'ok':
      return [
        ...state.windows.map(
          (w) => `- ${w.label}: **${w.remainingPct}% left** (${w.usedPct}% used, resets ${fmtReset(w.resetsAt)})`
            + fmtBurn(w.burn),
        ),
        '',
        '_Plan limits read from the Claude account — undocumented endpoint, may go quiet._',
      ];
    case 'expired':
      return ['- Plan limits: _sign-in expired — run `claude` once to refresh it_'];
    case 'no-credentials':
      return ['- Plan limits: _no Claude login in this config dir_'];
    case 'no-plan':
      return ['- Plan limits: _none reported (API-key auth has no plan window)_'];
    case 'error':
      return [`- Plan limits: _unavailable (${state.message})_`];
    default:
      return [];
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * The status bar item, its commands, and the polling.
 *
 * It sits just left of the account item, and hides itself whenever there is
 * nothing trustworthy to say — an account with no login, an API key, a dead
 * endpoint. A percentage that is quietly wrong is worse than no percentage.
 */
export function registerClaudePlanUsage(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): void {
  if (!vscode.workspace.getConfiguration().get<boolean>(ENABLED_KEY, true)) {
    output.appendLine(`Claude plan usage disabled by setting (${ENABLED_KEY}).`);
    return;
  }

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  item.command = SHOW_USAGE_CMD;
  context.subscriptions.push(item);

  const render = (state: UsageState): void => {
    if (state.kind === 'ok') {
      item.text = `$(pulse) ${usageStatusText(state, { style: statusBarStyle(), resetIn: showResetIn() })}`;
      // Red at the wall, amber in the last fifth — the point is to be noticed
      // before a run is refused, not after. Which window gets to say it is
      // {@link usageAlert}'s call.
      const alert = usageAlert(state, thresholds());
      item.backgroundColor =
        alert.level === 'critical'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : alert.level === 'warning'
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
      item.tooltip = new vscode.MarkdownString(
        [
          '**Claude plan usage left**',
          '',
          ...usageMarkdown(state),
          ...(alert.window
            ? ['', `_${alert.window.label} is what the colour is about._`]
            : []),
          '',
          'Click to refresh.',
        ].join('\n'),
      );
      item.show();
      return;
    }
    if (state.kind === 'expired') {
      item.text = '$(pulse) sign-in expired';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.tooltip = new vscode.MarkdownString(
        `Claude plan usage: the OAuth token in \`${claudeConfigDir()}\` has expired. Run \`claude\` once to refresh it.`,
      );
      item.show();
      return;
    }
    item.hide();
  };

  const refresh = async (force = false): Promise<UsageState> => {
    const state = await planUsage(claudeConfigDir(), force ? { maxAgeMs: 0 } : {});
    if (state.kind === 'error') {
      output.appendLine(`Claude plan usage unavailable: ${state.message}`);
    }
    render(state);
    return state;
  };

  void refresh();

  const intervalSec = Math.max(
    60,
    vscode.workspace.getConfiguration().get<number>(REFRESH_KEY, 300),
  );
  const timer = setInterval(() => { void refresh(); }, intervalSec * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_USAGE_CMD, () => refresh(true)),
    vscode.commands.registerCommand(SHOW_USAGE_CMD, async () => {
      const state = await refresh(true);
      if (state.kind === 'ok') {
        await vscode.window.showQuickPick(
          state.windows.map((w) => ({
            label: `${w.remainingPct}% left — ${w.label}`,
            detail: `${w.usedPct}% used · resets ${fmtReset(w.resetsAt)}`,
          })),
          { title: `Claude plan usage · ${claudeConfigDir()}`, placeHolder: 'Press Escape to close' },
        );
        return;
      }
      void vscode.window.showInformationMessage(
        `Claude plan usage: ${usageMarkdown(state).join(' ').replace(/^- Plan limits: /, '').replace(/[*_`]/g, '').trim() || 'unavailable'}`,
      );
    }),
  );

  output.appendLine(`Claude plan usage enabled (refresh every ${intervalSec}s).`);
}
