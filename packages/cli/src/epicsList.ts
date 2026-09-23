/**
 * Read epic state files from disk — mirrors packages/extension/src/v2/epicsList.ts
 * so the CLI surfaces the same epics the VS Code Builder shows.
 *
 * Cheap: scans <state.root> directly, reads each state.json. Anything that
 * writes a `state.json` matching the shape gets picked up here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeStep, readEpicTags, weighStepProgress } from '@aidlc/core';
import type { ProgressWeighting } from '@aidlc/core';
import type { YamlDocument } from './yamlIO';

export type EpicStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface EpicStepDetail {
  agent: string;
  /** The step's `name`, when its pipeline entry has one. */
  name?: string;
  status: EpicStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * Step ids this one waits on, resolved from the pipeline this epic runs.
   * Empty for a sequential pipeline, and empty when the pipeline is gone —
   * both read as "no peers", which is the answer that changes nothing.
   */
  dependsOn: string[];
}

export interface EpicSummary {
  id: string;
  title: string;
  description: string;
  status: EpicStatus;
  createdAt: string;
  /** Canonical (uppercase) tags from state.json — see core `loader/epicTags`. */
  tags: string[];
  pipeline: string | null;
  agents: string[];
  currentStep: number;
  stepDetails: EpicStepDetail[];
  inputs: Record<string, string>;
  statePath: string;
  epicDir: string;
}

const STATUS_VALUES: ReadonlyArray<EpicStatus> = ['pending', 'in_progress', 'done', 'failed'];

function asStatus(v: unknown): EpicStatus {
  return STATUS_VALUES.includes(v as EpicStatus) ? (v as EpicStatus) : 'pending';
}

/** Resolve epic root directory. Honours workspace.yaml `state.root`, falls back to `docs/epics`. */
export function epicsRoot(workspaceRoot: string, doc: YamlDocument | null): string {
  const stateRoot = doc?.state && typeof (doc.state as Record<string, unknown>).root === 'string'
    ? String((doc.state as Record<string, unknown>).root)
    : 'docs/epics';
  return path.resolve(workspaceRoot, stateRoot);
}

/**
 * The normalized steps of one pipeline in the workspace doc, or `[]` when the
 * doc has no such pipeline. Never throws: a malformed pipeline entry is a
 * reason to show the epic without its dependency graph, not to drop the epic.
 */
function pipelineStepsOf(
  doc: YamlDocument | null,
  pipelineId: string,
): Array<{ name?: string; depends_on: string[] }> {
  const pipelines = Array.isArray(doc?.pipelines) ? (doc.pipelines as unknown[]) : [];
  const match = pipelines.find(
    (p): p is Record<string, unknown> =>
      !!p && typeof p === 'object' && String((p as Record<string, unknown>).id) === pipelineId,
  );
  const steps = Array.isArray(match?.steps) ? (match.steps as unknown[]) : [];
  return steps.map((raw) => {
    try {
      const n = normalizeStep(raw as never);
      return { name: n.name, depends_on: n.depends_on };
    } catch {
      return { depends_on: [] };
    }
  });
}

export function listEpics(workspaceRoot: string, doc: YamlDocument | null): EpicSummary[] {
  const dir = epicsRoot(workspaceRoot, doc);
  if (!fs.existsSync(dir)) { return []; }

  const folders = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const epics: EpicSummary[] = [];
  for (const folder of folders) {
    const epicDir   = path.join(dir, folder);
    const stateFile = path.join(epicDir, 'state.json');
    if (!fs.existsSync(stateFile)) { continue; }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch { continue; }
    if (!parsed || typeof parsed !== 'object') { continue; }

    const stepStatesRaw = Array.isArray(parsed.stepStates)
      ? (parsed.stepStates as Array<Record<string, unknown>>)
      : [];
    // `doc.pipelines` already carries each epic's own pipeline.yaml — see
    // `mergeEpicPipelines` in readYaml — so a fan-out declared per epic is
    // visible here without reopening the file.
    const pipelineId = typeof parsed.pipeline === 'string' ? parsed.pipeline : null;
    const pipelineSteps = pipelineId ? pipelineStepsOf(doc, pipelineId) : [];
    const stepDetails: EpicStepDetail[] = stepStatesRaw.map((s, i) => {
      const cfg = pipelineSteps[i];
      return {
        agent: typeof s.agent === 'string' ? s.agent : '',
        name: typeof s.name === 'string' ? s.name : cfg?.name,
        status: asStatus(s.status),
        startedAt:  typeof s.startedAt  === 'string' ? s.startedAt  : null,
        finishedAt: typeof s.finishedAt === 'string' ? s.finishedAt : null,
        dependsOn: cfg?.depends_on ?? [],
      };
    });

    epics.push({
      id:           typeof parsed.id === 'string' ? parsed.id : folder,
      title:        typeof parsed.title === 'string' ? parsed.title : '',
      description:  typeof parsed.description === 'string' ? parsed.description : '',
      status:       asStatus(parsed.status),
      createdAt:    typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      tags:         readEpicTags(parsed),
      pipeline:     pipelineId,
      agents:       Array.isArray(parsed.agents) ? (parsed.agents as unknown[]).map(String) : [],
      currentStep:  typeof parsed.currentStep === 'number' ? parsed.currentStep : 0,
      stepDetails,
      inputs:       readInputs(epicDir),
      statePath:    stateFile,
      epicDir,
    });
  }

  // Newest first by createdAt; ties → id.
  epics.sort((a, b) => {
    const cmp = b.createdAt.localeCompare(a.createdAt);
    return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
  });
  return epics;
}

export function loadEpic(workspaceRoot: string, doc: YamlDocument | null, id: string): EpicSummary | null {
  return listEpics(workspaceRoot, doc).find(e => e.id === id) ?? null;
}

function readInputs(epicDir: string): Record<string, string> {
  const inputsFile = path.join(epicDir, 'inputs.json');
  if (!fs.existsSync(inputsFile)) { return {}; }
  try {
    const parsed = JSON.parse(fs.readFileSync(inputsFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') { return {}; }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  } catch { return {}; }
}

/**
 * How far an epic has come, measured in stages rather than steps.
 *
 * Peers — steps that share a rank in the pipeline's dependency graph — split
 * one stage between them, so a pipeline that fans three reviewers out of one
 * intake does not report a third of itself done when that round finishes. A
 * sequential pipeline has one step per stage, which is the plain count.
 */
export function epicProgress(epic: Pick<EpicSummary, 'stepDetails'>): ProgressWeighting {
  return weighStepProgress(
    epic.stepDetails.map(s => ({
      id: s.name ?? s.agent,
      dependsOn: s.dependsOn,
      done: s.status === 'done',
    })),
  );
}
