/**
 * `aidlc maintain` — stage 6's front door.
 *
 * The playbook's sixth stage is the return path: a production signal becomes a
 * diagnosis, and the diagnosis becomes the intent of the next epic. Every other
 * stage is entered by a person who is already looking at the screen; this one is
 * entered by an alert at 3am, so it needs a door that a shell script, a webhook
 * forwarder or a cron job can open without a UI.
 *
 * Two commands, because stage 6 has two moments and a machine may only decide
 * the first:
 *
 *   aidlc maintain --signal signal.json      register the signal as an epic
 *   aidlc maintain follow-up <epic>          open the work the diagnosis found
 *
 * The split is not ceremony. Whether a signal deserves five stages is a judgment
 * made against the code, and it belongs to the Operator agent that runs between
 * these two calls — not to the flag that woke it up.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  validateWorkspace,
  assemblePipeline,
  recipePipelineId,
  PipelineAssembleError,
  parseSignal,
  SignalParseError,
  openIncidentEpic,
  openFollowUpEpic,
  followUpEpicId,
  followUpIdFor,
  existingEpicIds,
  readEpicSignal,
  EpicScaffoldError,
  SIGNAL_FILE,
  type Signal,
  type PipelineConfig,
  type RenderIntentOptions,
} from '@aidlc/core';
import { resolveWorkspaceRoot } from '../workspaceRoot';
import { requireYaml, writeYaml, existingIds, type YamlDocument } from '../yamlIO';

/** Recipes the two commands default to — both ship with the `ai-native` preset. */
const INCIDENT_RECIPE = 'native-incident';
const FOLLOW_UP_RECIPE = 'native-full';

export function registerMaintain(program: Command): void {
  const cmd = program
    .command('maintain')
    .description('Stage 6 — turn a production signal into an incident epic (AI-Native SDLC)')
    .option('-s, --signal <file>', 'signal JSON file ("-" reads stdin)')
    .option('--recipe <id>', `recipe to assemble the incident pipeline from (default: ${INCIDENT_RECIPE})`)
    .option('--pipeline <id>', 'use an existing pipeline as-is instead of a recipe')
    .option('--from <pipelineId>', "override the recipe's source pipeline")
    .option('--epic <id>', 'epic id (default: derived from the symptom, e.g. INC-CHECKOUT-RETURNS-500)')
    .option('--prefix <prefix>', 'id prefix when deriving (default: INC)')
    .option('--json', 'output the result as JSON')
    .action((opts: MaintainOpts, actionCmd: Command) => { runMaintain(opts, actionCmd); });

  // ── follow-up ──────────────────────────────────────────────────────────────
  cmd
    .command('follow-up <incidentEpic>')
    .description('Open the epic this incident calls for, with its intent.md already written')
    .option('-s, --signal <file>', `signal JSON (default: the incident epic's ${SIGNAL_FILE})`)
    .option('--recipe <id>', `recipe for the new epic (default: ${FOLLOW_UP_RECIPE})`)
    .option('--pipeline <id>', 'use an existing pipeline as-is instead of a recipe')
    .option('--from <pipelineId>', "override the recipe's source pipeline")
    .option('--epic <id>', 'id for the new epic (default: <incidentEpic>-FIX)')
    .option('--intent <file>', 'use this markdown as intent.md verbatim, instead of rendering one')
    .option('--problem <text>', 'the problem in the user\'s terms — no solution language')
    .option('--who-hurts <text>', 'the specific role doing the specific task')
    .option('--cost <text>', 'what it costs them (default: the signal\'s scope)')
    .option('--done <text>', 'the observable condition that says this cannot recur')
    .option('--question <text>', 'an open question for the human gate (repeatable)', collect, [] as string[])
    .option('--json', 'output the result as JSON')
    .action((incidentEpic: string, opts: FollowUpOpts, actionCmd: Command) => {
      runFollowUp(incidentEpic, opts, actionCmd);
    });
}

interface MaintainOpts {
  signal?: string; recipe?: string; pipeline?: string; from?: string;
  epic?: string; prefix?: string; json?: boolean;
}

interface FollowUpOpts {
  signal?: string; recipe?: string; pipeline?: string; from?: string; epic?: string;
  intent?: string; problem?: string; whoHurts?: string; cost?: string; done?: string;
  question: string[]; json?: boolean;
}

// ── maintain ─────────────────────────────────────────────────────────────────

