/**
 * Carrying an id rename through everything that points at it.
 *
 * `workspace.yaml` is a graph held together by strings. An agent id is written
 * down in at least four other places — a pipeline step's `agent`, a slash
 * command's `agent`, and, for a step with no `name` of its own, every
 * `depends_on` entry and every recipe `steps` / `gates` key that addresses that
 * step (its DAG id *is* the agent id, see `stepDagId`). A skill id is written
 * down in `agents[].skills` and in each step's own `skills` override.
 *
 * Renaming the definition alone leaves all of those pointing at a name that no
 * longer exists. Nothing fails at edit time: the workspace still parses, the
 * panel still renders, and the break surfaces at `epic start` — pointing at a
 * pipeline or recipe the user never touched. This is the same class of bug as
 * `recipeRefs`, from the other direction, and these helpers close it the same
 * way: the edit carries its references along and reports what it moved.
 *
 * Like `recipeRefs`, they take the raw parsed document rather than a validated
 * `WorkspaceConfig` — that is what an in-progress edit has — and mutate in
 * place.
 */

import { recipesDrawingFrom, type RecipeCarrier } from './recipeRefs';

/** Minimal shape these helpers need — satisfied by the raw parsed document. */
export interface WorkspaceRefCarrier {
  agents?: unknown;
  pipelines?: unknown;
  recipes?: unknown;
  slash_commands?: unknown;
}

/** What a rename moved, for a UI that has to say so. */
export interface IdRenameEdit {
  /** Dotted locations re-pointed, e.g. `pipelines.cr-squad.steps.cr-test.agent`. */
  paths: string[];
  /**
   * Steps whose DAG id changed along with the agent id, because they carry no
   * `name` of their own. These are the ones that drag `depends_on` and recipe
   * step lists with them — the half of an agent rename nobody expects.
   */
  renamedStepIds: string[];
}

function list(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map(String) : null;
}

/** The DAG id of a raw step object: its `name`, falling back to its `agent`. */
function dagIdOf(step: Record<string, unknown>): string {
  return typeof step.name === 'string' && step.name.trim() ? step.name : String(step.agent ?? '');
}

/**
 * Replace `oldId` with `newId` in a skill list, in either the array (`skills:`)
 * or the legacy singular (`skill:`) form. Returns true if it moved.
 */
function renameSkillOn(obj: Record<string, unknown>, oldId: string, newId: string): boolean {
  let moved = false;
  const arr = strings(obj.skills);
  if (arr && arr.includes(oldId)) {
    obj.skills = arr.map((s) => (s === oldId ? newId : s));
    moved = true;
  }
  // Legacy `skill: <id>`. Normalized away at load, but still on disk in any
  // workspace written before `skills:` existed, and a rename that skipped it
  // would break exactly the oldest files.
  if (typeof obj.skill === 'string' && obj.skill === oldId) {
    obj.skill = newId;
    moved = true;
  }
  return moved;
}

/** Skill ids a raw agent or step declares, in either form. */
function declaredSkills(obj: Record<string, unknown>): string[] {
  return strings(obj.skills) ?? (typeof obj.skill === 'string' ? [obj.skill] : []);
}

/**
 * Re-point every reference to an agent after its `id` changed.
 *
 * Mutates `doc` in place; the agent's own `id` is the caller's to set. Returns
 * what moved — an empty `paths` means nothing referenced the agent.
 */
