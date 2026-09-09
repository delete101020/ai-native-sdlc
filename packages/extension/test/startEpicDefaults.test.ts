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

import { isEpicOwnedPipeline, selectablePipelines } from '../src/webview/lib/pipelines';
import type { PipelineSummary } from '../src/webview/lib/types';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

const modal = read('src', 'webview', 'components', 'StartEpicModal.tsx');
const wizard = read('src', 'v2', 'epicWizard.ts');
const builder = read('src', 'webview', 'components', 'BuilderView.tsx');

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
    expect(modal).toContain("pipelines.filter((p) => !p.builtin && !isEpicOwnedPipeline(p))");
  });

  it('never falls back to a pipeline it does not display', () => {
    expect(modal).toContain('const selectable = useMemo(() => selectablePipelines(pipelines)');
    expect(modal).toContain('const first = selectable[0];');
    expect(modal).toContain(
      'const hasWorkflows = selectable.length > 0 || recipes.length > 0;');
  });
});

describe('epic-owned pipelines are hidden wherever a workflow is picked', () => {
  const p = (over: Partial<PipelineSummary> = {}): PipelineSummary =>
    ({ id: 'p', steps: [], on_failure: 'stop', ...over }) as PipelineSummary;

  it('counts a pipeline as epic-owned on either marker', () => {
    expect(isEpicOwnedPipeline(p({ derivedFrom: 'ai-native-full' }))).toBe(true);
    // Epic pipelines written before `derived_from` existed carry only the
    // file they were read from — the reason one marker was not enough.
    expect(isEpicOwnedPipeline(p({ ownedByEpic: 'EPIC-001' }))).toBe(true);
    expect(isEpicOwnedPipeline(p())).toBe(false);
    expect(isEpicOwnedPipeline(p({ builtin: true }))).toBe(false);
  });

  it('leaves built-in and hand-authored workflows selectable', () => {
    const all = [
      p({ id: 'ai-native-full', builtin: true }),
      p({ id: 'my-flow' }),
      p({ id: 'EPIC-001', derivedFrom: 'ai-native-full', ownedByEpic: 'EPIC-001' }),
      p({ id: 'EPIC-002', ownedByEpic: 'EPIC-002' }),
    ];
    expect(selectablePipelines(all).map((x) => x.id)).toEqual(['ai-native-full', 'my-flow']);
  });

  it('the Builder Domain picker filters through the same helper', () => {
    // Same rule, one implementation: the dropdown, its count badge and the
    // tab badge all read the one list BuilderView computes.
    expect(builder).toContain('selectablePipelines(state.pipelines)');
    expect(builder).toContain('{workflows.length} available');
    expect(builder).toContain(
      "{ id: 'workflows', label: 'Workflows', count: visiblePipelines.length }");
  });
});

describe('epic pipelines stay reachable for editing', () => {
  it('hides them by default — the toggle opts in, it does not opt out', () => {
    // `=== true` and not a truthiness test: an absent persisted value has to
    // mean hidden, which is the whole point of the filter.
    expect(builder).toContain(
      "getPersistedUi<PersistedBuilderUi>()?.showEpicPipelines === true");
    expect(builder).toContain(
      'showEpicOwned ? state.pipelines : selectablePipelines(state.pipelines)');
  });

  it('gives the toggle its own dropdown group so the rows stay distinguishable', () => {
    expect(builder).toContain('<optgroup label="Epic pipelines">');
  });

  it('keeps the toggle visible when hiding empties the list', () => {
    // Every pipeline owned by an epic + the filter on = an empty picker with
    // no way back, if the toggle only rendered beside a populated dropdown.
    expect(builder).toContain('<EpicPipelineToggle checked={showEpicOwned}');
    const emptyBranch = builder.slice(builder.lastIndexOf('if (workflows.length === 0)'));
    expect(emptyBranch.slice(0, 400)).toContain('EpicPipelineToggle');
  });

  it('the epic card deep link unhides before it selects', () => {
    const card = read('src', 'webview', 'components', 'EpicCard.tsx');
    expect(card).toContain("postMessage({ type: 'openBuilderPipeline', pipelineId: epic.pipeline })");
    // Landing on the Workflows tab is not enough: the pipeline the user
    // clicked is filtered out until the toggle flips.
    expect(builder).toContain('if (target && isEpicOwnedPipeline(target)) { onToggleEpicOwned(true); }');
    expect(builder).toContain(
      'if (workflows.some((p) => p.id === focusPipeline.id)) { setSelectedId(focusPipeline.id); }');
  });

  it('routes the deep link through the host so the panel switches view first', () => {
    const host = read('src', 'v2', 'workspaceWebview.ts');
    expect(host).toContain("case 'openBuilderPipeline': {");
    expect(host).toContain("postMessage({ type: 'focusPipeline', pipelineId })");
    const shell = read('src', 'webview', 'components', 'WorkspaceShell.tsx');
    // Parked in the shell, not in BuilderView: Builder is not mounted yet when
    // the message lands.
    expect(shell).toContain("msg.type === 'focusPipeline'");
    expect(shell).toContain('<BuilderView state={state} focusPipeline={focusPipeline} />');
  });
});
