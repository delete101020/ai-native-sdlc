/**
 * Efficiency suggestion engine for the Claude Code Usage Report.
 *
 * Three families of rules:
 *   - cost: model choice and prompt-cache health. Started as a port of
 *     `analyze_suggestions` from https://github.com/novapizza/claude-token-monitor;
 *     its four Opus rules and three cache rules are merged into one each.
 *   - workflow: how the agent is driven — loops, mega sessions, repeated
 *     prompts, bloated CLAUDE.md. Adapted from the anti-pattern rules of
 *     https://github.com/microsoft/AI-Engineering-Coach (src/core/rules/*.md),
 *     with thresholds raised where Claude Code runs longer agentic turns than
 *     Copilot does.
 *   - epic: AIDLC-only — per-phase cost, rework and verification across epics.
 *
 * Each suggestion says why it matters and what to change. `estSavings` is an
 * API-equivalent heuristic for ranking, never a bill.
 */
import * as fs from 'fs';
import * as path from 'path';

import { claudeConfigDir } from '@aidlc/core';

import {
  enrichEpicsWithUsage,
  listEpicsCached,
  type EpicSummary,
} from './epicsList';
import { calcCost, modelPrice } from './tokenPricing';
import {
  type CallRecord,
  decodeProject,
  shortenPath,
} from './tokenRecords';
import { readYamlShared } from './yamlIO';

export type Severity = 'high' | 'med' | 'low';

export interface Suggestion {
  rule: string;
  severity: Severity;
  scope: string;
  evidence: string;
  /** Why this pattern hurts — the rule's rationale, shown in the detail view. */
  why: string;
  /** What to change. */
  action: string;
  /** USD; 0 when the rule doesn't quantify a saving. */
  estSavings: number;
}

const SONNET = 'claude-sonnet-5';

// ast-graph language coverage (https://github.com/emtyty/ast-graph).
const ASTGRAPH_EXTS = new Set([
  '.rs', '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.cs', '.java',
]);

const EXPLORE_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LSP',
  'NotebookRead', 'Agent', 'Task',
]);
const MUTATE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** Models priced well above Sonnet: worth questioning for routine work. */
function isPremium(model: string): boolean {
  const m = (model || '').toLowerCase();
  return m.includes('opus') || m.includes('fable') || m.includes('mythos');
}

function projectLangSupported(records: CallRecord[]): boolean {
  const paths: string[] = [];
  for (const r of records) { paths.push(...r.readPaths); }
  if (paths.length === 0) { return false; }
  let supported = 0;
  for (const p of paths) {
    const dot = p.lastIndexOf('.');
    if (dot < 0) { continue; }
    if (ASTGRAPH_EXTS.has(p.slice(dot).toLowerCase())) { supported++; }
  }
  return supported / paths.length >= 0.5;
}

function shortScopeProject(project: string): string {
  return `project ${shortenPath(decodeProject(project))}`;
}

function sessionScope(sess: string, recs: CallRecord[]): string {
  const projects = new Set(recs.map((r) => decodeProject(r.project)));
  const proj = projects.size === 1 ? shortenPath([...projects][0]) : 'multiple';
  return `session ${sess.slice(0, 8)} (${proj})`;
}

