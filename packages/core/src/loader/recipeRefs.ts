/**
 * Keeping `recipes:` in step with the pipeline they draw from.
 *
 * A recipe is a named subset of a pipeline's steps, and it addresses those
 * steps *by id* — the step's `name`, falling back to its `agent`, the same id
 * `depends_on` uses (see {@link stepDagId}). Nothing links the two lists: edit
 * a pipeline's steps and every recipe drawn from it keeps pointing at what
 * used to be there.
 *
 * That gap is silent at edit time. `collectWorkspaceRefIssues` does catch it
 * (`unknown-recipe-step`), but it only runs when a pipeline is assembled — so
 * removing a step in the workspace UI succeeds, and the workspace breaks
 * minutes or days later at `epic start`, pointing at a recipe the user never
 * touched. These helpers let the edit itself carry the recipes along, and
 * report what they changed so the UI can say so.
 *
 * They take the raw YAML document rather than a validated `WorkspaceConfig`,
 * because that is what an in-progress edit has: the webview mutates the parsed
 * document in place and writes it back.
 */

/** Minimal shape these helpers need — satisfied by the raw parsed document. */
export interface RecipeCarrier {
  pipelines: Array<Record<string, unknown>>;
  recipes?: unknown;
}

/** What one recipe lost when a pipeline edit was carried into it. */
export interface RecipeRefEdit {
  recipeId: string;
  /** Step ids dropped from `steps`. */
  steps: string[];
  /** Step ids whose `gates` override was dropped. */
  gates: string[];
  /**
   * The recipe itself was removed. A recipe is a *subset* of a pipeline, and
   * the schema requires at least one step: when the edit takes its last one
   * there is no recipe left to keep, and leaving `steps: []` behind would
   * fail the whole workspace to load rather than one epic to start.
   */
  removed: boolean;
}

function recipeList(doc: RecipeCarrier): Array<Record<string, unknown>> {
  return Array.isArray(doc.recipes) ? (doc.recipes as Array<Record<string, unknown>>) : [];
}

function stepIds(recipe: Record<string, unknown>): string[] {
  return Array.isArray(recipe.steps) ? recipe.steps.map(String) : [];
}

/**
 * The recipes that draw from `pipelineId`.
 *
 * A recipe with no `from` falls back to the workspace's *first* pipeline —
 * `collectWorkspaceRefIssues` and `assemblePipeline` both resolve it that way,
 * so an edit to that pipeline has to reach those recipes too, or the repair
 * misses exactly the recipes a single-pipeline workspace has.
 */
export function recipesDrawingFrom(
  doc: RecipeCarrier,
  pipelineId: string,
): Array<Record<string, unknown>> {
  const firstPipelineId = doc.pipelines.length > 0 ? String(doc.pipelines[0].id ?? '') : '';
  return recipeList(doc).filter((r) => {
    const from = typeof r.from === 'string' && r.from ? r.from : '';
    return from ? from === pipelineId : firstPipelineId === pipelineId;
  });
}

function emptyEdit(recipe: Record<string, unknown>): RecipeRefEdit {
  return { recipeId: String(recipe.id ?? ''), steps: [], gates: [], removed: false };
}

function dropGate(recipe: Record<string, unknown>, stepId: string): boolean {
  const gates = recipe.gates;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) { return false; }
  const map = gates as Record<string, unknown>;
  if (!(stepId in map)) { return false; }
  delete map[stepId];
  // An empty `gates:` is noise in the dump — the recipe simply inherits.
  if (Object.keys(map).length === 0) { delete recipe.gates; }
  return true;
}

/**
 * Carry a step deletion into every recipe drawing from `pipelineId`: drop the
 * step from `steps` and its entry from `gates`. A recipe left with no steps at
 * all is removed outright — see {@link RecipeRefEdit.removed}.
 *
 * Mutates `doc` in place. Returns one entry per recipe actually changed, so a
 * caller can report the edit it made on the user's behalf; an empty array
 * means no recipe referenced the step.
 */
export function dropRecipeStep(
  doc: RecipeCarrier,
  pipelineId: string,
  stepId: string,
): RecipeRefEdit[] {
  const edits: RecipeRefEdit[] = [];
  const emptied: Array<Record<string, unknown>> = [];

  for (const recipe of recipesDrawingFrom(doc, pipelineId)) {
    const edit = emptyEdit(recipe);
    const steps = stepIds(recipe);
    if (steps.includes(stepId)) {
      const kept = steps.filter((s) => s !== stepId);
      edit.steps.push(stepId);
      if (kept.length === 0) {
        edit.removed = true;
        emptied.push(recipe);
      } else {
        recipe.steps = kept;
      }
    }
    // A gate on a step the recipe no longer runs is `unknown-recipe-gate`, so
    // it follows the step out whether or not `steps` listed it.
    if (dropGate(recipe, stepId)) { edit.gates.push(stepId); }
    if (edit.steps.length > 0 || edit.gates.length > 0) { edits.push(edit); }
  }

  if (emptied.length > 0) {
    doc.recipes = recipeList(doc).filter((r) => !emptied.includes(r));
  }
  return edits;
}

/**
 * Carry a pipeline deletion into `recipes:`. A recipe whose `from` named that
 * pipeline has no source left (`unknown-recipe-source`) and cannot assemble,
 * so it goes with it. Recipes that relied on the first-pipeline fallback are
 * left alone: they re-point at whatever pipeline is now first, which is what
 * the fallback means — their step lists are then the new source pipeline's
 * business, and edit-time validation reports whatever no longer resolves.
 *
 * Mutates `doc` in place. Returns the ids of the recipes removed.
 */
export function dropRecipesForPipeline(doc: RecipeCarrier, pipelineId: string): string[] {
  const doomed = recipeList(doc).filter((r) => r.from === pipelineId);
  if (doomed.length === 0) { return []; }
  doc.recipes = recipeList(doc).filter((r) => !doomed.includes(r));
  return doomed.map((r) => String(r.id ?? ''));
}
