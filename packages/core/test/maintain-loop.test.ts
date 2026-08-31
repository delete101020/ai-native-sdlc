/**
 * Stage 6 — maintain, and the loop back to stage 1 (W3).
 *
 * The playbook's claim is that the lifecycle is a loop, not a line: a production
 * signal becomes a diagnosis, and the diagnosis becomes the `intent.md` of a new
 * epic. These tests hold the two halves of that claim — the signal schema, which
 * is the contract every future source fills, and the loop closure, where the new
 * epic starts with a written intent instead of a blank template.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseSignal,
  isSignal,
  SignalParseError,
  followUpEpicId,
  followUpIdFor,
  renderIntentMarkdown,
  openIncidentEpic,
  openFollowUpEpic,
  readEpicSignal,
  SIGNAL_FILE,
  scaffoldEpic,
  type Signal,
  type PipelineConfig,
} from '../src';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-maintain-'));
}

const PIPELINE: PipelineConfig = {
  id: 'ai-native-full',
  on_failure: 'stop',
  steps: [
    { agent: 'aidlc-native-originator', name: 'intent', requires: [], produces: ['intent.md'], depends_on: [], human_review: true, auto_review: false, enabled: true },
    { agent: 'aidlc-native-product-owner', name: 'spec', requires: ['intent.md'], produces: ['spec.md'], depends_on: ['intent'], human_review: true, auto_review: false, enabled: true },
  ],
};

const SIGNAL: Signal = {
  source: 'sentry',
  observedAt: '2026-08-30T02:14:00Z',
  symptom: 'Checkout returns 500 for saved cards',
  scope: '~40 users/hour, EU region only',
  evidence: 'TypeError: cannot read property token of undefined\n  at charge.ts:88',
};

describe('the production signal', () => {
  it('accepts the five fields, from text or object', () => {
    expect(parseSignal(JSON.stringify(SIGNAL))).toEqual(SIGNAL);
    expect(parseSignal(SIGNAL)).toEqual(SIGNAL);
  });

  it('treats evidence as optional — "no data yet" is an honest signal', () => {
    const { evidence, ...withoutEvidence } = SIGNAL;
    expect(parseSignal(withoutEvidence).evidence).toBe('');
  });

  it('reports every missing field at once, not just the first', () => {
    // The caller is usually a webhook or an unattended run: one round-trip
    // should be enough to fix the payload.
    try {
      parseSignal({ source: 'manual' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SignalParseError);
      const msg = (err as Error).message;
      for (const field of ['observedAt', 'symptom', 'scope']) {
        expect(msg).toContain(field);
      }
    }
  });

  it('rejects a blank symptom rather than opening an untitled epic', () => {
    expect(isSignal({ ...SIGNAL, symptom: '   ' })).toBe(false);
    expect(() => parseSignal('not json')).toThrow(SignalParseError);
  });
});

describe('followUpEpicId', () => {
  it('reads as the symptom, so the folder still means something later', () => {
    expect(followUpEpicId(SIGNAL)).toBe('INC-CHECKOUT-RETURNS-500-FOR');
  });

  it('suffixes a recurrence instead of refusing to open it', () => {
    const first = followUpEpicId(SIGNAL);
    expect(followUpEpicId(SIGNAL, { taken: [first] })).toBe(`${first}-2`);
  });

  it('falls back to the prefix when the symptom slugs to nothing', () => {
    expect(followUpEpicId({ ...SIGNAL, symptom: '!!!' }, { prefix: 'ops' })).toBe('OPS');
  });
});

describe('the emitted intent', () => {
  const md = renderIntentMarkdown(SIGNAL, { fromEpicId: 'AID-0007' });

  it('carries the signal forward verbatim', () => {
    expect(md).toContain(SIGNAL.symptom);
    expect(md).toContain(SIGNAL.observedAt);
    expect(md).toContain('charge.ts:88');
    expect(md).toContain('AID-0007');
  });

  it('keeps stage 1 structure so a human reviews it like any other intent', () => {
    for (const heading of ['## 1. Problem', '## 2. Who hurts', '## 3. Cost',
      '## 4. Evidence', '## 5. Done looks like', '## 7. Open questions']) {
      expect(md).toContain(heading);
    }
  });

  it('turns what it does not know into open questions, not prose', () => {
    // Never invent evidence: a gap a human can see gets answered, a fabricated
    // line gets believed.
    expect(md).toContain('Which specific role');
    expect(md).toContain('What observable condition');
    const filled = renderIntentMarkdown(SIGNAL, {
      problem: 'Saved-card checkout fails after the token refresh.',
      whoHurts: 'Returning EU customers paying with a stored card.',
      doneLooksLike: 'Saved-card checkout succeeds for EU customers for a full day.',
    });
    expect(filled).toContain('Returning EU customers');
    expect(filled).not.toContain('Which specific role');
  });

  it('says nothing about how to fix it', () => {
    expect(md).toContain('Repairing the symptom without establishing the cause');
  });
});

describe('scaffoldEpic — seeded artifacts (W3.4)', () => {
  it('lets a seeded artifact replace the blank template', () => {
    const root = tmpRoot();
    const tplDir = path.join(root, '.aidlc', 'aidlc-templates', PIPELINE.id);
    fs.mkdirSync(tplDir, { recursive: true });
    fs.writeFileSync(path.join(tplDir, 'intent.md'), '# Intent — [Title]');
    fs.writeFileSync(path.join(tplDir, 'spec.md'), '# Spec — [Title]');

    const { artifactsDir } = scaffoldEpic({
      workspaceRoot: root, doc: null, epicId: 'INC-1', title: 't', description: 'd',
      target: { kind: 'pipeline', id: PIPELINE.id },
      agents: PIPELINE.steps.map((s) => (s as { agent: string }).agent),
      inputs: {}, pipeline: PIPELINE,
      seedArtifacts: { 'intent.md': '# real intent\n' },
    });

    expect(fs.readFileSync(path.join(artifactsDir, 'intent.md'), 'utf8')).toBe('# real intent\n');
    // Untouched artifacts still come from the templates.
    expect(fs.readFileSync(path.join(artifactsDir, 'spec.md'), 'utf8')).toContain('# Spec');
  });

  it('refuses a seed name that would escape artifacts/', () => {
    const root = tmpRoot();
    const args = {
      workspaceRoot: root, doc: null, title: 't', description: 'd',
      target: { kind: 'pipeline' as const, id: PIPELINE.id },
      agents: ['a'], inputs: {}, pipeline: PIPELINE,
    };
    expect(() => scaffoldEpic({ ...args, epicId: 'E1', seedArtifacts: { '../escaped.md': 'x' } })).toThrow();
    expect(() => scaffoldEpic({ ...args, epicId: 'E2', seedArtifacts: { 'sub/nested.md': 'x' } })).toThrow();
  });
});

describe('the loop closes (W3.5 / W3.7)', () => {
  it('maintain → intent.md → the next epic reads it at stage 1', () => {
    const root = tmpRoot();
    const tplDir = path.join(root, '.aidlc', 'aidlc-templates', PIPELINE.id);
    fs.mkdirSync(tplDir, { recursive: true });
    fs.writeFileSync(path.join(tplDir, 'intent.md'), '# Intent — [Title]');
    fs.writeFileSync(path.join(tplDir, 'spec.md'), '# Spec — [Title]');

    const result = openFollowUpEpic({
      workspaceRoot: root, doc: null, signal: SIGNAL, pipeline: PIPELINE, fromEpicId: 'AID-0007',
    });

    // 1. A new epic exists, named after the symptom.
    expect(result.epicId).toBe('INC-CHECKOUT-RETURNS-500-FOR');
    expect(fs.existsSync(result.epicDir)).toBe(true);

    // 2. Its intent.md is written, not blank — this is what "closing the loop"
    //    means in practice.
    const intent = fs.readFileSync(result.intentPath, 'utf8');
    expect(intent).not.toContain('[Title]');
    expect(intent).toContain(SIGNAL.symptom);

    // 3. The `spec` step's declared input is exactly that file, so the next
    //    phase reads it without any extra wiring.
    const specStep = PIPELINE.steps.find((s) => (s as { name: string }).name === 'spec') as { requires: string[] };
    expect(specStep.requires).toContain('intent.md');
    expect(fs.existsSync(path.join(result.artifactsDir, specStep.requires[0]))).toBe(true);

    // 4. The epic starts at stage 1 behind its human gate, not mid-pipeline.
    expect(result.runState?.currentStepIdx).toBe(0);
    expect(result.runState?.steps[0].agent).toBe('aidlc-native-originator');

    // 5. Provenance is queryable without re-reading the prose.
    const inputs = JSON.parse(fs.readFileSync(path.join(result.epicDir, 'inputs.json'), 'utf8'));
    expect(inputs.from_epic).toBe('AID-0007');
    expect(inputs.signal_source).toBe('sentry');
  });

  it('does not collide when the same symptom comes back', () => {
    const root = tmpRoot();
    const first = openFollowUpEpic({ workspaceRoot: root, doc: null, signal: SIGNAL, pipeline: PIPELINE });
    const second = openFollowUpEpic({ workspaceRoot: root, doc: null, signal: SIGNAL, pipeline: PIPELINE });
    expect(second.epicId).toBe(`${first.epicId}-2`);
    expect(fs.existsSync(second.intentPath)).toBe(true);
  });

  it('refuses to open a follow-up onto a pipeline with no steps', () => {
    const root = tmpRoot();
    expect(() => openFollowUpEpic({
      workspaceRoot: root, doc: null, signal: SIGNAL,
      pipeline: { ...PIPELINE, steps: [] },
    })).toThrow(/no steps/);
  });
});

describe('registering a signal (W4 — the CLI entry point)', () => {
  /**
   * `aidlc maintain --signal <file>` is stage 6's front door: every other stage
   * is entered by a person already looking at the screen, this one by an alert.
   * The engine half of that door is `openIncidentEpic`, and what it must
   * guarantee is that an unattended agent woken by it can find its input.
   */
  const MAINTAIN_PIPELINE: PipelineConfig = {
    id: 'ai-native-incident',
    on_failure: 'stop',
    steps: [
      { agent: 'aidlc-native-operator', name: 'maintain', requires: [], produces: ['incident.md'], depends_on: [], human_review: false, auto_review: false, enabled: true },
    ],
  };

  it('parks the signal where the skill looks for it', () => {
    const root = tmpRoot();
    const result = openIncidentEpic({
      workspaceRoot: root, doc: null, signal: SIGNAL, pipeline: MAINTAIN_PIPELINE,
    });

    // The `native-maintain` skill reads docs/epics/<epic>/signal.json when no
    // path is passed. If that file is not there, the phase has no input at all.
    expect(path.basename(result.signalPath)).toBe(SIGNAL_FILE);
    expect(path.dirname(result.signalPath)).toBe(result.epicDir);
    expect(parseSignal(fs.readFileSync(result.signalPath, 'utf8'))).toEqual(SIGNAL);
  });

  it('reads back round-trip, so follow-up needs only the epic id', () => {
    const root = tmpRoot();
    const { epicId } = openIncidentEpic({
      workspaceRoot: root, doc: null, signal: SIGNAL, pipeline: MAINTAIN_PIPELINE,
    });
    expect(parseSignal(readEpicSignal(root, null, epicId)!)).toEqual(SIGNAL);
    // …and says so plainly rather than inventing one when the epic has none.
    expect(readEpicSignal(root, null, 'AID-0001')).toBeNull();
  });

  it('starts unattended — stage 6 has no human gate to wait behind', () => {
    const root = tmpRoot();
    const result = openIncidentEpic({
      workspaceRoot: root, doc: null, signal: SIGNAL, pipeline: MAINTAIN_PIPELINE,
    });
    expect(result.runState?.steps[0].agent).toBe('aidlc-native-operator');
    const inputs = JSON.parse(fs.readFileSync(path.join(result.epicDir, 'inputs.json'), 'utf8'));
    expect(inputs.signal_symptom).toBe(SIGNAL.symptom);
    expect(inputs.signal_observed_at).toBe(SIGNAL.observedAt);
  });

  it('registers without diagnosing — no follow-up epic appears yet', () => {
    // Whether a signal deserves five stages is the Operator\'s judgment, made
    // against the code. The door that woke it up does not get to decide.
    const root = tmpRoot();
    const result = openIncidentEpic({
      workspaceRoot: root, doc: null, signal: SIGNAL, pipeline: MAINTAIN_PIPELINE,
    });
    const epics = fs.readdirSync(path.dirname(result.epicDir));
    expect(epics).toEqual([result.epicId]);
    expect(fs.existsSync(path.join(result.artifactsDir, 'intent.md'))).toBe(false);
  });

  it('keeps the incident and the work it opened adjacent', () => {
    // These ids are read in a listing, and only there — the pair sorting next to
    // each other is the whole point of deriving rather than re-slugging.
    expect(followUpIdFor('INC-CHECKOUT-RETURNS-500')).toBe('INC-CHECKOUT-RETURNS-500-FIX');
    expect(followUpIdFor('INC-A', ['INC-A-FIX'])).toBe('INC-A-FIX-2');
  });

  it('refuses to register onto a pipeline with no steps', () => {
    expect(() => openIncidentEpic({
      workspaceRoot: tmpRoot(), doc: null, signal: SIGNAL,
      pipeline: { ...MAINTAIN_PIPELINE, steps: [] },
    })).toThrow(/no steps/);
  });
});
