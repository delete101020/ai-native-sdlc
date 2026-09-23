/**
 * The plan-usage reader hangs off an endpoint nobody promised us, so the parser
 * is the part that will break first — quietly, by going empty, on a day the
 * response shape shifts. The payload below is a real `GET /api/oauth/usage`
 * response with the account-identifying fields removed; pinning it means the
 * drift shows up here rather than as a status bar that silently disappeared.
 *
 * Also the usual contribution check: a command registered in code but missing
 * from `contributes` never reaches the palette.
 */
import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  estimateBurn,
  parseUsageWindows,
  usageAlert,
  statusBarWindows,
  usageBar,
  usageMarkdown,
  usageStatusText,
  usageSummary,
} from '../src/v2/claudeUsage';

/** Captured live, 2026-09-22. Unused sibling keys trimmed. */
const LIVE = {
  five_hour: {
    utilization: 49,
    resets_at: '2026-09-22T13:00:00.689894+00:00',
    limit_dollars: null,
    locked_reason: null,
  },
  seven_day: {
    utilization: 66,
    resets_at: '2026-09-22T19:00:00.689944+00:00',
    limit_dollars: null,
    locked_reason: null,
  },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: 'session', group: 'session', percent: 49, severity: 'normal', resets_at: '2026-09-22T13:00:00.689894+00:00', is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 66, severity: 'normal', resets_at: '2026-09-22T19:00:00.689944+00:00', is_active: true },
  ],
};

