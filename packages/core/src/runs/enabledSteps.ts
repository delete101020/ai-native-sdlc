/**
 * What `enabled: false` on a pipeline step means to the runner.
 *
 * A step can be switched off per epic — by hand in its `pipeline.yaml`, or from
 * the step config modal — and the builder drew it as disabled long before the
 * runner knew. It scheduled by `depends_on` and step order alone, so a disabled
 * step was either opened anyway or, on a DAG, held every step behind it pending
 * for good: CR-261023-00 disabled `cr-build` and `cr-review` and `cr-close`
 * never opened, because what it waited on never completed.
 *
 * The rule is the one a person would apply reading the pipeline:
 *
 *   - a disabled step never opens; the run records it as `skipped`;
 *   - a step that depends on a disabled one waits on what *that* step waited
 *     on, recursively — `cr-close` behind disabled `cr-review` and `cr-build`
 *     waits on `cr-build-spec`;
 *   - on a pipeline with no `depends_on` anywhere, the chain is index order,
 *     and a disabled step is simply passed over.
 *
 * Everything here is pure and derived from the pipeline alone, so the runner,
 * the progress roll-up and `aidlc doctor` read the same graph.
 */

import type { PipelineConfig, NormalizedStep } from '../schema/WorkspaceSchema';
import { normalizeStep, findStepIndex, AMBIGUOUS_STEP_INDEX } from '../schema/WorkspaceSchema';

/**
 * Is the step at `idx` enabled? A step the pipeline does not have counts as
 * enabled: disabling is something the pipeline says, never something guessed.
 */
export function isStepEnabled(pipeline: PipelineConfig | null | undefined, idx: number): boolean {
  const cfg = pipeline?.steps?.[idx];
  return cfg === undefined ? true : normalizeStep(cfg).enabled;
}

/**
 * Each step's `depends_on`, with every disabled step replaced by what it
 * depends on — recursively, so a chain of disabled steps collapses onto the
 * nearest enabled ancestors. Indexed like `pipeline.steps`.
 *
 * An id that names no step is kept as written: it never resolves, which is
 * what it did before, and `aidlc doctor` reports it. A cycle through disabled
 * steps stops at the step it re-enters instead of looping.
 *
 * With nothing disabled this is exactly each step's own `depends_on`.
 */
export function effectiveDependsOn(pipeline: PipelineConfig): string[][] {
  return effectiveDepsOf(pipeline.steps.map(normalizeStep));
}

/** {@link effectiveDependsOn} over steps already normalized. */
export function effectiveDepsOf(normalized: readonly NormalizedStep[]): string[][] {
  const idxById = new Map<string, number>();
  normalized.forEach((s, i) => { idxById.set(s.name ?? s.agent, i); });

  // What a dependent of disabled step `i` waits on instead of it.
  const expanded = new Map<number, string[]>();
  const visiting = new Set<number>();
  const passThrough = (i: number): string[] => {
    const hit = expanded.get(i);
    if (hit) { return hit; }
    if (visiting.has(i)) { return []; }
    visiting.add(i);
    const out = resolve(normalized[i].depends_on);
    visiting.delete(i);
    expanded.set(i, out);
    return out;
  };
  const resolve = (deps: readonly string[]): string[] => {
    const out: string[] = [];
    for (const dep of deps) {
      const di = idxById.get(dep);
      const ids = di === undefined || normalized[di].enabled ? [dep] : passThrough(di);
      for (const id of ids) { if (!out.includes(id)) { out.push(id); } }
    }
    return out;
  };

  return normalized.map((s) => resolve(s.depends_on));
}

/**
 * First enabled step at or after `from`, or -1 when there is none — the next
 * link of a pipeline that runs in index order.
 */
export function nextEnabledIdx(pipeline: PipelineConfig, from: number): number {
  for (let i = Math.max(0, from); i < pipeline.steps.length; i++) {
    if (isStepEnabled(pipeline, i)) { return i; }
  }
  return -1;
}

