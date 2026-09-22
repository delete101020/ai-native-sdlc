import { describe, it, expect } from 'vitest';

import { dropRecipeStep, dropRecipesForPipeline, recipesDrawingFrom } from '../src';

/**
 * The shape the webview mutates: the raw parsed workspace.yaml, not a
 * validated config.
 */
function doc(): {
  pipelines: Array<Record<string, unknown>>;
  recipes: Array<Record<string, unknown>>;
} {
  return {
    pipelines: [
      {
        id: 'cr-squad',
        steps: [
          { agent: 'ba', name: 'cr-intake' },
          { agent: 'qc', name: 'cr-test-scenarios', depends_on: ['cr-intake'] },
          { agent: 'qc', name: 'cr-test', depends_on: ['cr-test-scenarios'] },
          { agent: 'dev', name: 'cr-close', depends_on: ['cr-test'] },
        ],
      },
      { id: 'other', steps: [{ agent: 'ba', name: 'x' }] },
    ],
    recipes: [
      {
        id: 'cr-full',
        from: 'cr-squad',
        steps: ['cr-intake', 'cr-test-scenarios', 'cr-test', 'cr-close'],
        gates: { 'cr-test': { human_review: true }, 'cr-close': { human_review: false } },
      },
      { id: 'cr-small', from: 'cr-squad', steps: ['cr-intake', 'cr-close'] },
      { id: 'elsewhere', from: 'other', steps: ['x'] },
    ],
  };
}

describe('recipesDrawingFrom', () => {
  it('matches on `from`', () => {
    expect(recipesDrawingFrom(doc(), 'cr-squad').map((r) => r.id)).toEqual(['cr-full', 'cr-small']);
  });

  it('treats a recipe with no `from` as drawing from the first pipeline', () => {
    const d = doc();
    d.recipes = [{ id: 'default', steps: ['cr-intake'] }];
    expect(recipesDrawingFrom(d, 'cr-squad').map((r) => r.id)).toEqual(['default']);
    // …and only the first: the fallback is positional, not "any pipeline".
    expect(recipesDrawingFrom(d, 'other')).toEqual([]);
  });
});

describe('dropRecipeStep — a removed step leaves no recipe pointing at it', () => {
  it('drops the step from every recipe drawn from that pipeline', () => {
    const d = doc();
    const edits = dropRecipeStep(d, 'cr-squad', 'cr-test');

    expect(d.recipes.find((r) => r.id === 'cr-full')!.steps)
      .toEqual(['cr-intake', 'cr-test-scenarios', 'cr-close']);
    // The gate override follows the step out — otherwise it is
    // `unknown-recipe-gate` at assemble time.
    expect(d.recipes.find((r) => r.id === 'cr-full')!.gates)
      .toEqual({ 'cr-close': { human_review: false } });
    expect(edits).toEqual([{ recipeId: 'cr-full', steps: ['cr-test'], gates: ['cr-test'], removed: false }]);
  });

  it('leaves recipes drawn from another pipeline alone', () => {
    const d = doc();
    dropRecipeStep(d, 'cr-squad', 'cr-intake');
    expect(d.recipes.find((r) => r.id === 'elsewhere')!.steps).toEqual(['x']);
  });

  it('reports nothing when no recipe ran the step', () => {
    const d = doc();
    expect(dropRecipeStep(d, 'cr-squad', 'never-listed')).toEqual([]);
    expect(d.recipes).toHaveLength(3);
  });

  it('removes a recipe whose last step is the one going away', () => {
    const d = doc();
    d.recipes = [{ id: 'solo', from: 'cr-squad', steps: ['cr-test'] }];
    const edits = dropRecipeStep(d, 'cr-squad', 'cr-test');
    // `steps: []` fails the schema, which would break loading the whole
    // workspace — a strictly worse outcome than the dangling ref.
    expect(d.recipes).toEqual([]);
    expect(edits).toEqual([{ recipeId: 'solo', steps: ['cr-test'], gates: [], removed: true }]);
  });

  it('drops an orphaned gate even when `steps` never listed the step', () => {
    const d = doc();
    d.recipes = [{ id: 'g', from: 'cr-squad', steps: ['cr-intake'], gates: { 'cr-test': { auto_review: true } } }];
    const edits = dropRecipeStep(d, 'cr-squad', 'cr-test');
    expect(d.recipes[0].gates).toBeUndefined();
    expect(edits[0]).toMatchObject({ recipeId: 'g', steps: [], gates: ['cr-test'] });
  });
});

describe('dropRecipesForPipeline', () => {
  it('takes the recipes that drew from the deleted pipeline', () => {
    const d = doc();
    expect(dropRecipesForPipeline(d, 'cr-squad')).toEqual(['cr-full', 'cr-small']);
    expect(d.recipes.map((r) => r.id)).toEqual(['elsewhere']);
  });

  it('leaves `from`-less recipes to re-point at the new first pipeline', () => {
    const d = doc();
    d.recipes = [{ id: 'default', steps: ['cr-intake'] }];
    expect(dropRecipesForPipeline(d, 'cr-squad')).toEqual([]);
    expect(d.recipes).toHaveLength(1);
  });
});
