import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import {
  WorkspaceLoader,
  WorkspaceNotFoundError,
  RunStateStore,
  isInsideClaudeCodeSession,
  hasClaudeLogin,
  buildClaudeSpawnEnv,
  resolveDeclaredPath,
  claudeConfigDir,
  isDefaultClaudeConfigDir,
  PersonaLoader,
  findProjectInstructions,
  DefaultRunner,
  CodexRunner,
  NO_HARNESS_CAPABILITIES,
  claudeJsonPath,
  readProjectMcpServer,
  isCodexMcpConfigured,
  isClaudeTierAlias,
  resolveProviderModel,
  providerAliases,
  ratesFromConfig,
  type HarnessCapabilities,
} from '@aidlc/core';
import { resolveWorkspaceRoot } from '../workspaceRoot';

interface Check {
  label: string;
  pass: boolean;
  info?: string;
  /**
   * Advisory rather than broken. Printed yellow and excluded from the exit
   * code — a phase that will run without a persona is worth saying out loud,
   * but it is a legitimate configuration, not a failure.
   */
  warn?: boolean;
}

function ok(label: string, info?: string): Check   { return { label, pass: true,  info }; }
function fail(label: string, info?: string): Check  { return { label, pass: false, info }; }
function warn(label: string, info?: string): Check  { return { label, pass: true,  info, warn: true }; }

/** Claude Code reads flags like CLAUDE_CODE_USE_BEDROCK=1 as truthy on presence. */
function envTruthy(v: string | undefined): boolean {
  return !!v && v !== '0' && v.toLowerCase() !== 'false';
}

/**
 * Determine which auth mode Claude (and therefore AIDLC) will use — and report
 * it the way AIDLC actually behaves. Bedrock / Vertex win first (their env is
 * never stripped). Then a `claude login`: AIDLC strips an inherited
 * ANTHROPIC_* key whenever a login exists (see buildClaudeSpawnEnv), so login
 * is what runs even if a stale key sits in the shell. A bare API key / token is
 * only the effective auth when there is no login to prefer.
 */
function detectAuth(claudeBin: string): Check {
  const e = process.env;

  if (envTruthy(e.CLAUDE_CODE_USE_BEDROCK)) {
    const region = e.AWS_REGION || e.AWS_DEFAULT_REGION;
    const cred =
      e.AWS_PROFILE ? `profile ${e.AWS_PROFILE}` :
      (e.AWS_ACCESS_KEY_ID || e.AWS_SESSION_TOKEN) ? 'AWS env credentials' :
      'AWS default credential chain';
    return ok('Auth: AWS Bedrock', [cred, region && `region ${region}`].filter(Boolean).join(', '));
  }

  if (envTruthy(e.CLAUDE_CODE_USE_VERTEX)) {
    const region = e.CLOUD_ML_REGION || e.VERTEX_REGION;
    const project = e.ANTHROPIC_VERTEX_PROJECT_ID;
    const info = [project && `project ${project}`, region && `region ${region}`].filter(Boolean).join(', ');
    return ok('Auth: Google Vertex AI', info || undefined);
  }

  // Prefer a `claude login` over any inherited key — AIDLC strips the key when a
  // login exists so the OAuth session is used (avoids "Invalid API key" from a
  // stale/scoped shell key). Cheap offline check: ~/.claude.json `oauthAccount`.
  if (hasClaudeLogin()) {
    const shadowed = !!e.ANTHROPIC_API_KEY;
    return ok('Auth: claude login (claude.ai / OAuth)',
      shadowed ? 'inherited ANTHROPIC_API_KEY ignored in favor of login' : 'no ANTHROPIC_API_KEY needed');
  }

  // No login. Inside a Claude Code session the inherited key is ephemeral and
  // gets stripped too, so don't report it. Otherwise a deliberately-set key /
  // token is the real (and kept) auth.
  const ephemeralKey = isInsideClaudeCodeSession();

  if (e.ANTHROPIC_API_KEY && !ephemeralKey) {
    return ok('Auth: ANTHROPIC_API_KEY set');
  }

  if (e.ANTHROPIC_AUTH_TOKEN && !ephemeralKey) {
    return ok('Auth: ANTHROPIC_AUTH_TOKEN set', e.ANTHROPIC_BASE_URL ? `base_url ${e.ANTHROPIC_BASE_URL}` : undefined);
  }

  // Last resort — the login marker may be absent for some setups (enterprise
  // SSO, relocated config). `claude config list` exits 0 only when claude can
  // actually reach a model, so a success here still means "auth works".
  if (claudeBin) {
    try {
      execSync('claude config list', {
        encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
        env: buildClaudeSpawnEnv(),
      });
      return ok('Auth: claude login (claude.ai / OAuth)', 'no ANTHROPIC_API_KEY needed');
    } catch {
      return fail('Not authenticated',
        'use one of: claude login · ANTHROPIC_API_KEY · CLAUDE_CODE_USE_BEDROCK · CLAUDE_CODE_USE_VERTEX');
    }
  }

  return fail('Not authenticated',
    'install claude + run `claude login`, or set ANTHROPIC_API_KEY / CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX');
}