function runMaintain(opts: MaintainOpts, actionCmd: Command): void {
  if (!opts.signal) {
    fail(
      'A signal is required: aidlc maintain --signal <file>',
      'Five fields — source, observedAt, symptom, scope, evidence. Use "-" to read stdin.',
    );
  }
  const root = resolveWorkspaceRoot(actionCmd);
  const doc = requireYaml(root);
  const signal = loadSignal(opts.signal!);

  // Derive the id *before* assembling, so the epic and the pipeline it runs on
  // carry the same name — the same pairing `aidlc epic start` produces.
  const epicId = opts.epic?.trim()
    || followUpEpicId(signal, { prefix: opts.prefix, taken: existingEpicIds(root, doc) });

  const pipelineCfg = resolvePipeline(root, doc, {
    pipeline: opts.pipeline, recipe: opts.recipe ?? INCIDENT_RECIPE, from: opts.from,
  }, epicId);

  try {
    const result = openIncidentEpic({
      workspaceRoot: root, doc, signal, pipeline: pipelineCfg, epicId,
    });

    if (opts.json) {
      console.log(JSON.stringify({
        epicId: result.epicId,
        epicDir: result.epicDir,
        signalPath: result.signalPath,
        pipeline: pipelineCfg.id,
      }, null, 2));
      return;
    }

    console.log(chalk.green('✔') + ` Registered incident ${chalk.bold(result.epicId)}`);
    console.log(chalk.dim(`  Symptom:  ${signal.symptom}`));
    console.log(chalk.dim(`  Source:   ${signal.source} · observed ${signal.observedAt}`));
    console.log(chalk.dim(`  Pipeline: ${pipelineCfg.id}`));
    console.log(chalk.dim(`  Signal:   ${result.signalPath}`));
    console.log(`\nRun ${chalk.cyan(`/maintain ${result.epicId}`)} in Claude to diagnose it.`);
    console.log(chalk.dim(`Then, if it opens work: aidlc maintain follow-up ${result.epicId}`));
  } catch (err) {
    rethrow(err);
  }
}

// ── follow-up ────────────────────────────────────────────────────────────────

function runFollowUp(incidentEpic: string, opts: FollowUpOpts, actionCmd: Command): void {
  const root = resolveWorkspaceRoot(actionCmd);
  const doc = requireYaml(root);

  // The signal is read back from the incident epic by default, so the caller
  // that already diagnosed it does not have to carry the payload around.
  let signal: Signal;
  if (opts.signal) {
    signal = loadSignal(opts.signal);
  } else {
    const raw = readEpicSignal(root, doc, incidentEpic);
    if (raw === null) {
      fail(
        `Epic "${incidentEpic}" has no ${SIGNAL_FILE} to open a follow-up from.`,
        `Pass one with --signal <file>, or register the incident first: aidlc maintain --signal <file>`,
      );
    }
    signal = parseOrFail(raw!, path.join(incidentEpic, SIGNAL_FILE));
  }

  const epicId = opts.epic?.trim() || followUpIdFor(incidentEpic, existingEpicIds(root, doc));

  const pipelineCfg = resolvePipeline(root, doc, {
    pipeline: opts.pipeline, recipe: opts.recipe ?? FOLLOW_UP_RECIPE, from: opts.from,
  }, epicId);

  const intent: RenderIntentOptions = {
    fromEpicId: incidentEpic,
    problem: opts.problem,
    whoHurts: opts.whoHurts,
    cost: opts.cost,
    doneLooksLike: opts.done,
    openQuestions: opts.question,
  };

  let intentMarkdown: string | undefined;
  if (opts.intent) {
    if (!fs.existsSync(opts.intent)) { fail(`Intent file not found: ${opts.intent}`); }
    intentMarkdown = fs.readFileSync(opts.intent, 'utf8');
  }

  try {
    const result = openFollowUpEpic({
      workspaceRoot: root, doc, signal, pipeline: pipelineCfg,
      fromEpicId: incidentEpic,
      epicId,
      intentMarkdown,
      intent,
    });

    if (opts.json) {
      console.log(JSON.stringify({
        epicId: result.epicId,
        epicDir: result.epicDir,
        intentPath: result.intentPath,
        pipeline: pipelineCfg.id,
        fromEpic: incidentEpic,
      }, null, 2));
      return;
    }

    console.log(chalk.green('✔') + ` Opened ${chalk.bold(result.epicId)} from ${chalk.bold(incidentEpic)}`);
    console.log(chalk.dim(`  Pipeline: ${pipelineCfg.id}`));
    console.log(chalk.dim(`  Intent:   ${result.intentPath}`));
    // The loop closes at stage 1, behind a person — an intent written by an
    // agent from a single alert is exactly what deserves a human's eyes.
    console.log(`\nThe loop is closed. Review the intent, then run ${chalk.cyan(`/intent ${result.epicId}`)}.`);
  } catch (err) {
    rethrow(err);
  }
}

