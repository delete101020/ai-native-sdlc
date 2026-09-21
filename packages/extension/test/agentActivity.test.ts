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
function activity(runId: string, startedAt = Date.now(), stepIdx: number | null = null) {
  return { runId, stepIdx, command: `/spec ${runId}`, startedAt, tracked: false };
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
    expect(snap.NEW).toHaveLength(1);
  });

  it('replaces rather than stacks when the same step is dispatched twice', () => {
    const reg = new AgentActivityRegistry();
    reg.begin(activity('EPIC-001', 1000, 2));
    reg.begin(activity('EPIC-001', 5000, 2));
    expect(reg.forRun('EPIC-001', 5000)).toHaveLength(1);
    // The newer dispatch is the one being waited on.
    expect(reg.getStep('EPIC-001', 2, 5000)?.startedAt).toBe(5000);
    // And one `end` — from one terminal closing — clears it completely.
    reg.end('EPIC-001', 2);
    expect(reg.isStepBusy('EPIC-001', 2, 5000)).toBe(false);
  });

  /**
   * The half this file exists for, second edition: a DAG opens its parallel
   * steps together, so two agents can be on one run at the same moment. A
   * single per-run slot made the second dispatch erase the first — the panel
   * then reported one banner for both steps, and focusing the idle sibling
   * still said "agent running" and took its Run button away.
   */
  describe('parallel steps', () => {
    it('keeps one entry per step of the same run', () => {
      const reg = new AgentActivityRegistry();
      reg.begin(activity('EPIC-001', 1000, 1));
      reg.begin(activity('EPIC-001', 2000, 2));

      expect(reg.forRun('EPIC-001', 2000).map((a) => a.stepIdx)).toEqual([1, 2]);
      expect(reg.snapshot(2000)['EPIC-001']).toHaveLength(2);
    });

    it('reports busy per step, so a sibling keeps its own controls', () => {
      const reg = new AgentActivityRegistry();
      reg.begin(activity('EPIC-001', 1000, 1));

      expect(reg.isStepBusy('EPIC-001', 1, 1000)).toBe(true);
      // Step 2 is open and idle — this is the run's whole point.
      expect(reg.isStepBusy('EPIC-001', 2, 1000)).toBe(false);
      // The run as a whole is still busy, which is what a whole-run action
      // (delete the epic, run to completion) has to wait for.
      expect(reg.isBusy('EPIC-001', 1000)).toBe(true);
    });

    it('ends one step without touching its sibling', () => {
      const reg = new AgentActivityRegistry();
      reg.begin(activity('EPIC-001', 1000, 1));
      reg.begin(activity('EPIC-001', 1000, 2));

      reg.end('EPIC-001', 1);
      expect(reg.isStepBusy('EPIC-001', 1, 1000)).toBe(false);
      expect(reg.isStepBusy('EPIC-001', 2, 1000)).toBe(true);
    });

    it('ends every step of a run when no step is named', () => {
      const reg = new AgentActivityRegistry();
      reg.begin(activity('EPIC-001', 1000, 1));
      reg.begin(activity('EPIC-001', 1000, 2));
      reg.begin(activity('EPIC-002', 1000, 0));

      // What the exec loop finishing, or a workspace-wide reset, means.
      reg.end('EPIC-001');
      expect(reg.forRun('EPIC-001', 1000)).toEqual([]);
      expect(reg.isStepBusy('EPIC-002', 0, 1000)).toBe(true);
    });

    it('lets an unattributed dispatch stand in for a step with none of its own', () => {
      const reg = new AgentActivityRegistry();
      // A launch the host could not pin to a step — the old shape, and still
      // what `Run to completion` records before its first step starts.
      reg.begin(activity('EPIC-001', 1000, null));
      reg.begin(activity('EPIC-001', 1000, 3));

      // Step 3 has its own; every other step falls back to the unattributed
      // one rather than offering to start a second agent on the same work.
      expect(reg.getStep('EPIC-001', 3, 1000)?.stepIdx).toBe(3);
      expect(reg.getStep('EPIC-001', 0, 1000)?.stepIdx).toBe(null);
      // And it can be dismissed on its own.
      reg.end('EPIC-001', null);
      expect(reg.isStepBusy('EPIC-001', 0, 1000)).toBe(false);
      expect(reg.isStepBusy('EPIC-001', 3, 1000)).toBe(true);
    });
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

  it('upgrades the named step, not whichever entry the run happens to have', () => {
    const reg = new AgentActivityRegistry();
    reg.begin(activity('EPIC-001', 1000, 1));
    reg.begin(activity('EPIC-001', 1000, 2));

    reg.markTracked('EPIC-001', 2);
    expect(reg.getStep('EPIC-001', 1, 1000)?.tracked).toBe(false);
    expect(reg.getStep('EPIC-001', 2, 1000)?.tracked).toBe(true);
  });
});