function printSection(title: string, checks: Check[]): void {
  console.log(chalk.bold(`\n${title}`));
  for (const c of checks) {
    const icon   = !c.pass ? chalk.red('✘') : c.warn ? chalk.yellow('⚠') : chalk.green('✔');
    const detail = c.info ? chalk.dim(`  ${c.info}`) : '';
    console.log(`  ${icon}  ${c.label}${detail}`);
  }
}

/**
 * Harness parity — what each agent will actually receive in its prompt.
 *
 * A step's prompt is composed of three layers (persona, project instructions,
 * skills) plus the ast-graph MCP server, and a harness supplies some of them
 * natively while AIDLC inlines the rest. When a layer is supplied by neither,
 * the phase runs blind: it still produces an artifact, just a worse one, and
 * nothing in the run output says why. This section is that warning, before the
 * run rather than after it. See MULTI_PROVIDER_ALIGNMENT.md §4c.
 */
function parityChecks(
  root: string,
  ws: NonNullable<Awaited<ReturnType<typeof WorkspaceLoader.load>>>,
): Check[] {
  const checks: Check[] = [];
  const personas = new PersonaLoader(root);

  // Runner capabilities, resolved statically. A custom runner is not loaded
  // here — running a user's module during a diagnostic would be a surprise —
  // so it is reported under the same conservative assumption the composer
  // makes: the harness supplies nothing and every layer gets inlined.
  const capsFor = (runner: string): HarnessCapabilities => {
    if (runner === 'default') { return new DefaultRunner().capabilities; }
    if (runner === 'codex') { return new CodexRunner().capabilities; }
    return NO_HARNESS_CAPABILITIES;
  };

  // Which instruction file each harness ends up bound by. Reported per runner
  // rather than once, because the answer genuinely differs: a repo carrying both
  // CLAUDE.md and AGENTS.md gives each harness the file written for it, and a
  // single line here would name one of them and quietly mislead about the other.
  const runners = [...new Set(ws.config.agents.map((a) => a.runner))];
  for (const runner of runners) {
    const caps = capsFor(runner);
    const label = runners.length > 1 ? `project instructions (${runner})` : 'project instructions';
    if (caps.projectInstructions) {
      checks.push(ok(label, `${caps.instructionFile ?? 'its own file'}, read by the harness`));
      continue;
    }
    const instructions = findProjectInstructions(root, caps.instructionFile);
    checks.push(instructions
      ? ok(label, `${instructions.relPath}, inlined into the prompt`)
      : warn(label,
          `none of ${['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'].join(' / ')} found — phases run without the repo's conventions`));
  }

  for (const agent of ws.config.agents) {
    const caps = capsFor(agent.runner);
    const persona = personas.load(agent.id);

    if (persona) {
      const via = caps.persona ? 'loaded by the harness' : 'inlined into the prompt';
      checks.push(ok(`persona "${agent.id}"`, `${persona.scope} scope, ${via}`));
    } else if (caps.persona) {
      checks.push(warn(`persona "${agent.id}"`, 'no persona file — the harness will find nothing to load'));
    } else {
      checks.push(warn(`persona "${agent.id}"`,
        `no persona file in ${personas.searchPaths().length} scopes — this agent runs with skills only`));
    }
  }

  // ast-graph. Registration is now checked against each CLI's own config, which
  // is a file read rather than a subprocess, so doctor stays offline and still
  // stops implying that a graph on disk means a harness can reach it (G1).
  const graphDb = path.join(root, '.ast-graph', 'graph.db');
  if (!fs.existsSync(graphDb)) {
    checks.push(warn('ast-graph', 'no .ast-graph/graph.db — run "AIDLC: Rescan AST Graph" to build it'));
    return checks;
  }
  checks.push(ok('ast-graph', 'graph built'));

  for (const runner of runners) {
    if (runner === 'default') {
      const server = readProjectMcpServer(root, 'ast-graph', claudeJsonPath());
      checks.push(server
        ? ok('ast-graph via claude', 'registered for this project')
        : warn('ast-graph via claude',
            'not in this project\'s MCP config — run "AIDLC: Rescan AST Graph" in VS Code'));
    } else if (runner === 'codex') {
      checks.push(isCodexMcpConfigured('ast-graph', os.homedir())
        ? ok('ast-graph via codex', 'declared in ~/.codex/config.toml (per-user, not per-project)')
        : warn('ast-graph via codex',
            'not in ~/.codex/config.toml — run "aidlc mcp register --runner codex"'));
    } else {
      checks.push(warn(`ast-graph via ${runner}`,
        'AIDLC has no MCP registration for this runner — its phases run without the graph'));
    }
  }

  return checks;
}