export function renameAgentRefs(
  doc: WorkspaceRefCarrier,
  oldId: string,
  newId: string,
): IdRenameEdit {
  const edit: IdRenameEdit = { paths: [], renamedStepIds: [] };
  if (!oldId || !newId || oldId === newId) { return edit; }

  for (const pipeline of list(doc.pipelines)) {
    const pipelineId = String(pipeline.id ?? '');
    const steps = pipeline.steps;
    if (!Array.isArray(steps)) { continue; }

    // Does this pipeline hold an *unnamed* step on the renamed agent? Then the
    // step's DAG id moves too, and `depends_on` / recipes have to follow.
    let dagIdMoved = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // Legacy bare-string step: the string *is* the agent id.
      if (typeof step === 'string') {
        if (step === oldId) {
          steps[i] = newId;
          dagIdMoved = true;
          edit.paths.push(`pipelines.${pipelineId}.steps.${oldId}`);
        }
        continue;
      }
      if (!step || typeof step !== 'object') { continue; }
      const obj = step as Record<string, unknown>;
      if (obj.agent !== oldId) { continue; }
      obj.agent = newId;
      const named = typeof obj.name === 'string' && obj.name.trim() !== '';
      edit.paths.push(`pipelines.${pipelineId}.steps.${named ? String(obj.name) : oldId}.agent`);
      if (!named) { dagIdMoved = true; }
    }

    if (!dagIdMoved) { continue; }
    edit.renamedStepIds.push(oldId);

    // `depends_on` is pipeline-local and addresses steps by DAG id, so only
    // this pipeline's entries move — the same id in another pipeline means a
    // different step there.
    for (const step of steps) {
      if (!step || typeof step !== 'object') { continue; }
      const obj = step as Record<string, unknown>;
      const deps = strings(obj.depends_on);
      if (!deps || !deps.includes(oldId)) { continue; }
      obj.depends_on = deps.map((d) => (d === oldId ? newId : d));
      edit.paths.push(`pipelines.${pipelineId}.steps.${dagIdOf(obj)}.depends_on`);
    }

    // Recipes address the same DAG id, and a recipe drawn from this pipeline
    // that keeps the old one is `unknown-recipe-step` at the next epic start.
    for (const recipe of recipesDrawingFrom(doc as unknown as RecipeCarrier, pipelineId)) {
      const recipeId = String(recipe.id ?? '');
      const recipeSteps = strings(recipe.steps);
      if (recipeSteps && recipeSteps.includes(oldId)) {
        recipe.steps = recipeSteps.map((s) => (s === oldId ? newId : s));
        edit.paths.push(`recipes.${recipeId}.steps`);
      }
      const gates = recipe.gates;
      if (gates && typeof gates === 'object' && !Array.isArray(gates)) {
        const map = gates as Record<string, unknown>;
        if (oldId in map) {
          map[newId] = map[oldId];
          delete map[oldId];
          edit.paths.push(`recipes.${recipeId}.gates.${oldId}`);
        }
      }
    }
  }

  for (const cmd of list(doc.slash_commands)) {
    if (cmd.agent === oldId) {
      cmd.agent = newId;
      edit.paths.push(`slash_commands.${String(cmd.name ?? '')}.agent`);
    }
  }

  return edit;
}

/**
 * Re-point every reference to a skill after its `id` changed: the agents that
 * declare it and the steps that narrow to it.
 *
 * Mutates `doc` in place; the skill's own `id` is the caller's to set.
 */
export function renameSkillRefs(
  doc: WorkspaceRefCarrier,
  oldId: string,
  newId: string,
): IdRenameEdit {
  const edit: IdRenameEdit = { paths: [], renamedStepIds: [] };
  if (!oldId || !newId || oldId === newId) { return edit; }

  for (const agent of list(doc.agents)) {
    if (renameSkillOn(agent, oldId, newId)) {
      edit.paths.push(`agents.${String(agent.id ?? '')}.skills`);
    }
  }

  for (const pipeline of list(doc.pipelines)) {
    const pipelineId = String(pipeline.id ?? '');
    for (const step of Array.isArray(pipeline.steps) ? pipeline.steps : []) {
      if (!step || typeof step !== 'object') { continue; }
      const obj = step as Record<string, unknown>;
      if (!renameSkillOn(obj, oldId, newId)) { continue; }
      edit.paths.push(`pipelines.${pipelineId}.steps.${dagIdOf(obj)}.skills`);
    }
  }

  return edit;
}

/** What still points at a definition that is about to be deleted. */
export interface DanglingRefs {
  /** Dotted locations that would be left pointing at nothing. */
  paths: string[];
  /** Ready-to-print lines, one per location. */
  messages: string[];
}

/**
 * What would still reference `id` if the agent were deleted.
 *
 * Unlike a rename, a delete has no target to re-point at, and nothing here
 * guesses one: a step whose agent is gone is a step the user has to re-assign
 * or remove, and silently dropping either would reshape a pipeline behind
 * their back. So this reports and never mutates — the caller says what will
 * break, and the user decides.
 */
