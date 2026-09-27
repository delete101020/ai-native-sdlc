/**
 * Did a step actually write anything?
 *
 * `markStepDone` checks that a step's `produces` paths exist. On a first run
 * that is evidence of work; on a rerun or redo it is not, because the previous
 * revision's artifact is still on disk and satisfies the check by itself.
 * Observed live on Copilot CLI: its `create` tool refused to overwrite the
 * existing `spec.md`, the model reported the spec as saved anyway, and the step
 * went to review with the old file (MULTI_PROVIDER_ALIGNMENT.md, risk R1). Any
 * harness can do the same.
 *
 * So the exec loop fingerprints the artifacts before the runner starts and
 * compares afterwards. The rule is deliberately narrow: a step fails only when
 * *none* of its artifacts was created or changed. A multi-artifact step that
 * legitimately leaves one file as it was still passes; one that wrote nothing
 * at all cannot.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { PipelineConfig } from '../schema/WorkspaceSchema';
import { normalizeStep } from '../schema/WorkspaceSchema';
import type { RunState } from './RunState';
import { resolvePath } from './RunState';

/** Content fingerprint per resolved `produces` path; `null` = absent. */
export type ProducesSnapshot = Map<string, string | null>;

/** Fingerprint every `produces` path of a step, present or not. */
export function snapshotProduces(args: {
  state: RunState;
  pipeline: PipelineConfig;
  workspaceRoot: string;
  stepIdx: number;
}): ProducesSnapshot {
  const snap: ProducesSnapshot = new Map();
  const stepCfg = args.pipeline.steps[args.stepIdx];
  if (!stepCfg) { return snap; }
  for (const p of normalizeStep(stepCfg).produces) {
    const rel = resolvePath(p, args.state.context);
    snap.set(rel, fingerprint(absolute(args.workspaceRoot, rel)));
  }
  return snap;
}

/**
 * Artifacts that existed before the step and are byte-identical after it —
 * but only when that is true of every artifact the step has. Empty when the
 * step created or changed at least one, or declares no `produces` (a first run
 * that writes nothing is `markStepDone`'s missing-artifact error, not this).
 */
export function unchangedProduces(before: ProducesSnapshot, workspaceRoot: string): string[] {
  const stale: string[] = [];
  for (const [rel, prior] of before) {
    const now = fingerprint(absolute(workspaceRoot, rel));
    if (now === null) { continue; }
    if (prior === null || prior !== now) { return []; }
    stale.push(rel);
  }
  return stale;
}

function absolute(root: string, rel: string): string {
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

function fingerprint(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) { return `dir:${st.mtimeMs}`; }
    return createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}