/** Captured live, 2026-09-23, on a plan with a per-model week. Unused sibling keys trimmed. */
const LIVE_SCOPED = {
  five_hour: { utilization: 2, resets_at: '2026-09-23T02:59:59.901113+00:00', locked_reason: null },
  seven_day: { utilization: 38, resets_at: '2026-09-28T14:59:59.901130+00:00', locked_reason: null },
  seven_day_opus: null,
  nimbus_quill: { utilization: 0, resets_at: null, locked_reason: null },
  limits: [
    { kind: 'session', group: 'session', percent: 2, severity: 'normal', resets_at: '2026-09-23T02:59:59.901113+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 38, severity: 'normal', resets_at: '2026-09-28T14:59:59.901130+00:00', scope: null, is_active: false },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 61, severity: 'normal', resets_at: '2026-09-28T14:59:59.901282+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
};

describe('plan usage parsing', () => {
  it('reads the live response shape', () => {
    const windows = parseUsageWindows(LIVE);
    expect(windows.map((w) => [w.label, w.usedPct, w.remainingPct])).toEqual([
      ['5-hour session', 49, 51],
      ['Weekly (all models)', 66, 34],
    ]);
    expect(new Date(windows[0].resetsAt).toISOString()).toBe('2026-09-22T13:00:00.689Z');
  });

  it('falls back to the named windows when `limits` is absent', () => {
    const { limits, ...rest } = LIVE;
    void limits;
    const windows = parseUsageWindows(rest);
    // Same two windows, same numbers — the two halves of the payload agree, and
    // a null window (no Opus limit on this plan) is dropped rather than shown as 0%.
    expect(windows.map((w) => [w.label, w.usedPct])).toEqual([
      ['5-hour session', 49],
      ['Weekly (all models)', 66],
    ]);
  });

  it('keeps a window it has never heard of, under its raw name', () => {
    const windows = parseUsageWindows({
      limits: [{ kind: 'monthly_something', percent: 10, severity: 'normal', resets_at: null }],
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].label).toBe('Monthly something');
    // No reset time is not a reason to hide the percentage.
    expect(windows[0].resetsAt).toBe(0);
  });

  it('tells the all-models week from the model-scoped one, as the server sends it', () => {
    // Captured live, 2026-09-23, on a plan with a Fable week. The model window
    // is `weekly_scoped`, and only `scope.model.display_name` says which model.
    const windows = parseUsageWindows(LIVE_SCOPED);
    expect(windows.map((w) => [w.key, w.label, w.shortLabel, w.remainingPct])).toEqual([
      ['session', '5-hour session', '5h', 98],
      ['weekly_all', 'Weekly (all models)', '1w', 62],
      ['weekly_fable', 'Weekly (Fable)', 'Fable', 39],
    ]);
    const state = { kind: 'ok' as const, windows, tightest: windows[2], fetchedAt: 0 };
    expect(usageStatusText(state)).toBe('5h 2% · 1w 38% · Fable 61%');
  });

  it('names a scoped model it has never heard of by its display name', () => {
    const windows = parseUsageWindows({
      limits: [{
        kind: 'weekly_scoped', group: 'weekly', percent: 10, severity: 'normal', resets_at: null,
        scope: { model: { id: null, display_name: 'Nimbus' }, surface: null },
      }],
    });
    expect(windows.map((w) => [w.label, w.shortLabel])).toEqual([['Weekly (Nimbus)', 'Nimbus']]);
  });

  it('never lets two windows share a name', () => {
    const windows = parseUsageWindows({
      limits: [
        { kind: 'weekly_scoped', group: 'weekly', percent: 10, severity: 'normal', resets_at: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 20, severity: 'normal', resets_at: null },
      ],
    });
    expect(windows.map((w) => w.shortLabel)).toEqual(['scoped', 'scoped2']);
  });

  it('yields nothing rather than guessing on a shape it cannot read', () => {
    expect(parseUsageWindows({})).toEqual([]);
    expect(parseUsageWindows({ limits: [{ kind: 'session', percent: 'lots' }] })).toEqual([]);
    expect(parseUsageWindows({ five_hour: { utilization: null } })).toEqual([]);
  });
});

describe('plan usage rendering', () => {
  const windows = parseUsageWindows(LIVE);
  const state = {
    kind: 'ok' as const,
    windows,
    tightest: windows[1],
    fetchedAt: Date.now(),
  };

  it('headlines the tightest window, not the first', () => {
    expect(usageSummary(state)).toBe('66% used');
  });

  it('puts one percentage per window on the status bar', () => {
    expect(usageStatusText(state)).toBe('5h 49% · 1w 66%');
    expect(usageStatusText(state, { style: 'tightest' })).toBe('66% used');
    expect(usageStatusText({ kind: 'no-plan' })).toBeUndefined();
  });

  it('gives every window its own slot, session first', () => {
    // A plan with a per-model weekly limit: headlining one number is how the
    // bar ended up reporting only Fable, with the session window — the one
    // that bites first — nowhere to be seen.
    const perModel = parseUsageWindows({
      limits: [
        { kind: 'weekly_fable', group: 'weekly', percent: 88, severity: 'normal', resets_at: null },
        { kind: 'session', group: 'session', percent: 20, severity: 'normal', resets_at: null },
        { kind: 'weekly_all', group: 'weekly', percent: 40, severity: 'normal', resets_at: null },
      ],
    });
    expect(statusBarWindows(perModel).map((w) => w.key))
      .toEqual(['session', 'weekly_all', 'weekly_fable']);
    expect(usageStatusText({
      kind: 'ok', windows: perModel, tightest: perModel[0], fetchedAt: Date.now(),
    })).toBe('5h 20% · 1w 40% · Fable 88%');
  });

  it('keeps a window it has never seen, after the ones it knows', () => {
    const windows = parseUsageWindows({
      limits: [
        { kind: 'monthly_something', percent: 90, severity: 'normal', resets_at: null },
        { kind: 'session', group: 'session', percent: 10, severity: 'normal', resets_at: null },
      ],
    });
    expect(statusBarWindows(windows).map((w) => w.shortLabel)).toEqual(['5h', 'monthly']);
  });

  it('colours by the window that gates every model, not the tightest one', () => {
    const windows = parseUsageWindows({
      limits: [
        { kind: 'session', group: 'session', percent: 20, severity: 'normal', resets_at: null },
        { kind: 'weekly_all', group: 'weekly', percent: 40, severity: 'normal', resets_at: null },
        { kind: 'weekly_fable', group: 'weekly', percent: 97, severity: 'normal', resets_at: null },
      ],
    });
    // Fable is at 3% left, but the fix for that is to run the next step on
    // another model — amber, and never the red that means "everything stops".
    const alert = usageAlert({ kind: 'ok', windows, tightest: windows[2], fetchedAt: 0 });
    expect(alert.level).toBe('warning');
    expect(alert.window?.key).toBe('weekly_fable');
  });

  it('goes red when a gating window is at the wall', () => {
    const windows = parseUsageWindows({
      limits: [
        { kind: 'session', group: 'session', percent: 96, severity: 'normal', resets_at: null },
        { kind: 'weekly_all', group: 'weekly', percent: 40, severity: 'normal', resets_at: null },
      ],
    });
    const alert = usageAlert({ kind: 'ok', windows, tightest: windows[0], fetchedAt: 0 });
    expect(alert).toMatchObject({ level: 'critical' });
    expect(alert.window?.key).toBe('session');
  });

  it('defers to the server on overage, and stays quiet with room everywhere', () => {
    const locked = parseUsageWindows({
      limits: [{ kind: 'weekly_all', group: 'weekly', percent: 61, severity: 'critical', resets_at: null }],
    });
    expect(usageAlert({ kind: 'ok', windows: locked, tightest: locked[0], fetchedAt: 0 }).level)
      .toBe('critical');

    const roomy = parseUsageWindows({
      limits: [
        { kind: 'session', group: 'session', percent: 10, severity: 'normal', resets_at: null },
        { kind: 'weekly_fable', group: 'weekly', percent: 50, severity: 'normal', resets_at: null },
      ],
    });
    expect(usageAlert({ kind: 'ok', windows: roomy, tightest: roomy[1], fetchedAt: 0 }).level)
      .toBe('none');
    expect(usageAlert({ kind: 'no-plan' }).level).toBe('none');
  });

  it('counts down only the 5-hour window, and only when asked', () => {
    const windows = parseUsageWindows({
      limits: [
        { kind: 'session', group: 'session', percent: 49, severity: 'normal', resets_at: new Date(Date.now() + 132 * 60_000).toISOString() },
        { kind: 'weekly_all', group: 'weekly', percent: 66, severity: 'normal', resets_at: new Date(Date.now() + 75 * 3600_000).toISOString() },
      ],
    });
    const ok = { kind: 'ok' as const, windows, tightest: windows[1], fetchedAt: 0 };
    expect(usageStatusText(ok, { resetIn: true })).toBe('5h 49% - 2h12m · 1w 66%');
    expect(usageStatusText(ok)).toBe('5h 49% · 1w 66%');
  });

  it('moves amber and red where the settings put them', () => {
    const windows = parseUsageWindows({
      limits: [{ kind: 'session', group: 'session', percent: 65, severity: 'normal', resets_at: null }],
    });
    const state = { kind: 'ok' as const, windows, tightest: windows[0], fetchedAt: 0 };
    expect(usageAlert(state).level).toBe('none');
    expect(usageAlert(state, { warnBelow: 40, criticalBelow: 20 }).level).toBe('warning');
    expect(usageAlert(state, { warnBelow: 60, criticalBelow: 40 }).level).toBe('critical');
  });

  it('says nothing at all when there is nothing trustworthy to say', () => {
    expect(usageSummary({ kind: 'no-plan' })).toBeUndefined();
    expect(usageSummary({ kind: 'error', message: 'HTTP 500' })).toBeUndefined();
    expect(usageMarkdown(undefined)).toEqual([]);
  });

  it('draws what is used as a bar in the tooltip', () => {
    expect(usageBar(100)).toBe('█'.repeat(20));
    expect(usageBar(0)).toBe('░'.repeat(20));
    expect(usageBar(50)).toBe('█'.repeat(10) + '░'.repeat(10));
    // A sliver left is not the same as spent.
    expect(usageBar(1)).toBe('█' + '░'.repeat(19));
    const md = usageMarkdown(state).join('\n');
    expect(md).toContain(`| 5-hour session | \`${usageBar(49)}\` | **49%** |`);
  });

  it('points an expired sign-in at the fix', () => {
    expect(usageMarkdown({ kind: 'expired' }).join(' ')).toContain('claude');
  });
});

describe('burn rate', () => {
  const H = 3600_000;

  it('reads the pace off the readings and says where it lands', () => {
    const now = Date.parse('2026-09-22T20:00:00Z');
    const burn = estimateBurn([
      { at: now - 2 * H, usedPct: 30 },
      { at: now - 1 * H, usedPct: 45 },
      { at: now, usedPct: 60 },
    ], { now });
    expect(burn?.pctPerHour).toBe(15);
    // 40 points left at 15/hr — a touch under three hours out.
    expect(burn?.exhaustsAt).toBeCloseTo(now + (40 / 15) * H, -3);
  });

  it('stays quiet when it cannot honestly answer', () => {
    const now = Date.now();
    // One reading, no span.
    expect(estimateBurn([{ at: now, usedPct: 10 }], { now })).toBeUndefined();
    // Two readings five minutes apart: noise, not a pace.
    expect(estimateBurn([
      { at: now - 5 * 60_000, usedPct: 10 },
      { at: now, usedPct: 12 },
    ], { now })).toBeUndefined();
    // Idle: the level has not moved.
    expect(estimateBurn([
      { at: now - 2 * H, usedPct: 40 },
      { at: now, usedPct: 40 },
    ], { now })).toBeUndefined();
  });

  it('measures from the roll-over, not through it', () => {
    const now = Date.now();
    const burn = estimateBurn([
      { at: now - 3 * H, usedPct: 90 },
      { at: now - 2 * H, usedPct: 4 },
      { at: now - 1 * H, usedPct: 8 },
      { at: now, usedPct: 12 },
    ], { now });
    // 4 points an hour since the window rolled — not the fall from 90 to 4.
    expect(burn?.pctPerHour).toBe(4);
  });

  it('does not project past a reset the window reaches first', () => {
    const now = Date.now();
    const samples = [
      { at: now - 2 * H, usedPct: 10 },
      { at: now, usedPct: 20 },
    ];
    // 80 points left at 5/hr is sixteen hours; the window resets in one.
    expect(estimateBurn(samples, { now, resetsAt: now + H })?.exhaustsAt).toBeUndefined();
    expect(estimateBurn(samples, { now, resetsAt: now + 40 * H })?.exhaustsAt).toBeDefined();
  });
});

describe('plan usage contributions', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ) as {
    contributes: {
      commands: Array<{ command: string; category?: string }>;
      configuration: { properties: Record<string, { type: string; default?: unknown }> };
    };
  };

  it('contributes both commands to the palette', () => {
    for (const id of ['aidlcNative.showClaudePlanUsage', 'aidlcNative.refreshClaudePlanUsage']) {
      expect(pkg.contributes.commands.find((c) => c.command === id)?.category).toBe('AIDLC Native');
    }
  });

  it('contributes the settings, on by default', () => {
    const props = pkg.contributes.configuration.properties;
    expect(props['aidlcNative.claude.planUsage.enabled']?.default).toBe(true);
    expect(props['aidlcNative.claude.planUsage.refreshSeconds']?.default).toBe(300);
    expect(props['aidlcNative.claude.planUsage.statusBar']?.default).toBe('windows');
    expect(props['aidlcNative.claude.planUsage.showResetIn']?.default).toBe(true);
    expect(props['aidlcNative.claude.planUsage.warnBelowPercent']?.default).toBe(20);
    expect(props['aidlcNative.claude.planUsage.criticalBelowPercent']?.default).toBe(5);
  });
});