/** A problem `enabled: false` causes, as `aidlc doctor` reports it. */
export interface DisabledStepIssue {
  stepIdx: number;
  /** `error` stops the run somewhere; `warning` is worth knowing. */
  severity: 'error' | 'warning';
  message: string;
}

/**
 * What disabling steps breaks in a pipeline. Empty when nothing is disabled,
 * so this costs a pipeline that never uses the flag nothing.
 *
 *   - every step disabled: there is nothing to run;
 *   - an enabled step `requires` a file only disabled steps produce: it is
 *     gated on something that is never written;
 *   - an enabled step that can never open, because what it effectively waits
 *     on is not a step, or is a cycle — "no path to a root through enabled
 *     steps";
 *   - an `on_reject.send_back_to` naming a disabled step: the send-back would
 *     reopen a step the run is not running. A warning when the sending step
 *     is disabled too, since it never sends anything.
 */
export function disabledStepIssues(pipeline: PipelineConfig): DisabledStepIssue[] {
  const normalized = pipeline.steps.map(normalizeStep);
  if (normalized.every((s) => s.enabled)) { return []; }

  const issues: DisabledStepIssue[] = [];
  const id = (i: number): string => normalized[i].name ?? normalized[i].agent;

  if (normalized.every((s) => !s.enabled)) {
    issues.push({ stepIdx: 0, severity: 'error', message: 'Every step is disabled — the run has nothing to open.' });
    return issues;
  }

  // Requires that only a disabled step would have written.
  normalized.forEach((s, i) => {
    if (!s.enabled) { return; }
    for (const req of s.requires) {
      if (s.requires_optional.includes(req)) { continue; }
      const producers = normalized
        .map((p, j) => (p.produces.includes(req) ? j : -1))
        .filter((j) => j >= 0 && j !== i);
      if (producers.length === 0) { continue; }
      if (producers.some((j) => normalized[j].enabled)) { continue; }
      issues.push({
        stepIdx: i,
        severity: 'error',
        message: `Step "${id(i)}" requires ${req}, which only disabled step${producers.length === 1 ? '' : 's'} ` +
          `${producers.map((j) => `"${id(j)}"`).join(', ')} produce${producers.length === 1 ? 's' : ''}. ` +
          'Enable one of them, or mark the requirement `optional: true`.',
      });
    }
  });

  // Reachability from the roots, through enabled steps only.
  const usesDag = normalized.some((s) => s.depends_on.length > 0);
  if (usesDag) {
    const deps = effectiveDepsOf(normalized);
    const reached = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      normalized.forEach((s, i) => {
        if (!s.enabled || reached.has(id(i))) { return; }
        if (deps[i].every((d) => reached.has(d))) { reached.add(id(i)); changed = true; }
      });
    }
    normalized.forEach((s, i) => {
      if (!s.enabled || reached.has(id(i))) { return; }
      const waiting = deps[i].filter((d) => !reached.has(d));
      issues.push({
        stepIdx: i,
        severity: 'error',
        message: `Step "${id(i)}" has no path to a root through enabled steps — it waits on ` +
          `${waiting.map((d) => `"${d}"`).join(', ')}, which never ${waiting.length === 1 ? 'opens' : 'open'}. ` +
          'It would stay pending for the rest of the run.',
      });
    });
  }

  // Send-backs into a step that is not running.
  normalized.forEach((s, i) => {
    const target = s.on_reject?.send_back_to;
    if (!target) { return; }
    const t = findStepIndex(normalized, target);
    if (t < 0 || t === AMBIGUOUS_STEP_INDEX || normalized[t].enabled) { return; }
    issues.push({
      stepIdx: i,
      severity: s.enabled ? 'error' : 'warning',
      message: `Step "${id(i)}": \`on_reject.send_back_to\` "${target}" is disabled` +
        (s.enabled
          ? ' — a reject would stop the run instead of sending the work back. Enable it or point the route elsewhere.'
          : ', as is this step, so the route is never taken.'),
    });
  });

  return issues;
}
