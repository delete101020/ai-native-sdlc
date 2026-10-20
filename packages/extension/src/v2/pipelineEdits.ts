/**
 * Pure helpers behind the builder's pipeline edits, kept out of the webview
 * provider so they can be tested without a VS Code host.
 */
import { normalizeStep, sendBackIssues, type PipelineStepConfig } from '@aidlc/core';

/**
 * Keys the Edit pipeline modal owns on a step. Everything else on the step —
 * `requires`, `produces`, `enabled`, `on_reject`, `batches`, `timeout_minutes`,
 * `git`, follow-up hooks, whatever is added next — is the step config modal's
 * or hand-authored, and a save through this modal must leave it as it was.
 */
const MODAL_OWNED = [
  'agent', 'name', 'skills', 'skill', 'default_skill',
  'human_review', 'auto_review', 'auto_review_runner', 'depends_on',
] as const;

export type RebuildResult =
  | { ok: true; steps: Array<Record<string, unknown>> }
  | { ok: false; error: string };

/**
 * The step list the Edit pipeline modal asks for, built on top of the steps
 * already in the YAML.
 *
 * The modal sends its whole step array, so each draft step is paired with
 * the step it came from — by step name first, because one agent can back
 * several steps (a dev agent that specs, then builds) and reordering them
 * must not swap what they carry; then by agent, in order. The paired step is
 * copied whole and only the modal's own keys are rewritten. It used to be
 * rebuilt from a list of fields to keep, which silently dropped every field
 * not on the list: re-saving `cr-squad` cost `cr-review` its `on_reject` and
 * `cr-build` its `batches`, and the build ⇄ review loop quietly stopped.
 */
export function rebuildEditedSteps(oldSteps: readonly unknown[], draftSteps: readonly unknown[]): RebuildResult {
  const pool = oldSteps.map((raw) => ({
    raw: typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {},
    norm: normalizeStep(raw as PipelineStepConfig),
  }));
  const take = (agent: string, name: string): Record<string, unknown> | undefined => {
    let i = name ? pool.findIndex((c) => c.norm.agent === agent && c.norm.name === name) : -1;
    if (i < 0) { i = pool.findIndex((c) => c.norm.agent === agent); }
    return i < 0 ? undefined : pool.splice(i, 1)[0].raw;
  };

  const steps: Array<Record<string, unknown>> = [];
  for (const raw of draftSteps) {
    if (!raw || typeof raw !== 'object') { continue; }
    const r = raw as Record<string, unknown>;
    const agent = String(r.agent ?? '').trim();
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const skills = Array.isArray(r.skills) ? r.skills.map(String).filter((s) => s.length > 0) : [];
    const dependsOn = Array.isArray(r.depends_on) ? r.depends_on.map(String).filter((s) => s.length > 0) : [];
    const autoReview = r.auto_review === true;
    const runner = typeof r.auto_review_runner === 'string' ? r.auto_review_runner.trim() : '';
    if (autoReview && !runner) {
      return { ok: false, error: `Step "${name || agent}": auto_review is on but runner path is empty.` };
    }

    const carried = take(agent, name);
    const step: Record<string, unknown> = carried
      ? { ...carried }
      : { enabled: true, requires: [], produces: [] };
    for (const k of MODAL_OWNED) { delete step[k]; }
    // `agent` first, so a carried step still reads like a hand-written one.
    const out: Record<string, unknown> = { agent, ...(name ? { name } : {}), ...step };
    if (skills.length > 0) { out.skills = skills; }
    if (typeof r.default_skill === 'string' && skills.length > 1 && skills.includes(r.default_skill)) {
      out.default_skill = r.default_skill;
    }
    if (dependsOn.length > 0) { out.depends_on = dependsOn; }
    out.human_review = r.human_review === true;
    out.auto_review = autoReview;
    if (autoReview) { out.auto_review_runner = runner; }
    dropDeadOnReject(out);
    steps.push(out);
  }

  const issues = newSendBackIssues(oldSteps, steps);
  if (issues.length > 0) { return { ok: false, error: issues.join('\n') }; }
  return { ok: true, steps };
}

/**
 * `on_reject` routes an auto-review reject; on a step whose auto review is
 * off it routes nothing, and the schema refuses the whole workspace over it.
 * Turning auto review off is the clear intent, so the route goes with it.
 */
export function dropDeadOnReject(step: Record<string, unknown>): void {
  if (step.auto_review !== true) { delete step.on_reject; }
}

/**
 * `on_reject` problems an edit introduced, as messages. Problems the pipeline
 * already had are not this edit's to answer for.
 *
 * Checked before writing: a send-back target that stops being valid — it got
 * `human_review`, or the step routing to it lost `auto_review` — makes the
 * schema reject workspace.yaml on the next load, which breaks every command,
 * not just this pipeline.
 */
export function newSendBackIssues(before: readonly unknown[], after: readonly unknown[]): string[] {
  const old = new Set(sendBackIssues(before as PipelineStepConfig[]).map((i) => i.message));
  return sendBackIssues(after as PipelineStepConfig[])
    .map((i) => i.message)
    .filter((m) => !old.has(m));
}

/**
 * Applies the pipeline-level autopilot settings a modal sent. A key the draft
 * does not carry is left alone, so an older webview cannot clear them.
 */
export function applyLoopSettings(pipeline: Record<string, unknown>, draft: Record<string, unknown>): void {
  if ('autopilot' in draft) {
    if (draft.autopilot === true) { pipeline.autopilot = true; } else { delete pipeline.autopilot; }
  }
  if ('max_send_backs' in draft) {
    const n = draft.max_send_backs;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) {
      pipeline.max_send_backs = n;
    } else {
      delete pipeline.max_send_backs;
    }
  }
}

/**
 * Applies the step config modal's `on_reject` / `batches` fields to `step`.
 * Same rule: a key the modal did not send keeps the YAML's value.
 */
export function applyStepLoopSettings(step: Record<string, unknown>, config: Record<string, unknown>): void {
  if ('send_back_to' in config) {
    const t = typeof config.send_back_to === 'string' ? config.send_back_to.trim() : '';
    if (t) { step.on_reject = { send_back_to: t }; } else { delete step.on_reject; }
  }
  if ('batches' in config) {
    if (config.batches === true) {
      step.batches = true;
      const max = config.max_batches;
      if (typeof max === 'number' && Number.isInteger(max) && max > 0) {
        step.max_batches = max;
      } else {
        delete step.max_batches;
      }
    } else {
      delete step.batches;
      delete step.max_batches;
      delete step.pause_between_batches;
    }
  }
  dropDeadOnReject(step);
}