/**
 * Providers: is each configured CLI actually here, which concrete model will
 * each agent run on, and do we know what any of it costs
 * (MULTI_PROVIDER_ALIGNMENT.md §P3).
 *
 * The cost lines exist because P0/D5 requires a blind provider to be named out
 * loud. A budget ceiling that silently sums a Codex step as $0 is not a
 * ceiling, and the moment to learn that is before a run, not after a bill.
 */
function providerChecks(
  ws: NonNullable<Awaited<ReturnType<typeof WorkspaceLoader.load>>>,
): Check[] {
  const checks: Check[] = [];
  const runners = [...new Set(ws.config.agents.map((a) => a.runner))].sort();
  const rates = ratesFromConfig(ws.config.providers);

  for (const runner of runners) {
    if (runner === 'custom') { continue; }

    // `default` is Claude, already probed in its own section above.
    if (runner !== 'default') {
      // Pinning provider CLI versions is still open (§6 q1); reporting the
      // build the flags were written against is the cheap half of the answer.
      try {
        const bin = execSync(`which ${runner}`, { encoding: 'utf8', timeout: 5000 }).trim();
        checks.push(ok(`${runner} binary on PATH`, bin));
        try {
          const version = execSync(`${runner} --version`, {
            encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          checks.push(ok(`${runner} --version`, version.split('\n')[0]));
        } catch {
          checks.push(warn(`${runner} --version`, 'binary present but --version failed'));
        }
      } catch {
        checks.push(fail(`${runner} binary on PATH`,
          `agents declare runner: ${runner}, but that CLI is not installed`));
      }
    }

    // Cost accounting, per provider.
    if (runner === 'default') {
      checks.push(ok('cost accounting (default)', 'claude reports total_cost_usd — measured'));
    } else if (rates[runner]) {
      const models = Object.keys(rates[runner]).join(', ');
      checks.push(ok(`cost accounting (${runner})`,
        `estimated from providers.${runner}.rates (${models}) — not a measured cost`));
    } else {
      checks.push(warn(`cost accounting (${runner})`,
        `no rates declared — steps on ${runner} sum as $0 against the budget. `
        + `Set providers.${runner}.rates in workspace.yaml to enforce a ceiling.`));
    }
  }

  // Which concrete model each agent ends up on, after alias resolution.
  for (const agent of ws.config.agents) {
    if (agent.runner === 'custom' || !agent.model) { continue; }
    const aliases = providerAliases(ws.config.providers, agent.runner);
    const resolved = resolveProviderModel(agent.runner, agent.model, aliases);

    if (agent.runner === 'default') {
      checks.push(ok(`model "${agent.id}"`, `${agent.model} — resolved by Claude Code`));
    } else if (resolved && resolved !== agent.model) {
      checks.push(ok(`model "${agent.id}"`,
        `${agent.model} → ${resolved} (providers.${agent.runner}.model_aliases)`));
    } else if (resolved) {
      checks.push(ok(`model "${agent.id}"`, `${resolved}, passed to ${agent.runner} verbatim`));
    } else if (isClaudeTierAlias(agent.model)) {
      checks.push(warn(`model "${agent.id}"`,
        `"${agent.model}" is a Claude tier alias — ${agent.runner} will use its own default model. `
        + `Declare providers.${agent.runner}.model_aliases.${agent.model} to pin one.`));
    }
  }

  return checks;
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Validate workspace, claude binary, env, skills, and run state files')
    .option('--json', 'Output all checks as JSON (exit 1 still signals failures)')
    .action((opts: { json?: boolean }, cmd: Command) => {
      const root = resolveWorkspaceRoot(cmd);
      const json = !!opts.json;

      // Collect every section so --json can emit the whole report at the end.
      // In human mode emitSection prints immediately, preserving the live feel.
      const sections: Array<{ title: string; checks: Check[] }> = [];
      const emitSection = (title: string, checks: Check[]): void => {
        sections.push({ title, checks });
        if (!json) { printSection(title, checks); }
      };

      if (!json) {
        console.log(chalk.bold('\naidlc doctor'));
        console.log(chalk.dim(`workspace: ${root}\n`));
      }

      // ── Workspace ────────────────────────────────────────────────────────
      const wsChecks: Check[] = [];
      // Declared here (not inside the `if (ws)` block) so the summary
      // aggregation below can count skill/runner failures — otherwise a broken
      // skill path is printed in red but doctor still exits 0.
      const skillChecks: Check[] = [];
      let ws: Awaited<ReturnType<typeof WorkspaceLoader.load>> | null = null;

      const wsPath = path.join(root, '.aidlc', 'workspace.yaml');
      if (!fs.existsSync(wsPath)) {
        wsChecks.push(fail('.aidlc/workspace.yaml exists', 'run: aidlc init'));
      } else {
        wsChecks.push(ok('.aidlc/workspace.yaml exists'));
        try {
          ws = WorkspaceLoader.load(root);
          const c = ws.config;
          wsChecks.push(ok('workspace.yaml parses & validates',
            `${c.agents.length} agent${c.agents.length !== 1 ? 's' : ''}, ` +
            `${c.skills.length} skill${c.skills.length !== 1 ? 's' : ''}, ` +
            `${c.pipelines.length} pipeline${c.pipelines.length !== 1 ? 's' : ''}`));
        } catch (err) {
          wsChecks.push(fail('workspace.yaml parses & validates',
            err instanceof Error ? err.message : String(err)));
        }
      }

      emitSection('Workspace', wsChecks);

      // ── Claude binary ─────────────────────────────────────────────────────
      const claudeChecks: Check[] = [];

      let claudeBin = '';
      try {
        claudeBin = execSync('which claude', { encoding: 'utf8', timeout: 5000 }).trim();
        claudeChecks.push(ok('claude binary on PATH', claudeBin));
      } catch {
        claudeChecks.push(fail('claude binary on PATH',
          'install: https://github.com/anthropics/claude-code'));
      }

      if (claudeBin) {
        try {
          const version = execSync('claude --version', {
            encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          claudeChecks.push(ok(`claude --version`, version.split('\n')[0]));
        } catch {
          claudeChecks.push(fail('claude --version returned error',
            'try: claude --version in a terminal'));
        }
      }

      // Auth: AIDLC just shells out to `claude`, so any auth mode Claude Code
      // itself supports is valid here. Recognize them all — Bedrock / Vertex /
      // gateway-token / raw API key — before falling back to the user's own
      // `claude login`, so users on AWS Bedrock (etc.) aren't wrongly told
      // they're "Not authenticated" (issue #55).
      claudeChecks.push(detectAuth(claudeBin));

      // Which account's folder AIDLC reads and writes. Worth stating even in
      // the default case: when a user runs several Claude accounts, "the skills
      // installed but the session can't see them" is always this line.
      const configDir = claudeConfigDir();
      claudeChecks.push(ok('Claude config dir', isDefaultClaudeConfigDir()
        ? configDir
        : `${configDir} (from CLAUDE_CONFIG_DIR)`));
      claudeChecks.push(fs.existsSync(configDir)
        ? ok('config dir exists')
        : fail('config dir exists', `${configDir} not found — run \`claude\` once to create it`));

      emitSection('Claude', claudeChecks);

      // ── Skills ────────────────────────────────────────────────────────────
      if (ws) {
        for (const skill of ws.config.skills) {
          if (skill.builtin) {
            // SkillLoader will validate; for now mark as assumed-ok
            skillChecks.push(ok(`skill "${skill.id}"`, 'builtin'));
          } else if (skill.path) {
            const absPath = resolveDeclaredPath(root, skill.path);
            if (fs.existsSync(absPath)) {
              skillChecks.push(ok(`skill "${skill.id}"`, skill.path));
            } else {
              skillChecks.push(fail(`skill "${skill.id}"`,
                `file not found: ${skill.path}`));
            }
          } else {
            skillChecks.push(fail(`skill "${skill.id}"`, 'no path or builtin declared'));
          }
        }

        // Custom runner paths
        for (const agent of ws.config.agents) {
          if (agent.runner === 'custom' && agent.runner_path) {
            const absPath = resolveDeclaredPath(root, agent.runner_path);
            if (fs.existsSync(absPath)) {
              skillChecks.push(ok(`runner "${agent.id}"`, agent.runner_path));
            } else {
              skillChecks.push(fail(`runner "${agent.id}"`,
                `runner_path not found: ${agent.runner_path}`));
            }
          }
        }

        if (skillChecks.length > 0) {
          emitSection('Skills & runners', skillChecks);
        }
      }

      // ── Harness parity ───────────────────────────────────────────────────
      if (ws) {
        emitSection('Harness parity', parityChecks(root, ws));
        emitSection('Providers', providerChecks(ws));
      }

      // ── Run state ────────────────────────────────────────────────────────
      const runChecks: Check[] = [];
      const runsDir = path.join(root, '.aidlc', 'runs');

      if (!fs.existsSync(runsDir)) {
        runChecks.push(ok('.aidlc/runs/', 'no runs yet'));
      } else {
        const allRuns = RunStateStore.list(root);
        const runFiles = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
        const corrupt  = runFiles.length - allRuns.length;

        runChecks.push(ok(
          `${allRuns.length} run file${allRuns.length !== 1 ? 's' : ''} readable`,
          corrupt > 0 ? `${corrupt} corrupt file(s) skipped` : undefined,
        ));

        const active = allRuns.filter(r => r.status === 'running');
        if (active.length > 0) {
          runChecks.push(ok(
            `${active.length} active run${active.length !== 1 ? 's' : ''}`,
            active.map(r => r.runId).join(', '),
          ));
        }
      }

      emitSection('Runs', runChecks);

      // ── Runtime ──────────────────────────────────────────────────────────
      const nodeVersion = process.versions.node;
      const [nodeMajor] = nodeVersion.split('.').map(Number);
      emitSection('Runtime', [
        nodeMajor >= 18
          ? ok(`Node.js ${nodeVersion}`)
          : fail(`Node.js ${nodeVersion}`, 'upgrade to Node.js 18+'),
      ]);

      // ── Summary ───────────────────────────────────────────────────────────
      // Aggregate across every collected section so no check (incl. skills,
      // runners, runtime) is silently excluded from the exit code.
      const failures = sections.flatMap(s => s.checks).filter(c => !c.pass);

      if (json) {
        console.log(JSON.stringify({
          ok: failures.length === 0,
          failures: failures.length,
          sections,
        }, null, 2));
        if (failures.length > 0) { process.exit(1); }
        return;
      }

      console.log();
      if (failures.length === 0) {
        console.log(chalk.green('✔ All checks passed.'));
      } else {
        console.log(chalk.yellow(`⚠ ${failures.length} check${failures.length !== 1 ? 's' : ''} failed — see above.`));
        process.exit(1);
      }
      console.log();
    });
}
