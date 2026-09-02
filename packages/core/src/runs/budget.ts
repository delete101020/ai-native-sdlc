/**
 * Cost ceiling check for the `aidlc run exec` autopilot loop.
 *
 * Pure function over already-accumulated per-step costs + the pipeline's
 * optional `budget`. The CLI loop calls this after each step and acts on the
 * verdict (pause / fail). Kept side-effect free so it's unit-testable without
 * spawning claude.
 */

import type { PipelineBudget } from '../schema/WorkspaceSchema';

/**
 * How well we know what a step cost.
 *
 *  - `measured`  — the CLI reported dollars (Claude Code's `total_cost_usd`).
 *  - `estimated` — tokens × a rate the user declared in `providers:`.
 *  - `blind`     — the step ran and we have no idea what it cost.
 *
 * `blind` is the one that matters: it sums as 0, so a ceiling can be crossed
 * without the guard noticing. The verdict reports the count so the caller can
 * say so instead of implying the total is complete.
 */
export type CostAccounting = 'measured' | 'estimated' | 'blind';

export interface BudgetCheckArgs {
  /** Per-step costs in USD; entries that haven't run yet are undefined/0. */
  stepCosts: Array<number | undefined>;
  /**
   * Accounting quality parallel to `stepCosts`. Absent entries are inferred:
   * a cost is `measured`, no cost is `blind`. Steps that have not run yet are
   * excluded by the caller passing `undefined` here as well.
   */
  stepAccounting?: Array<CostAccounting | undefined>;
  /** The pipeline's budget config, if any. */
  budget?: PipelineBudget;
  /** Cost of the step that just ran, in USD (for the per-step ceiling check). */
  lastStepCost?: number;
}

/** Portions of `spent` by accounting quality, plus how many steps we are blind on. */
export interface CostConfidence {
  /** USD from costs a CLI actually reported. */
  measured: number;
  /** USD derived from token counts × a declared rate. */
  estimated: number;
  /** Number of executed steps that reported neither cost nor usage. */
  blindSteps: number;
}

export type BudgetVerdict =
  | ({ ok: true; spent: number } & CostConfidence)
  | ({ ok: false; exceeded: 'step' | 'total'; spent: number; limit: number } & CostConfidence);

/**
 * Returns `{ ok: true, spent }` when under budget (or no budget configured),
 * otherwise `{ ok: false, exceeded, spent, limit }`. The per-step ceiling is
 * checked first so the message points at the immediate cause.
 */
export function checkBudget(args: BudgetCheckArgs): BudgetVerdict {
  const { stepCosts, stepAccounting, budget, lastStepCost } = args;
  const spent = stepCosts.reduce<number>((sum, c) => sum + (c ?? 0), 0);

  // An estimate still counts against the ceiling. The alternative — excluding
  // it — leaves a Codex run with no ceiling at all, which is strictly worse
  // than a ceiling built partly on the user's own declared rates. What it must
  // never do is pass itself off as measured, hence the split.
  let measured = 0;
  let estimated = 0;
  let blindSteps = 0;
  stepCosts.forEach((cost, i) => {
    const quality = stepAccounting?.[i] ?? (typeof cost === 'number' ? 'measured' : undefined);
    if (quality === 'estimated') { estimated += cost ?? 0; }
    else if (quality === 'measured') { measured += cost ?? 0; }
    else if (quality === 'blind') { blindSteps += 1; }
  });
  const conf: CostConfidence = { measured, estimated, blindSteps };

  if (!budget) { return { ok: true, spent, ...conf }; }

  if (
    budget.max_usd_per_step !== undefined &&
    lastStepCost !== undefined &&
    lastStepCost > budget.max_usd_per_step
  ) {
    return { ok: false, exceeded: 'step', spent, limit: budget.max_usd_per_step, ...conf };
  }

  if (spent > budget.max_usd) {
    return { ok: false, exceeded: 'total', spent, limit: budget.max_usd, ...conf };
  }

  return { ok: true, spent, ...conf };
}
