import { describe, expect, it, vi } from 'vitest';

import { AgentActivityRegistry, MAX_AGE_MS } from '../src/v2/agentActivity';

/**
 * The registry behind the "agent running" indicator.
 *
 * The bug it exists for: `awaiting_work` meant both "nobody has started this"
 * and "Claude is four minutes into writing the artifact", so the panel invited
 * the user to mark a step done the instant it opened, and left Delete live
 * while an agent was mid-write.
 *
 * The half that is easy to get wrong is not turning the flag on — it is
 * turning it off. Every test below is about an entry ending, because an entry
 * that cannot end is a permanently disabled button.
 */
function activity(runId: string, startedAt = Date.now()) {
  return { runId, stepIdx: null, command: `/spec ${runId}`, startedAt, tracked: false };
}

describe('AgentActivityRegistry', () => {
  it('reports a dispatched run as busy, and an untouched one as idle', () => {
    const reg = new AgentActivityRegistry();
    expect(reg.isBusy('EPIC-001')).toBe(false);
    reg.begin(activity('EPIC-001'));
    expect(reg.isBusy('EPIC-001')).toBe(true);
    // Busy is per run — a second epic must not inherit the first one's state.
    expect(reg.isBusy('EPIC-002')).toBe(false);
  });

  it('clears on end, so the step controls come back', () => {
    const reg = new AgentActivityRegistry();
    reg.begin(activity('EPIC-001'));
    reg.end('EPIC-001');
    expect(reg.isBusy('EPIC-001')).toBe(false);
    expect(reg.snapshot()).toEqual({});
  });

  it('expires an entry no end signal ever arrived for', () => {
    const reg = new AgentActivityRegistry();
    const started = 1_000_000;
    reg.begin(activity('EPIC-001', started));

    // A shell without integration reports nothing, and the user may never
    // close the terminal. One second short of the limit it is still busy…
    expect(reg.isBusy('EPIC-001', started + MAX_AGE_MS - 1000)).toBe(true);
    // …and past it the flag lets go on its own rather than wedging the UI.
    expect(reg.isBusy('EPIC-001', started + MAX_AGE_MS + 1)).toBe(false);
  });

  it('drops expired entries out of the snapshot handed to the webview', () => {
    const reg = new AgentActivityRegistry();
    const started = 1_000_000;
    reg.begin(activity('OLD', started));
    reg.begin(activity('NEW', started + MAX_AGE_MS));

    const snap = reg.snapshot(started + MAX_AGE_MS + 1);
    expect(Object.keys(snap)).toEqual(['NEW']);
  });

  it('replaces rather than stacks when the same run is dispatched twice', () => {
    const reg = new AgentActivityRegistry();
    reg.begin(activity('EPIC-001', 1000));
    reg.begin(activity('EPIC-001', 5000));
    expect(Object.keys(reg.snapshot(5000))).toEqual(['EPIC-001']);
    // The newer dispatch is the one being waited on.
    expect(reg.get('EPIC-001', 5000)?.startedAt).toBe(5000);
    // And one `end` — from one terminal closing — clears it completely.
    reg.end('EPIC-001');
    expect(reg.isBusy('EPIC-001', 5000)).toBe(false);
  });

  it('notifies subscribers on begin and end, but not on a no-op end', () => {
    const reg = new AgentActivityRegistry();
    const seen = vi.fn();
    reg.onDidChange(seen);

    reg.begin(activity('EPIC-001'));
    expect(seen).toHaveBeenCalledTimes(1);
    reg.end('EPIC-001');
    expect(seen).toHaveBeenCalledTimes(2);
    // `saveRun` calls end on every transition, including runs that never had
    // an agent dispatched — those must not re-render every panel.
    reg.end('EPIC-001');
    reg.end('NEVER-STARTED');
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('keeps notifying the other subscribers when one throws', () => {
    const reg = new AgentActivityRegistry();
    const good = vi.fn();
    reg.onDidChange(() => { throw new Error('panel disposed'); });
    reg.onDidChange(good);

    // A disposed webview must not be able to stop a dispatch being recorded.
    expect(() => reg.begin(activity('EPIC-001'))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('stops notifying a disposed subscriber', () => {
    const reg = new AgentActivityRegistry();
    const seen = vi.fn();
    const sub = reg.onDidChange(seen);
    sub.dispose();
    reg.begin(activity('EPIC-001'));
    expect(seen).not.toHaveBeenCalled();
  });

  it('upgrades an entry to tracked once shell integration reports in', () => {
    const reg = new AgentActivityRegistry();
    const seen = vi.fn();
    reg.begin(activity('EPIC-001'));
    reg.onDidChange(seen);

    reg.markTracked('EPIC-001');
    expect(reg.get('EPIC-001')?.tracked).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    // Idempotent — the event only fires on a real change.
    reg.markTracked('EPIC-001');
    expect(seen).toHaveBeenCalledTimes(1);
    // And it must not resurrect an entry that already ended.
    reg.end('EPIC-001');
    reg.markTracked('EPIC-001');
    expect(reg.isBusy('EPIC-001')).toBe(false);
  });
});