export function agentReferences(doc: WorkspaceRefCarrier, id: string): DanglingRefs {
  const out: DanglingRefs = { paths: [], messages: [] };
  if (!id) { return out; }

  for (const pipeline of list(doc.pipelines)) {
    const pipelineId = String(pipeline.id ?? '');
    for (const step of Array.isArray(pipeline.steps) ? pipeline.steps : []) {
      const isObj = Boolean(step) && typeof step === 'object';
      const agent = typeof step === 'string' ? step : (step as Record<string, unknown>)?.agent;
      if (agent !== id) { continue; }
      const name = isObj ? dagIdOf(step as Record<string, unknown>) : id;
      out.paths.push(`pipelines.${pipelineId}.steps.${name}`);
      out.messages.push(`Pipeline "${pipelineId}" step "${name}" still runs agent "${id}".`);
    }
  }

  for (const cmd of list(doc.slash_commands)) {
    if (cmd.agent !== id) { continue; }
    const name = String(cmd.name ?? '');
    out.paths.push(`slash_commands.${name}.agent`);
    out.messages.push(`Slash command "${name}" still targets agent "${id}".`);
  }

  return out;
}

/** What would still reference `id` if the skill were deleted. */
export function skillReferences(doc: WorkspaceRefCarrier, id: string): DanglingRefs {
  const out: DanglingRefs = { paths: [], messages: [] };
  if (!id) { return out; }

  for (const agent of list(doc.agents)) {
    const declared = declaredSkills(agent);
    if (!declared.includes(id)) { continue; }
    const agentId = String(agent.id ?? '');
    out.paths.push(`agents.${agentId}.skills`);
    // The schema requires at least one skill per agent, so this is not merely
    // a dangling reference — taking the last one out fails the whole file to
    // load, which is why nothing here prunes on the user's behalf.
    out.messages.push(
      declared.length === 1
        ? `Agent "${agentId}" declares "${id}" as its only skill — it needs another before this one goes.`
        : `Agent "${agentId}" declares skill "${id}".`,
    );
  }

  for (const pipeline of list(doc.pipelines)) {
    const pipelineId = String(pipeline.id ?? '');
    for (const step of Array.isArray(pipeline.steps) ? pipeline.steps : []) {
      if (!step || typeof step !== 'object') { continue; }
      const obj = step as Record<string, unknown>;
      if (!declaredSkills(obj).includes(id)) { continue; }
      out.paths.push(`pipelines.${pipelineId}.steps.${dagIdOf(obj)}.skills`);
      out.messages.push(`Pipeline "${pipelineId}" step "${dagIdOf(obj)}" narrows to skill "${id}".`);
    }
  }

  return out;
}

/** An agent no pipeline reaches any more, with what came with it. */
export interface UnusedAgent {
  /** The agent id, or null when some step still runs it. */
  agent: string | null;
  /** Slash commands that now reach nothing a pipeline runs. */
  slashCommands: string[];
  /** Skills the agent declares, which may now be reached by nothing else. */
  skills: string[];
}

/**
 * What a removed step leaves *unused* — as opposed to dangling.
 *
 * Deleting the last step that ran an agent breaks nothing: the agent is still
 * defined, its skills still exist, its slash commands still resolve. They are
 * simply no longer reached from any pipeline, which is why this reports and
 * never prunes — an agent unused by one pipeline is routinely used by the next
 * epic, by a recipe, or by a person typing its slash command. Saying so is the
 * difference between a workspace that quietly accumulates dead wiring and one
 * whose owner chose to keep it.
 *
 * Call it *after* the step has been spliced out.
 */
export function unusedAfterStepRemoval(
  doc: WorkspaceRefCarrier,
  agentId: string,
): UnusedAgent {
  const none: UnusedAgent = { agent: null, slashCommands: [], skills: [] };
  if (!agentId) { return none; }

  for (const pipeline of list(doc.pipelines)) {
    for (const step of Array.isArray(pipeline.steps) ? pipeline.steps : []) {
      const agent = typeof step === 'string' ? step : (step as Record<string, unknown>)?.agent;
      if (agent === agentId) { return none; }
    }
  }

  const agent = list(doc.agents).find((a) => a.id === agentId);
  return {
    agent: agentId,
    slashCommands: list(doc.slash_commands)
      .filter((c) => c.agent === agentId)
      .map((c) => String(c.name ?? '')),
    skills: agent ? declaredSkills(agent) : [],
  };
}