// ── shared ───────────────────────────────────────────────────────────────────

/**
 * Resolve the pipeline to run an epic on: an existing one by id, or one
 * assembled from a recipe and written back to workspace.yaml — the same
 * resolution `aidlc epic start` performs, so both doors produce the same shape.
 */
function resolvePipeline(
  root: string,
  doc: YamlDocument,
  opts: { pipeline?: string; recipe: string; from?: string },
  epicId?: string,
): PipelineConfig {
  if (opts.pipeline) {
    const found = (doc.pipelines as Array<Record<string, unknown>>)
      .find((p) => String(p.id) === opts.pipeline);
    if (!found) { fail(`Pipeline "${opts.pipeline}" not found in workspace.yaml.`); }
    return found as unknown as PipelineConfig;
  }

  let config;
  try {
    config = validateWorkspace(doc, '.aidlc/workspace.yaml');
  } catch (err) {
    fail('workspace.yaml is invalid — fix it before running stage 6:',
      err instanceof Error ? err.message : String(err));
  }

  if (!config!.recipes.some((r) => r.id === opts.recipe)) {
    fail(
      `Recipe "${opts.recipe}" is not defined in this workspace.`,
      'Stage 6 ships with the AI-Native preset: aidlc preset apply ai-native',
    );
  }
  if (opts.from) {
    const recipe = config!.recipes.find((r) => r.id === opts.recipe);
    if (recipe) { recipe.from = opts.from; }
  }

  const pipelineId = recipePipelineId({
    recipeId: opts.recipe, epicId, taken: existingIds(doc.pipelines),
  });
  let pipelineCfg: PipelineConfig;
  try {
    pipelineCfg = assemblePipeline(config!, { recipeId: opts.recipe, pipelineId });
  } catch (err) {
    if (err instanceof PipelineAssembleError) {
      fail('Could not assemble pipeline: ' + err.message);
    }
    throw err;
  }

  doc.pipelines.push(pipelineCfg! as unknown as Record<string, unknown>);
  try {
    validateWorkspace(doc, '.aidlc/workspace.yaml');
  } catch (err) {
    fail('Assembled pipeline failed validation — not written:',
      err instanceof Error ? err.message : String(err));
  }
  writeYaml(root, doc);
  console.log(chalk.dim(`Assembled pipeline ${chalk.bold(pipelineCfg!.id)} from recipe ${chalk.bold(opts.recipe)}`));
  return pipelineCfg!;
}

/** Read a signal from a file, or from stdin when the path is `-`. */
function loadSignal(file: string): Signal {
  if (file === '-') {
    return parseOrFail(fs.readFileSync(0, 'utf8'), 'stdin');
  }
  if (!fs.existsSync(file)) {
    fail(`Signal file not found: ${file}`);
  }
  return parseOrFail(fs.readFileSync(file, 'utf8'), file);
}

/**
 * Parse a signal, or exit with every problem listed at once — the caller is
 * often an unattended forwarder, and one round-trip beats five.
 */
function parseOrFail(raw: string, where: string): Signal {
  try {
    return parseSignal(raw);
  } catch (err) {
    if (err instanceof SignalParseError) {
      fail(`${where}: ${err.message}`, EXAMPLE_SIGNAL);
    }
    throw err;
  }
}

const EXAMPLE_SIGNAL = [
  'Expected shape:',
  '  {',
  '    "source": "sentry",',
  '    "observedAt": "2026-08-30T02:14:00Z",',
  '    "symptom": "Checkout returns 500 for saved cards",',
  '    "scope": "~40 users/hour, EU region only",',
  '    "evidence": "TypeError: cannot read property token of undefined"',
  '  }',
].join('\n');

function collect(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

function fail(message: string, detail?: string): never {
  console.error(chalk.red(message));
  if (detail) { console.error(chalk.dim(detail)); }
  process.exit(1);
}

function rethrow(err: unknown): never {
  if (err instanceof EpicScaffoldError) { fail(err.message); }
  throw err;
}
