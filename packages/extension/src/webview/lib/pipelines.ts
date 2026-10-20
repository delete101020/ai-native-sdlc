import type { PipelineStepSummary, PipelineSummary } from './types';

/**
 * True when this pipeline is one epic's own run shape rather than a workflow
 * someone authored to start work with.
 *
 * Starting an epic assembles a pipeline named after that epic and keeps it —
 * the epic's history is keyed by position into these exact steps, so it can
 * never be reused for anything else. Listing them made every picker grow by
 * one dead row per epic, each looking like a reusable choice.
 *
 * Two signals, because neither covers everything on its own: `derivedFrom` is
 * written by the assembler, and `ownedByEpic` says the definition was read
 * from `docs/epics/<id>/pipeline.yaml` — which is the only marker an epic
 * pipeline predating `derived_from`, or one edited by hand, still carries.
 */
export function isEpicOwnedPipeline(p: PipelineSummary): boolean {
  return !!p.derivedFrom || !!p.ownedByEpic;
}

/** Pipelines a picker should offer: everything an epic does not own. */
export function selectablePipelines(pipelines: PipelineSummary[]): PipelineSummary[] {
  return pipelines.filter((p) => !isEpicOwnedPipeline(p));
}

/** An earlier step offered as a step's `on_reject.send_back_to`. */
export interface SendBackChoice {
  /** What goes in the YAML: the step name, or the agent id when it has none. */
  ref: string;
  label: string;
  /** Why the runner would refuse this target; unset = it can be picked. */
  blocked?: string;
}

const refOf = (s: PipelineStepSummary): string => s.name ?? s.agent;

/**
 * Steps an auto-review reject at `idx` may send work back to, with the ones
 * the schema refuses marked rather than hidden (so the reason is visible).
 * Mirrors core `sendBackIssues`: a step before this one, addressable on its
 * own, and without `human_review` — work a person approved goes back through
 * a person.
 */
export function sendBackChoices(steps: PipelineStepSummary[], idx: number): SendBackChoice[] {
  return steps.slice(0, Math.max(0, idx)).map((s, i) => {
    const ref = refOf(s);
    const label = `${i + 1}. ${ref}`;
    if (!s.name && steps.filter((o) => o.agent === s.agent).length > 1) {
      return { ref, label, blocked: 'agent backs several steps — name this step first' };
    }
    if (s.human_review) { return { ref, label, blocked: 'has human review' }; }
    return { ref, label };
  });
}

/**
 * Later steps whose `on_reject` sends work back to step `idx`. Turning on
 * human review here would leave each of them routing to a step the schema
 * refuses as a target.
 */
export function sendBackSources(steps: PipelineStepSummary[], idx: number): string[] {
  const target = steps[idx];
  if (!target) { return []; }
  const refs = new Set([refOf(target), target.agent]);
  return steps
    .filter((s, i) => i > idx && !!s.send_back_to && refs.has(s.send_back_to))
    .map(refOf);
}
