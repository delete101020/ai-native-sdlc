/**
 * What "Start epic" puts in the epic *before the user types anything* is state
 * they cannot correct later: capability inputs are captured at scaffold time
 * and no command edits them afterwards. A pre-filled `docs/core` therefore
 * shipped a path that does not exist in most repos into every epic's
 * `inputs.json`, where it became half the agent's prompt.
 *
 * Both front doors (the webview modal and the command-palette wizard) carry
 * their own copy of the prompt table, so both are asserted here.
 */
import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const modal = read('src', 'webview', 'components', 'StartEpicModal.tsx');
const wizard = read('src', 'v2', 'epicWizard.ts');

describe('start epic — nothing is pre-filled for the user', () => {
  it('offers no capability input a default value, in either front door', () => {
    // `placeholder` is fine — it shows the shape without submitting a value.
    expect(modal).not.toContain('defaultValue');
    expect(wizard).not.toContain('defaultValue');
  });
});

describe('start epic — modal layout', () => {
  it('starts capability inputs folded', () => {
    expect(modal).toContain('const [capsOpen, setCapsOpen] = useState(false);');
    // Folding must never hide that values are set.
    expect(modal).toContain("filled");
  });

  it('lists recipes most-steps-first rather than in source order', () => {
    expect(modal).toContain('[...recipes].sort((a, b) => b.steps.length - a.steps.length)');
    expect(modal).toContain('{sortedRecipes.map((r) => (');
  });
});

describe('start epic — the workflow picker offers only reusable workflows', () => {
  it('hides pipelines assembled for a single epic', () => {
    // Assembled pipelines are named after their epic and carry `derived_from`;
    // without this filter "Your pipelines" grew one dead row per epic started.
    expect(modal).toContain("pipelines.filter((p) => !p.builtin && !p.derivedFrom)");
  });

  it('never falls back to a pipeline it does not display', () => {
    expect(modal).toContain("pipelines.filter((p) => !p.derivedFrom)");
    expect(modal).toContain('const first = selectablePipelines[0];');
    expect(modal).toContain(
      'const hasWorkflows = selectablePipelines.length > 0 || recipes.length > 0;');
  });
});
