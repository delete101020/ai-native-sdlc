import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import * as fs from 'fs';
import * as path from 'path';
import {
  validateWorkspace,
  collectWorkspaceRefIssues,
  assemblePipeline,
  planEpicPipelineExtraction,
  stageEpicPipeline,
  recipePipelineId,
  PipelineAssembleError,
  heuristicClassify,
  scaffoldEpic,
  EpicScaffoldError,
  epicsRoot,
  epicStrictMode,
  STRICT_MODE_KEY,
  stepAgentId,
  RunStateStore,
  planAddEpicStep,
  planRemoveEpicStep,
  planSetEpicStepGates,
  describeGateEffect,
  commitEpicStepEdit,
  EpicStepEditError,
  stepIdentity,
  type PipelineConfig,
  type EpicStepEditPlan,
  type EpicStepGatePlan,
  type RunState,
} from '@aidlc/core';
import { resolveWorkspaceRoot } from '../workspaceRoot';
import { readYaml, requireYaml, writeYaml, existingIds } from '../yamlIO';
import { listEpics, loadEpic, type EpicStatus, type EpicSummary } from '../epicsList';
import { classifyWithLlm } from './pipeline';

export function registerEpic(program: Command): void {
  const cmd = program
    .command('epic')
    .description('List + inspect epics from <state.root>/<id>/state.json (mirrors the extension)');

  // ── list ───────────────────────────────────────────────────────────────────
  cmd
    .command('list')
    .description('List all epics found under workspace state.root (default: docs/epics/)')
    .option('--json', 'Output raw JSON')
    .option('--status <status>', 'Filter by status (pending | in_progress | done | failed)')
    .action((opts: { json?: boolean; status?: string }, actionCmd: Command) => {
      const root = resolveWorkspaceRoot(actionCmd);
      const doc  = readYaml(root);
      let epics  = listEpics(root, doc);

      if (opts.status) {
        epics = epics.filter(e => e.status === opts.status);
      }

      if (opts.json) {
        console.log(JSON.stringify(epics, null, 2));
        return;
      }

      if (epics.length === 0) {
        console.log(chalk.dim('No epics found.'));
        console.log(chalk.dim(`  state.root = ${doc?.state ? (doc.state as Record<string, unknown>).root ?? 'docs/epics' : 'docs/epics'}`));
        return;
      }

      const table = new Table({
        head: [chalk.bold('Epic'), chalk.bold('Title'), chalk.bold('Progress'), chalk.bold('Status'), chalk.bold('Pipeline')],
        style: { head: [], border: [] },
      });

      for (const epic of epics) {
        const total = epic.stepDetails.length;
        const done  = epic.stepDetails.filter(s => s.status === 'done').length;
        const pct   = total ? Math.round((done / total) * 100) : 0;
        const stepLabel = total ? `${done}/${total} (${pct}%)` : '—';

        table.push([
          chalk.bold(epic.id),
          truncate(epic.title || chalk.dim('(untitled)'), 40),
          stepLabel,
          colorEpicStatus(epic.status),
          chalk.dim(epic.pipeline ?? '—'),
        ]);
      }

      console.log(table.toString());
      console.log(chalk.dim(`\n${epics.length} epic${epics.length !== 1 ? 's' : ''}`));
    });

  // ── status / show ──────────────────────────────────────────────────────────
  cmd
    .command('status <id>')
    .alias('show')
    .description('Show full status of one epic — step pipeline, inputs, paths')
    .option('--json', 'Output raw EpicSummary JSON')
    .action((id: string, opts: { json?: boolean }, actionCmd: Command) => {
      const root  = resolveWorkspaceRoot(actionCmd);
      const doc   = readYaml(root);
      const epic  = loadEpic(root, doc, id);

      if (!epic) {
        const all = listEpics(root, doc).map(e => e.id);
        console.error(chalk.red(`Epic "${id}" not found.`));
        if (all.length > 0) {
          console.error(chalk.dim(`Available: ${all.join(', ')}`));
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(epic, null, 2));
        return;
      }

      printEpicDetail(epic);
    });

  // ── start ────────────────────────────────────────────────────────────────────
  cmd
    .command('start <epicId>')
    .description('Scaffold a new epic on disk (folder + artifacts + run state) — mirrors the extension\'s "Start epic"')
    .option('--recipe <id>', 'assemble a right-sized pipeline from this recipe')
    .option('--pipeline <id>', 'use an existing pipeline as-is')
    .option('--brief <text...>', 'classify this requirement brief into a recipe, then assemble')
    .option('--llm', 'use the `claude` CLI to classify --brief (falls back to heuristic)')
    .option('--from <pipelineId>', 'override the recipe\'s source pipeline')
    .option('--title <title>', 'epic title')
    .option('--desc <description>', 'epic description / requirement snapshot')
    .option('--input <kv>', 'capability input as key=value (repeatable)', collectKv, [] as string[])
    .option('--no-strict', 'work to the size of this epic — no invented NFR / risk / alternatives sections')
    .action((epicId: string, opts: {
      recipe?: string; pipeline?: string; brief?: string[]; llm?: boolean;
      from?: string; title?: string; desc?: string; input: string[]; strict: boolean;
    }, actionCmd: Command) => {
      const root = resolveWorkspaceRoot(actionCmd);
      const doc  = requireYaml(root);

      const modes = [opts.recipe, opts.pipeline, opts.brief?.length ? 'brief' : undefined]
        .filter(Boolean).length;
      if (modes !== 1) {
        console.error(chalk.red('Pick exactly one of --recipe <id>, --pipeline <id>, or --brief <text>.'));
        process.exit(1);
      }

      let config;
      try {
        config = validateWorkspace(doc, '.aidlc/workspace.yaml');
      } catch (err) {
        console.error(chalk.red('workspace.yaml is invalid — fix it before starting an epic:'));
        console.error(chalk.dim(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Resolve the target pipeline — either an existing one, or one assembled
      // from a recipe (chosen directly or via classification) and written back.
      let pipelineCfg: PipelineConfig;
      if (opts.pipeline) {
        const found = (doc.pipelines as Array<Record<string, unknown>>)
          .find((p) => String(p.id) === opts.pipeline);
        if (!found) {
          console.error(chalk.red(`Pipeline "${opts.pipeline}" not found in workspace.yaml.`));
          process.exit(1);
        }
        pipelineCfg = found as unknown as PipelineConfig;
      } else {
        if (config.recipes.length === 0) {
          console.error(chalk.red('No recipes defined — task-type suggestion needs them.'));
          console.error(chalk.dim('  Back-fill from your existing pipeline: aidlc recipe init'));
          console.error(chalk.dim('  Or apply the preset that ships them:    aidlc preset apply sdlc'));
          process.exit(1);
        }
        let recipeId = opts.recipe;
        if (!recipeId) {
          const brief = (opts.brief ?? []).join(' ').trim();
          // Instant heuristic first (provisional), then refine with the LLM —
          // same two-stage flow the extension uses for fast feedback.
          const heur = heuristicClassify(brief, config.recipes);
          let verdict = heur;
          if (opts.llm) {
            console.log(chalk.dim(`Provisional → ${heur.recipeId} (${heur.confidence}, heuristic) — refining with claude…`));
            verdict = classifyWithLlm(brief, config.recipes) ?? heur;
          }
          recipeId = verdict.recipeId;
          console.log(chalk.dim(`Classified → ${chalk.bold(recipeId)} (${verdict.confidence}, ${verdict.source})`));
        }
        if (opts.from) {
          const recipe = config.recipes.find((r) => r.id === recipeId);
          if (recipe) { recipe.from = opts.from; }
        }
        const pipelineId = recipePipelineId({ recipeId, epicId, taken: existingIds(doc.pipelines) });
        try {
          pipelineCfg = assemblePipeline(config, { recipeId, pipelineId });
        } catch (err) {
          if (err instanceof PipelineAssembleError) {
            console.error(chalk.red('Could not assemble pipeline: ') + chalk.dim(err.message));
            process.exit(1);
          }
          throw err;
        }
        doc.pipelines.push(pipelineCfg as unknown as Record<string, unknown>);
        // The epic owns this pipeline: keep it in the epic's own file so two
        // people starting epics never collide on one append point in workspace.yaml.
        stageEpicPipeline(doc, pipelineCfg.id, epicId);
        try {
          validateWorkspace(doc, '.aidlc/workspace.yaml');
        } catch (err) {
          console.error(chalk.red('Assembled pipeline failed validation — not written:'));
          console.error(chalk.dim(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
        writeYaml(root, doc);
        console.log(chalk.dim(`Assembled pipeline ${chalk.bold(pipelineCfg.id)} from recipe ${chalk.bold(recipeId)}`));
      }

      const agents = Array.isArray(pipelineCfg.steps)
        ? (pipelineCfg.steps as unknown[]).map(stepAgentId)
        : [];

      const inputs: Record<string, string> = {};
      for (const kv of opts.input) {
        const eq = kv.indexOf('=');
        if (eq > 0) { inputs[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim(); }
      }

      try {
        const { epicDir } = scaffoldEpic({
          workspaceRoot: root,
          doc,
          epicId,
          title: opts.title?.trim() ?? '',
          description: opts.desc?.trim() ?? '',
          target: { kind: 'pipeline', id: pipelineCfg.id },
          agents,
          inputs,
          pipeline: pipelineCfg,
          strictMode: opts.strict,
        });
        const steps = agents.join(' → ');
        console.log(chalk.green('✔') + ` Started epic ${chalk.bold(epicId)}`);
        console.log(chalk.dim(`  Pipeline: ${pipelineCfg.id}`));
        console.log(chalk.dim(`  Steps:    ${steps}`));
        console.log(chalk.dim(`  Dir:      ${epicDir}`));
        if (!opts.strict) {
          console.log(chalk.dim('  Depth:    strict_mode: false — phases stay proportional to the work'));
        }

        // Resolve the slash command Claude actually has for the first step.
        // Commands are registered in workspace.yaml `slash_commands` and
        // namespaced to the *source* pipeline (e.g. `/sdlc-parallel-full-implement`),
        // not the per-epic pipeline — so we can't just print `/<agent>`. Match
        // by the step's DAG name + agent, falling back to a bare `/<name>`.
        const firstStep = (Array.isArray(pipelineCfg.steps) ? pipelineCfg.steps[0] : undefined) as
          { name?: string; agent?: string } | undefined;
        const firstName = firstStep?.name ?? firstStep?.agent ?? agents[0];
        const slashCmds = (Array.isArray(doc.slash_commands) ? doc.slash_commands : []) as
          Array<{ name?: string; agent?: string }>;
        const match = slashCmds.find(
          (c) => typeof c.name === 'string' && c.name.endsWith(`-${firstName}`) && c.agent === agents[0],
        ) ?? slashCmds.find((c) => typeof c.name === 'string' && c.name.endsWith(`-${firstName}`));
        const runCmd = match?.name ?? `/${firstName}`;
        console.log(`\nRun ${chalk.cyan(`${runCmd} ${epicId}`)} in Claude to begin.`);
      } catch (err) {
        if (err instanceof EpicScaffoldError) {
          console.error(chalk.red(err.message));
          process.exit(1);
        }
        throw err;
      }
    });

  // ── step add / remove ──────────────────────────────────────────────────────
  //
  // The supported way to reshape a *running* epic. The Pipelines view refuses
  // Add/Delete/Reorder while an epic owns a pipeline because those move the
  // step definitions and leave the run's history where it was; these two move
  // both together, and refuse the edits that cannot be made coherently at all.
  // ── pipeline extract ───────────────────────────────────────────────────────
  //
  // The one-time move for workspaces started before epics owned their own
  // pipeline file. It is not automatic: relocating a definition an epic's run
  // depends on is the kind of thing that should happen when someone asks for
  // it, in its own commit, not as a side effect of the next unrelated write.
  const pipelineCmd = cmd
    .command('pipeline')
    .description('Move epic-owned pipelines out of the shared workspace.yaml');

  pipelineCmd
    .command('extract')
    .description(
      "Move each epic's pipeline out of .aidlc/workspace.yaml into\n" +
      "  <state.root>/<epic>/pipeline.yaml. Only pipelines an epic names in its\n" +
      "  own state.json move; shared and hand-authored ones stay put.",
    )
    .option('--dry-run', 'List what would move, write nothing')
    .action((opts: { dryRun?: boolean }, actionCmd: Command) => {
      const root = resolveWorkspaceRoot(actionCmd);
      const doc  = requireYaml(root);
      const plan = planEpicPipelineExtraction(root, doc);
      if (plan.length === 0) {
        console.log(chalk.dim('No inline epic pipelines left to move.'));
        return;
      }
      for (const item of plan) {
        console.log(
          `${chalk.bold(item.pipelineId)} ${chalk.dim('→')} ` +
          chalk.dim(path.relative(root, item.file).split(path.sep).join('/')),
        );
      }
      if (opts.dryRun) {
        console.log(chalk.dim(`
${plan.length} pipeline(s) would move. Re-run without --dry-run.`));
        return;
      }
      // Staging is all it takes: writeYaml routes an epic-owned pipeline to
      // the epic file and drops it from the shared document in one pass.
      for (const item of plan) { stageEpicPipeline(doc, item.pipelineId, item.epicId); }
      writeYaml(root, doc);
      console.log(chalk.green('✔') + ` Moved ${plan.length} pipeline(s) out of .aidlc/workspace.yaml.`);
      console.log(chalk.dim('  Commit the epic directories together with workspace.yaml.'));
    });
  cmd
    .command('strict <epicId> [value]')
    .description('Show or set an epic\'s depth of work (strict_mode in its state.json)')
    .action((epicId: string, value: string | undefined, _opts: unknown, actionCmd: Command) => {
      const root = resolveWorkspaceRoot(actionCmd);
      const doc  = requireYaml(root);
      const file = path.join(epicsRoot(root, doc), epicId, 'state.json');
      if (!fs.existsSync(file)) {
        console.error(chalk.red(`No epic "${epicId}" — expected ${file}`));
        process.exit(1);
      }

      let state: Record<string, unknown>;
      try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        console.error(chalk.red(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
        return;
      }

      if (value === undefined) {
        const on = epicStrictMode(state);
        console.log(`${epicId}: strict_mode ${on ? chalk.bold('true') : chalk.bold('false')}`);
        console.log(chalk.dim(on
          ? '  Phases work at full depth. Set false for an epic the size of one task.'
          : '  Phases stay proportional to the work — no invented NFR / risk sections.'));
        return;
      }

      const truthy = ['on', 'true', 'yes', '1'];
      const falsy  = ['off', 'false', 'no', '0'];
      const v = value.trim().toLowerCase();
      if (!truthy.includes(v) && !falsy.includes(v)) {
        console.error(chalk.red(`Expected on|off, got "${value}".`));
        process.exit(1);
      }

      // Read-modify-write the whole object: state.json carries run mirroring
      // (stepStates, history) that nothing here understands and must survive.
      state[STRICT_MODE_KEY] = truthy.includes(v);
      fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
      console.log(chalk.green('✔') + ` ${epicId}: strict_mode ${truthy.includes(v)}`);
      console.log(chalk.dim('  Takes effect on the next phase run — nothing already written changes.'));
    });

  const stepCmd = cmd
    .command('step')
    .description(
      'Add, remove or re-gate a step on a running epic. add/remove update the\n' +
      '  pipeline, the run state and the epic\'s state.json together; set changes\n' +
      '  only the pipeline, because the runner reads gates from it as it goes.\n' +
      '  <step> can be a step name ("spec"), an agent id, or a 0-based index.',
    );

  stepCmd
    .command('add <epicId>')
    .description('Insert a step into a running epic\'s pipeline')
    .requiredOption('--agent <id>', 'agent that runs the step')
    .option('--name <name>', 'step name — its identity in depends_on and the run records')
    .option('--after <step>', 'insert immediately after this step')
    .option('--before <step>', 'insert immediately before this step')
    .option('--produces <path...>', 'artifact paths the step must produce')
    .option('--requires <path...>', 'artifact paths that must exist before it opens')
    .option('--depends-on <step...>', 'steps that must be approved before it opens')
    .option('--human-review', 'pause for human approval after the step')
    .option('--auto-review', 'run the auto-reviewer after the step')
    .action((epicId: string, opts: {
      agent: string; name?: string; after?: string; before?: string;
      produces?: string[]; requires?: string[]; dependsOn?: string[];
      humanReview?: boolean; autoReview?: boolean;
    }, actionCmd: Command) => {
      const root = resolveWorkspaceRoot(actionCmd);
      const doc  = requireYaml(root);
      const { runState, pipelineCfg } = requireEditableEpic(root, doc, epicId);

      const plan = runEdit(() => planAddEpicStep({
        runState,
        pipeline: pipelineCfg,
        step: {
          agent: opts.agent,
          name: opts.name,
          produces: opts.produces,
          requires: opts.requires,
          depends_on: opts.dependsOn,
          human_review: opts.humanReview,
          auto_review: opts.autoReview,
        },
        position: { after: opts.after, before: opts.before },
      }));

      writeEdit(root, doc, plan);
      console.log(chalk.green('✔') + ` Added step ${chalk.bold(plan.stepId)} at index ${plan.index} of ${chalk.bold(pipelineCfg.id)}`);
      printSteps(plan);
      console.log(chalk.dim('  The step is pending — it opens when the run reaches it.'));
    });

  stepCmd
    .command('remove <epicId> <step>')
    .description('Remove a not-yet-started step from a running epic\'s pipeline')
    .action((epicId: string, step: string, _opts: unknown, actionCmd: Command) => {
      const root = resolveWorkspaceRoot(actionCmd);
      const doc  = requireYaml(root);
      const { runState, pipelineCfg } = requireEditableEpic(root, doc, epicId);

      const plan = runEdit(() => planRemoveEpicStep({ runState, pipeline: pipelineCfg, step }));

      writeEdit(root, doc, plan);
      console.log(chalk.green('✔') + ` Removed step ${chalk.bold(plan.stepId)} from ${chalk.bold(pipelineCfg.id)}`);
      printSteps(plan);
    });

  // Gates are the cheap edit: `human_review` and `auto_review` are never
  // copied into the run — the runner reads them off the live pipeline when a
  // step's work is submitted — so this writes workspace.yaml and nothing else.
  // That is also why the extension leaves the gate toggles enabled on a
  // pipeline whose step list it has locked.
  stepCmd
    .command('set <epicId> <step>')
    .description('Turn a step\'s review gates on or off on a running epic')
    .option('--human-review', 'pause for human approval after the step')
    .option('--no-human-review', 'do not pause for human approval')
    .option('--auto-review <runner>', 'run this validator after the step')
    .option('--no-auto-review', 'do not run an auto-reviewer')
    .action((epicId: string, step: string, opts: {
      humanReview?: boolean; autoReview?: string | false;
    }, actionCmd: Command) => {
      const root = resolveWorkspaceRoot(actionCmd);
      const doc  = requireYaml(root);
      const { runState, pipelineCfg } = requireEditableEpic(root, doc, epicId);

      // Commander gives `autoReview` three values because the flag is declared
      // both ways: absent (leave the gate alone), `false` from --no-auto-review,
      // or the runner path from --auto-review <runner>.
      const plan = runEdit(() => planSetEpicStepGates({
        runState,
        pipeline: pipelineCfg,
        step,
        gates: {
          human_review: opts.humanReview,
          auto_review: opts.autoReview === undefined ? undefined : opts.autoReview !== false,
          auto_review_runner: typeof opts.autoReview === 'string' ? opts.autoReview : undefined,
        },
      })) as EpicStepGatePlan;

      if (plan.changes.length === 0) {
        console.log(chalk.dim(`Step ${plan.stepId} already has those gates — nothing written.`));
        return;
      }

      writePipeline(root, doc, plan.pipeline);
      console.log(chalk.green('✔') + ` Step ${chalk.bold(plan.stepId)} of ${chalk.bold(pipelineCfg.id)}`);
      for (const c of plan.changes) {
        const arrow = c.to ? chalk.yellow('on') : chalk.dim('off');
        console.log(`  ${chalk.dim(c.gate)} ${chalk.dim(String(c.from))} → ${arrow}`);
      }
      const note = describeGateEffect(plan.stepStatus, plan.changes);
      if (note) {
        console.log(chalk.yellow(`  The step is ${plan.stepStatus}. `) + chalk.dim(note));
      }
    });
}

/**
 * Load the run + pipeline for an epic, refusing the cases where an edit would
 * be meaningless or would damage something else.
 *
 * The shared-pipeline check is the one worth spelling out: a hand-authored
 * pipeline can back several epics, and each of their runs is indexed against
 * it. Reshaping it for one epic silently reshapes it under the others, which
 * is exactly the failure this command exists to avoid — so it is refused, and
 * the fix is a pipeline of the epic's own.
 */
function requireEditableEpic(
  root: string,
  doc: ReturnType<typeof requireYaml>,
  epicId: string,
): { runState: RunState; pipelineCfg: PipelineConfig } {
  const runState = RunStateStore.load(root, epicId);
  if (!runState) {
    console.error(chalk.red(`Epic "${epicId}" has no run state at .aidlc/runs/${epicId}.json.`));
    console.error(chalk.dim('  Only a pipeline-backed epic has a step list to edit.'));
    process.exit(1);
  }

  const found = (doc.pipelines as Array<Record<string, unknown>>)
    .find((p) => String(p.id) === runState.pipelineId);
  if (!found) {
    console.error(chalk.red(`Pipeline "${runState.pipelineId}" is not in workspace.yaml, but run "${epicId}" executes it.`));
    process.exit(1);
  }

  const sharing = listEpics(root, doc)
    .filter((e) => e.pipeline === runState.pipelineId && e.id !== epicId);
  if (sharing.length > 0) {
    console.error(chalk.red(`Pipeline "${runState.pipelineId}" also backs ${sharing.map((e) => e.id).join(', ')}.`));
    console.error(chalk.dim('  Editing its steps would reshape those runs too, without their history moving with it.'));
    console.error(chalk.dim(`  Give ${epicId} a pipeline of its own first (aidlc pipeline add), then edit that.`));
    process.exit(1);
  }

  return { runState, pipelineCfg: found as unknown as PipelineConfig };
}

/** Run a planner, turning its refusal into a clean CLI error. */
function runEdit(plan: () => EpicStepEditPlan): EpicStepEditPlan {
  try {
    return plan();
  } catch (err) {
    if (err instanceof EpicStepEditError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Write the plan to all three stores. The workspace write validates the whole
 * document first — that is what catches a `--agent` that does not exist — and
 * it happens before anything else is touched, so a rejected pipeline leaves
 * the run untouched rather than half-edited.
 */
function writeEdit(
  root: string,
  doc: ReturnType<typeof requireYaml>,
  plan: EpicStepEditPlan,
): void {
  const before = JSON.parse(JSON.stringify(doc.pipelines)) as Array<Record<string, unknown>>;

  commitEpicStepEdit({
    workspaceRoot: root,
    doc,
    plan,
    writeWorkspace: (pipeline) => { writePipeline(root, doc, pipeline); },
    restoreWorkspace: () => {
      doc.pipelines = before;
      writeYaml(root, doc);
    },
  });
}

/**
 * Swap one pipeline into the document and write it, refusing anything the
 * workspace would not accept. Both checks are needed and they are different:
 * the schema is about shape, and passes a step naming an agent that does not
 * exist — a reference the run would only fail on later, with the step already
 * written. Reference issues are only fatal when they belong to *this*
 * pipeline; a workspace already carrying a dangling reference elsewhere is not
 * this command's business to fail on.
 */
function writePipeline(
  root: string,
  doc: ReturnType<typeof requireYaml>,
  pipeline: PipelineConfig,
): void {
  doc.pipelines = doc.pipelines.map((p) =>
    String(p.id) === pipeline.id ? (pipeline as unknown as Record<string, unknown>) : p,
  );
  let config;
  try {
    config = validateWorkspace(doc, '.aidlc/workspace.yaml');
  } catch (err) {
    console.error(chalk.red('The edited pipeline fails workspace validation — nothing was written:'));
    console.error(chalk.dim(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  const issues = collectWorkspaceRefIssues(config)
    .filter((i) => i.path.startsWith(`pipelines.${pipeline.id}.`));
  if (issues.length > 0) {
    console.error(chalk.red('The edited step references something the workspace does not define — nothing was written:'));
    for (const issue of issues) { console.error(chalk.dim(`  ${issue.message}`)); }
    process.exit(1);
  }
  writeYaml(root, doc);
}

/** Print the run's step list after an edit, marking where the pointer sits. */
function printSteps(plan: EpicStepEditPlan): void {
  const { runState } = plan;
  runState.steps.forEach((s, i) => {
    const marker = i === runState.currentStepIdx ? chalk.yellow('▶') : ' ';
    const label  = i === plan.index ? chalk.bold(stepIdentity(s)) : chalk.dim(stepIdentity(s));
    console.log(`  ${marker} ${chalk.dim(String(i))} ${label} ${chalk.dim('(' + s.status + ')')}`);
  });
  if (plan.previousCurrentStepIdx !== runState.currentStepIdx) {
    console.log(chalk.dim(`  Current step moved ${plan.previousCurrentStepIdx} → ${runState.currentStepIdx} (same step).`));
  }
}

/** Commander collector for repeatable `--input key=value` flags. */
function collectKv(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

function printEpicDetail(epic: EpicSummary): void {
  console.log();
  console.log(chalk.bold(epic.id) + '  ' + colorEpicStatus(epic.status));
  if (epic.title)       { console.log(chalk.dim('  title:    ') + epic.title); }
  if (epic.description) { console.log(chalk.dim('  desc:     ') + epic.description); }
  if (epic.pipeline)    { console.log(chalk.dim('  pipeline: ') + epic.pipeline); }
  if (epic.createdAt)   { console.log(chalk.dim('  created:  ') + epic.createdAt); }
  console.log(chalk.dim('  state:    ') + chalk.dim(epic.statePath));
  console.log();

  if (epic.stepDetails.length > 0) {
    epic.stepDetails.forEach((s, i) => {
      const isCurrent = i === epic.currentStep && epic.status === 'in_progress';
      const marker    = isCurrent ? chalk.yellow('▶') : ' ';
      const status    = colorEpicStatus(s.status);
      const agent     = isCurrent ? chalk.bold(s.agent || '?') : chalk.dim(s.agent || '?');
      const finished  = s.finishedAt ? chalk.dim(` ✓ ${s.finishedAt.slice(0, 19).replace('T', ' ')}`) : '';
      console.log(`  ${marker} ${chalk.dim((i + 1) + '.')} ${agent.padEnd(20)} ${status}${finished}`);
    });
    console.log();
  }

  const inputKeys = Object.keys(epic.inputs);
  if (inputKeys.length > 0) {
    console.log(chalk.bold('Inputs:'));
    for (const key of inputKeys) {
      const val = epic.inputs[key];
      const display = val.length > 80 ? val.slice(0, 77) + '…' : val;
      console.log(`  ${chalk.dim(key + ':')} ${display}`);
    }
    console.log();
  }
}

function colorEpicStatus(status: EpicStatus): string {
  switch (status) {
    case 'done':        return chalk.green(status);
    case 'in_progress': return chalk.yellow(status.replace('_', ' '));
    case 'failed':      return chalk.red(status);
    case 'pending':
    default:            return chalk.dim(status);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