function fmtCost(c: number): string {
  if (c >= 1) { return `$${c.toFixed(2)}`; }
  if (c === 0) { return '$0'; }
  return `$${c.toFixed(4)}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) { return `${(n / 1_000_000_000).toFixed(2)}B`; }
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(2)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
  return String(Math.trunc(n));
}

function groupBy<T, K>(items: T[], key: (x: T) => K | null): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    if (k === null) { continue; }
    const arr = out.get(k);
    if (arr) { arr.push(it); } else { out.set(k, [it]); }
  }
  return out;
}

function rankSeverity(savings: number, hi: number, med: number): Severity {
  if (savings >= hi) { return 'high'; }
  if (savings >= med) { return 'med'; }
  return 'low';
}

function sum<T>(items: T[], f: (x: T) => number): number {
  return items.reduce((s, x) => s + f(x), 0);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function localDay(ts: string): string | null {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) { return null; }
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ═══ Cost rules ════════════════════════════════════════════════════════════

/**
 * Premium model (Opus / Fable) on a session that looks routine: small
 * outputs, mostly exploration, or plan mode. Replaces the four upstream
 * Opus rules, which flagged the same sessions four ways.
 */
function rulePremiumRoutine(records: CallRecord[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const [sess, recs] of groupBy(records, (r) => r.sessionId || null)) {
    if (recs.length < 10) { continue; }
    const premium = recs.filter((r) => isPremium(r.model));
    if (premium.length / recs.length < 0.7) { continue; }
    const cost = sum(recs, (r) => r.cost);
    if (cost < 5) { continue; }

    const reasons: string[] = [];
    const avgOut = sum(premium, (r) => r.usage.output_tokens) / premium.length;
    if (avgOut < 500) { reasons.push(`avg output ${Math.trunc(avgOut)} tok`); }
    const tools = recs.flatMap((r) => r.tools);
    const explore = tools.filter((t) => EXPLORE_TOOLS.has(t)).length;
    const mutate = tools.filter((t) => MUTATE_TOOLS.has(t)).length;
    if (explore + mutate > 0 && explore / (explore + mutate) >= 0.85) {
      reasons.push(`${Math.floor(explore * 100 / (explore + mutate))}% exploration tools`);
    }
    if (tools.includes('ExitPlanMode')) { reasons.push('plan mode'); }
    if (reasons.length === 0) { continue; }

    const savings = sum(premium, (r) => Math.max(0, r.cost - calcCost(r.usage, SONNET)));
    let action =
      'Run exploration, planning and small edits on Sonnet; switch to the premium ' +
      'model only for the turns that need deep reasoning or synthesis.';
    if (projectLangSupported(recs)) {
      action += ' Answer structural questions with ast-graph instead of Read/Grep sweeps.';
    }
    out.push({
      rule: 'premium-model-routine',
      severity: rankSeverity(savings, 30, 5),
      scope: sessionScope(sess, recs),
      evidence: `${recs.length} calls · ${premium.length} premium · ${reasons.join(' · ')} · ${fmtCost(cost)}`,
      why:
        'Premium models cost 2–5× Sonnet per token and burn subscription quota ' +
        'faster. Short answers and read-only exploration rarely need them.',
      action,
      estSavings: savings,
    });
  }
  return out;
}

/**
 * Prompt cache not paying off in a project: low hit rate, days split into
 * many tiny sessions, or sessions rewriting more cache than they read.
 * Replaces the upstream low-cache-hit, session-fragmentation and
 * cache-rebuild rules, which all described one problem.
 */
function ruleCacheChurn(records: CallRecord[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const [project, recs] of groupBy(records, (r) => r.project)) {
    const cost = sum(recs, (r) => r.cost);
    if (cost < 5) { continue; }
    const inp = sum(recs, (r) => r.usage.input_tokens);
    const cr = sum(recs, (r) => r.usage.cache_read_input_tokens);
    const cw = sum(recs, (r) => r.usage.cache_creation_input_tokens);
    const denom = inp + cr + cw;
    if (denom === 0) { continue; }
    const hit = cr / denom;

    // Days with 4+ sessions, 3+ of them under 5 calls.
    let fragDays = 0;
    for (const dayRecs of groupBy(recs, (r) => localDay(r.timestamp)).values()) {
      const calls = [...groupBy(dayRecs, (r) => r.sessionId || null).values()].map((s) => s.length);
      if (calls.length >= 4 && calls.filter((n) => n < 5).length >= 3) { fragDays++; }
    }
    // Sessions writing ≥ 0.2× what they read back (healthy is < 0.1).
    let thrash = 0;
    for (const s of groupBy(recs, (r) => r.sessionId || null).values()) {
      if (s.length < 10) { continue; }
      const sr = sum(s, (r) => r.usage.cache_read_input_tokens);
      const sw = sum(s, (r) => r.usage.cache_creation_input_tokens);
      if (sr > 0 && sw / sr >= 0.2) { thrash++; }
    }
    if (hit >= 0.4 && fragDays === 0 && thrash === 0) { continue; }

    const parts = [`cache hit ${Math.round(hit * 100)}%`];
    if (fragDays > 0) { parts.push(`${fragDays} fragmented day(s)`); }
    if (thrash > 0) { parts.push(`${thrash} session(s) rebuilding cache`); }
    const cwCost = sum(recs, (r) => r.usage.cache_creation_input_tokens * modelPrice(r.model).cw_5m / 1_000_000);
    // ponytail: flat half of the cache-write bill; per-cause estimates if the ranking ever matters.
    const savings = cwCost * 0.5;
    out.push({
      rule: 'cache-churn',
      severity: savings >= 5 ? 'med' : 'low',
      scope: shortScopeProject(project),
      evidence: `${parts.join(' · ')} · cache-write ${fmtCost(cwCost)}`,
      why:
        'Every new session, `/clear` or changed system prompt rebuilds the prompt ' +
        'cache at 1.25–2× input price; reads from a warm cache cost 0.1× or less.',
      action:
        'Keep one session per task instead of many short ones, and avoid editing ' +
        'CLAUDE.md, MCP servers or settings mid-session.',
      estSavings: savings,
    });
  }
  return out;
}

/** Session Read-spraying a codebase ast-graph could answer structurally. */
function ruleManyReads(records: CallRecord[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const [sess, recs] of groupBy(records, (r) => r.sessionId || null)) {
    const cost = sum(recs, (r) => r.cost);
    if (cost < 5) { continue; }
    const allTools = recs.flatMap((r) => r.tools);
    if (allTools.length === 0) { continue; }
    const reads = allTools.filter((t) => t === 'Read').length;
    if (reads < 30 || reads / allTools.length < 0.4) { continue; }
    if (!projectLangSupported(recs)) { continue; }
    const inputCost = sum(recs, (r) =>
      (r.usage.input_tokens + r.usage.cache_read_input_tokens) * modelPrice(r.model).cr / 1_000_000);
    const savings = inputCost * 0.4;
    out.push({
      rule: 'many-reads',
      severity: savings >= 3 ? 'med' : 'low',
      scope: sessionScope(sess, recs),
      evidence:
        `${reads} Read calls (${Math.floor(reads * 100 / allTools.length)}% of tool use) · ${fmtCost(cost)}`,
      why: 'Whole-file Reads stay in context for the rest of the session and are re-billed on every turn.',
      action:
        'Use ast-graph (`symbol` / `blast-radius` / `search`) for structural ' +
        'lookups — one query replaces many whole-file Reads.',
      estSavings: savings,
    });
  }
  return out;
}

// ═══ Workflow rules (after microsoft/AI-Engineering-Coach) ══════════════════

function turnKey(r: CallRecord): string {
  return `${r.account}\0${r.sessionId}\0${r.turn}`;
}

/**
 * Coach `runaway-agent-loops`: one prompt that set off a long tool chain and
 * produced nothing. Coach counts 15+ tools; a Claude Code turn — an AIDLC
 * phase run especially — legitimately runs 100+ while it edits, so only
 * chains of 40+ with no edit at all count here.
 */
function ruleRunawayTurns(records: CallRecord[]): Suggestion[] {
  const MIN_TOOLS = 40;
  const out: Suggestion[] = [];
  for (const [project, recs] of groupBy(records, (r) => r.project)) {
    const turns = [...groupBy(recs.filter((r) => r.turn > 0), turnKey).values()]
      .map((t) => ({ tools: t.flatMap((r) => r.tools), tokens: sum(t, (r) => r.usage.output_tokens + r.usage.input_tokens + r.usage.cache_read_input_tokens), prompt: t.find((r) => r.prompt)?.prompt }))
      .filter((t) => t.tools.length >= MIN_TOOLS && !t.tools.some((x) => MUTATE_TOOLS.has(x)));
    if (turns.length < 2) { continue; }
    const longest = turns.reduce((a, b) => (b.tools.length > a.tools.length ? b : a));
    out.push({
      rule: 'runaway-agent-turns',
      severity: turns.length >= 5 ? 'high' : 'med',
      scope: shortScopeProject(project),
      evidence:
        `${turns.length} prompts ran ${MIN_TOOLS}+ tool calls without a single edit (max ${longest.tools.length}` +
        `${longest.prompt ? `: "${longest.prompt.slice(0, 50)}…"` : ''}) · ` +
        `${fmtNum(sum(turns, (t) => t.tokens))} tok`,
      why:
        'A turn that keeps calling tools is usually retrying a failing approach or ' +
        'searching without a target; each call re-sends the whole growing context.',
      action:
        'Interrupt long chains early (Esc) and restate the goal with the constraint ' +
        'it is missing — the file, the failing test, what was already ruled out. ' +
        'Split broad prompts into smaller steps.',
      estSavings: 0,
    });
  }
  return out;
}

/** Coach `mega-sessions`: sessions with 50+ human prompts. */
function ruleMegaSessions(records: CallRecord[]): Suggestion[] {
  const MAX_TURNS = 50;
  const out: Suggestion[] = [];
  for (const [project, recs] of groupBy(records, (r) => r.project)) {
    const mega = [...groupBy(recs, (r) => `${r.account}\0${r.sessionId}`).values()]
      .map((s) => ({ turns: Math.max(...s.map((r) => r.turn)), compactions: s.filter((r) => r.afterCompact).length }))
      .filter((s) => s.turns >= MAX_TURNS);
    if (mega.length === 0) { continue; }
    const compactions = sum(mega, (s) => s.compactions);
    out.push({
      rule: 'mega-session',
      severity: mega.length >= 3 ? 'high' : 'med',
      scope: shortScopeProject(project),
      evidence:
        `${mega.length} session(s) with ${MAX_TURNS}+ prompts (max ${Math.max(...mega.map((s) => s.turns))})` +
        (compactions > 0 ? ` · ${compactions} compaction(s)` : ''),
      why:
        'Long sessions drag every earlier turn along: accuracy drops as context ' +
        'fills, and each compaction throws detail away.',
      action:
        'Start a new session per task (15–25 prompts is a good size). Carry state ' +
        'forward in a file — the epic\'s artifacts or epic-memory — not in the chat.',
      estSavings: 0,
    });
  }
  return out;
}

/** Coach `repeated-prompts`: the same prompt sent again and again. */
function ruleRepeatedPrompts(records: CallRecord[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const [project, recs] of groupBy(records, (r) => r.project)) {
    const groups = groupBy(recs, (r) => {
      const p = r.prompt?.toLowerCase().replace(/\s+/g, ' ').trim();
      // Short acks ("continue", "yes"), slash commands and AIDLC phase
      // launches (`epic=<id> …`, repeated on every rerun) repeat by design.
      return p && p.length >= 20 && !p.startsWith('/') && !p.startsWith('epic=') ? p : null;
    });
    const repeated = [...groups.entries()].filter(([, g]) => g.length >= 3);
    const dupes = sum(repeated, ([, g]) => g.length - 1);
    if (dupes < 3) { continue; }
    const [top, topRecs] = repeated.reduce((a, b) => (b[1].length > a[1].length ? b : a));
    out.push({
      rule: 'repeated-prompts',
      severity: dupes >= 20 ? 'high' : 'med',
      scope: shortScopeProject(project),
      evidence:
        `${dupes} repeats across ${repeated.length} prompt(s) · top ×${topRecs.length}: "${top.slice(0, 60)}…"`,
      why:
        'Resending a prompt that did not work rarely changes the result, and a prompt ' +
        'you type every day is work a command could do.',
      action:
        'If it failed, rephrase with the missing context instead of retrying. If it ' +
        'is a routine, save it as a slash command or skill (`.claude/commands/`).',
      estSavings: 0,
    });
  }
  return out;
}

/**
 * Coach `instruction-bloat`: CLAUDE.md files are prepended to every request.
 * Coach's 4 KB limit is kept; sizes are read from disk for each workspace
 * the records ran in.
 */
function ruleInstructionBloat(records: CallRecord[]): Suggestion[] {
  const MAX_BYTES = 4096;
  const size = (f: string): number => { try { return fs.statSync(f).size; } catch { return 0; } };
  const globalBytes = size(path.join(claudeConfigDir(), 'CLAUDE.md'));
  const out: Suggestion[] = [];
  // Windows logs the same folder as `C:\…` and `c:\…` — one workspace.
  const workspaceKey = (r: CallRecord): string | null => {
    if (!r.cwd) { return null; }
    const p = path.resolve(r.cwd);
    return process.platform === 'win32' ? p.toLowerCase() : p;
  };
  for (const [cwd, recs] of groupBy(records, workspaceKey)) {
    const files = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']
      .map((f) => ({ f, bytes: size(path.join(cwd, f)) }))
      .filter((x) => x.bytes > 0);
    const bytes = globalBytes + sum(files, (x) => x.bytes);
    if (bytes <= MAX_BYTES) { continue; }
    const tok = bytes / 4;
    const resent = sum(recs, (r) => tok * modelPrice(r.model).cr / 1_000_000);
    const biggest = files.reduce((a, b) => (b.bytes > a.bytes ? b : a), { f: '~/.claude/CLAUDE.md', bytes: globalBytes });
    out.push({
      rule: 'instruction-bloat',
      severity: bytes >= 16_384 ? 'med' : 'low',
      scope: `workspace ${shortenPath(cwd)}`,
      evidence:
        `${(bytes / 1024).toFixed(1)} KB of CLAUDE.md (~${fmtNum(tok)} tok, largest ${biggest.f}) ` +
        `re-sent on ${fmtNum(recs.length)} calls`,
      why:
        'CLAUDE.md rides in the system prompt of every call. Beyond the token cost, ' +
        'long always-on instructions dilute the ones that matter for the task.',
      action:
        'Keep CLAUDE.md to conventions and hard rules (< 4 KB). Move procedures into ' +
        'skills or `@`-referenced docs that load only when needed.',
      estSavings: resent * 0.5,
    });
  }
  return out;
}

// ═══ Epic rules (AIDLC) ════════════════════════════════════════════════════

/** What the epic rules read from an epic — `EpicSummary` after `enrichEpicsWithUsage`. */
export type EpicForRules = Pick<EpicSummary, 'id' | 'status'> & {
  stepDetails: Array<
    Pick<EpicSummary['stepDetails'][number], 'agent' | 'name' | 'status' | 'rejectCount' | 'history'> & {
      tokenUsage?: { totalTokens: number; cost: number; startedAt: string | null; endedAt: string | null };
    }
  >;
};

function phaseOf(step: { agent: string; name?: string }): string {
  return step.name || step.agent;
}

/** A phase that cost far more on one epic than it usually does. */
function rulePhaseOutlier(epics: EpicForRules[]): Suggestion[] {
  const byPhase = new Map<string, Array<{ epic: string; tokens: number; cost: number }>>();
  for (const e of epics) {
    for (const s of e.stepDetails) {
      const tokens = s.tokenUsage?.totalTokens ?? 0;
      if (tokens <= 0) { continue; }
      const list = byPhase.get(phaseOf(s)) ?? [];
      list.push({ epic: e.id, tokens, cost: s.tokenUsage?.cost ?? 0 });
      byPhase.set(phaseOf(s), list);
    }
  }
  const out: Suggestion[] = [];
  for (const [phase, runs] of byPhase) {
    if (runs.length < 3) { continue; }
    const med = median(runs.map((r) => r.tokens));
    for (const r of runs) {
      const ratio = r.tokens / med;
      if (ratio < 3 || r.tokens < 1_000_000) { continue; }
      out.push({
        rule: 'phase-cost-outlier',
        severity: ratio >= 5 ? 'high' : 'med',
        scope: `epic ${r.epic} · ${phase}`,
        evidence:
          `${fmtNum(r.tokens)} tok (${ratio.toFixed(1)}× the ${phase} median of ${fmtNum(med)} ` +
          `over ${runs.length} epics) · ${fmtCost(r.cost)}`,
        why:
          'A phase that costs several times its usual amount is usually working ' +
          'around thin input: a vague spec, a plan without file paths, or an epic ' +
          'that should have been two.',
        action:
          'Look at what this phase had to discover on its own and push it upstream — ' +
          'tighten the spec or plan, or split the epic — before the next run.',
        estSavings: Math.max(0, r.cost - r.cost / ratio),
      });
    }
  }
  return out;
}

/**
 * A phase that gets rejected on a large share of epics. Counts rejects only:
 * a cascade reject replays the downstream phases as reruns, which would
 * charge one bad input to every phase after it.
 */
function rulePhaseRework(epics: EpicForRules[]): Suggestion[] {
  const byPhase = new Map<string, Array<{ epic: string; rejects: number }>>();
  for (const e of epics) {
    for (const s of e.stepDetails) {
      if (s.status === 'pending' || s.status === 'skipped') { continue; }
      const list = byPhase.get(phaseOf(s)) ?? [];
      list.push({ epic: e.id, rejects: s.rejectCount });
      byPhase.set(phaseOf(s), list);
    }
  }
  const out: Suggestion[] = [];
  for (const [phase, runs] of byPhase) {
    const rejected = runs.filter((r) => r.rejects > 0);
    if (rejected.length < 3) { continue; }
    const rate = rejected.length / runs.length;
    if (rate < 0.25) { continue; }
    const worst = rejected.reduce((a, b) => (b.rejects > a.rejects ? b : a));
    out.push({
      rule: 'phase-rework',
      severity: rate >= 0.5 ? 'high' : 'med',
      scope: `phase ${phase}`,
      evidence:
        `rejected on ${rejected.length}/${runs.length} epics (${Math.round(rate * 100)}%) · ` +
        `${sum(rejected, (r) => r.rejects)} rejects · worst ${worst.epic} ×${worst.rejects}`,
      why:
        'Each reject replays the phase from scratch. When one phase is rejected on ' +
        'many epics, the cause is systematic — its prompt, skill or input — not one epic.',
      action:
        'Read this phase\'s reject reasons side by side; turn the recurring ones into ' +
        'rules in its agent/skill, or into acceptance criteria the step before must produce.',
      estSavings: 0,
    });
  }
  return out;
}

const BUILD_PHASE = /implement|build|code/i;
const CHECK_PHASE = /review|verify|test|qa/i;

/** Coach `vibe-coding`, AIDLC-style: epics finished with no review/verify phase done. */
function ruleUnverifiedEpics(epics: EpicForRules[]): Suggestion[] {
  const unverified = epics.filter((e) =>
    e.status === 'done' &&
    e.stepDetails.some((s) => BUILD_PHASE.test(phaseOf(s)) && s.status === 'done') &&
    !e.stepDetails.some((s) => CHECK_PHASE.test(phaseOf(s)) && s.status === 'done'));
  if (unverified.length === 0) { return []; }
  return [{
    rule: 'unverified-epics',
    severity: 'high',
    scope: `${unverified.length} epic(s)`,
    evidence: unverified.slice(0, 5).map((e) => e.id).join(', ') + (unverified.length > 5 ? ', …' : ''),
    why:
      'Code that ships without an independent review or verify pass is how AI ' +
      'output turns into debt nobody understood when it merged.',
    action:
      'Keep a review or verify step in the pipeline, or run `/review` / `/verify` ' +
      'on these epics before treating them as finished.',
    estSavings: 0,
  }];
}

/** Phases that ran into context compaction — too big for one context window. */
function rulePhaseCompaction(epics: EpicForRules[], records: CallRecord[], workspaceRoot: string): Suggestion[] {
  const root = path.resolve(workspaceRoot);
  const compactions = records
    .filter((r) => r.afterCompact && r.cwd && path.resolve(r.cwd) === root)
    .map((r) => Date.parse(r.timestamp))
    .filter(Number.isFinite);
  if (compactions.length === 0) { return []; }
  const out: Suggestion[] = [];
  for (const e of epics) {
    for (const s of e.stepDetails) {
      const start = Date.parse(s.tokenUsage?.startedAt ?? '');
      if (!Number.isFinite(start)) { continue; }
      const end = Date.parse(s.tokenUsage?.endedAt ?? '') || Date.now();
      const n = compactions.filter((t) => t >= start && t < end).length;
      if (n < 2) { continue; }
      out.push({
        rule: 'phase-compaction',
        severity: n >= 4 ? 'high' : 'med',
        scope: `epic ${e.id} · ${phaseOf(s)}`,
        evidence: `${n} compactions during the phase · ${fmtNum(s.tokenUsage?.totalTokens ?? 0)} tok`,
        why:
          'Compaction summarises the conversation to free space; decisions and file ' +
          'details made earlier in the phase can be lost, and work gets redone.',
        action:
          'Split the phase\'s work (smaller tasks in the plan, or a narrower epic), ' +
          'and write intermediate state to the epic\'s artifacts rather than chat.',
        estSavings: 0,
      });
    }
  }
  return out;
}

// ═══ Entry points ══════════════════════════════════════════════════════════

const RULES: Array<(r: CallRecord[]) => Suggestion[]> = [
  rulePremiumRoutine,
  ruleCacheChurn,
  ruleManyReads,
  ruleRunawayTurns,
  ruleMegaSessions,
  ruleRepeatedPrompts,
  ruleInstructionBloat,
];

const SEV_ORDER: Record<Severity, number> = { high: 0, med: 1, low: 2 };

export function sortSuggestions(list: Suggestion[]): Suggestion[] {
  return list.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.estSavings - a.estSavings);
}

export function analyzeSuggestions(records: CallRecord[]): Suggestion[] {
  return sortSuggestions(RULES.flatMap((rule) => rule(records)));
}

export function analyzeEpicSuggestions(
  epics: EpicForRules[],
  records: CallRecord[],
  workspaceRoot: string,
): Suggestion[] {
  return [
    ...rulePhaseOutlier(epics),
    ...rulePhaseRework(epics),
    ...ruleUnverifiedEpics(epics),
    ...rulePhaseCompaction(epics, records, workspaceRoot),
  ];
}

/** Epic rules for a workspace: lists its epics, attributes usage, runs the rules. Never throws. */
export async function workspaceEpicSuggestions(
  workspaceRoot: string | undefined,
  records: CallRecord[],
): Promise<Suggestion[]> {
  if (!workspaceRoot) { return []; }
  try {
    const epics = listEpicsCached(workspaceRoot, readYamlShared(workspaceRoot));
    await enrichEpicsWithUsage(workspaceRoot, epics);
    return analyzeEpicSuggestions(epics, records, workspaceRoot);
  } catch {
    return [];
  }
}
