import type { PipelineSummary } from './types';

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
