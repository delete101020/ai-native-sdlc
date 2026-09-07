/**
 * Provisioning the *project* files a built-in workflow needs: the slash
 * commands under `.claude/commands/` and the artifact templates under
 * `.aidlc/aidlc-templates/<pipelineId>/`.
 *
 * These used to live only in the extension — `writeBuiltinClaudeCommands` in
 * `presetWizards.ts` and `ensureWorkflowTemplates` on the workspace webview —
 * while the CLI's `preset apply` merged workspace.yaml and stopped there. Two
 * front doors, two different workspaces: applying `ai-native` from the CLI
 * declared `/ai-native-full-intent` in `slash_commands` but wrote no file for
 * it, so the panel's "Run with Claude" button launched a command Claude had
 * never heard of. Same for templates, which left every scaffolded epic with an
 * empty `artifacts/`.
 *
 * The orchestration lives here so both callers get the same result. Everything
 * it composes with (`loadBuiltinPreset`, `builtinClaudeCommand`,
 * `getBuiltinArtifactTemplates`) was already in core; only the loop was not.
 */
import * as fs from 'fs';
import * as path from 'path';

import { WORKSPACE_DIR } from '../loader/WorkspaceLoader';
import {
  type ArtifactTemplateOptions,
  type BuiltinWorkflow,
  type WorkspacePreset,
  builtinClaudeCommand,
  getBuiltinArtifactTemplates,
  getBuiltinWorkflowByPipelineId,
  loadBuiltinPreset,
  pipelineCommandId,
} from './builtinWorkflows';
import { writeTwoLayerCommands } from './commandModel';

/**
 * Where epics live, per `state.root` in workspace.yaml — relative, because
 * that is the form command bodies quote back at the reader.
 * {@link import('../runs/EpicScaffold').epicsRoot} resolves the same setting
 * to an absolute path for file I/O.
 */
export function relativeEpicRoot(doc: { state?: unknown } | null | undefined): string {
  const state = doc?.state as Record<string, unknown> | undefined;
  const root = state?.root;
  return typeof root === 'string' && root.trim() ? root : 'docs/epics';
}

export interface ProvisionOptions extends ArtifactTemplateOptions {
  /** Epic root baked into command bodies. Defaults to `docs/epics`. */
  epicRoot?: string;
  /** Replace files that already exist. Off by default — hand edits survive. */
  overwrite?: boolean;
}

export interface ProvisionResult {
  /** Absolute paths of command files written this call. */
  commands: string[];
  /** Absolute paths of artifact templates written this call. */
  templates: string[];
}

/**
 * Write `.claude/commands/<pipelineId>-<phase>.md` for every phase of
 * `workflow`, plus the pipeline-agnostic two-layer set (`/intent`, `/spec`, …
 * and the `/aidlc` backbone).
 *
 * The namespaced files carry the composed persona + skill body inline, so they
 * work with no other file present. The two-layer set resolves the same wiring
 * at runtime from the epic's pipeline binding, and is written once regardless
 * of how many workflows are installed.
 */
export function writeWorkflowCommands(
  root: string,
  workflow: BuiltinWorkflow,
  preset: WorkspacePreset,
  opts: ProvisionOptions = {},
): string[] {
  const epicRoot = opts.epicRoot ?? 'docs/epics';
  const overwrite = opts.overwrite ?? false;
  const commandsDir = path.join(root, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });

  const written: string[] = [];
  for (const phase of workflow.phases) {
    // Namespaced by pipeline id so two workflows in one project do not
    // overwrite each other's commands.
    const file = path.join(commandsDir, `${pipelineCommandId(workflow.pipelineId, phase.id)}.md`);
    if (fs.existsSync(file) && !overwrite) { continue; }
    const skillBody = preset.skillContents[phase.id] ?? `# ${phase.name}\n\n${phase.description}\n`;
    // The pipeline id is also the artifact-template folder name, so the
    // command body can point the agent at the blank template for its own
    // artifact — `scaffoldEpic` no longer copies it into the epic.
    fs.writeFileSync(
      file,
      builtinClaudeCommand(phase, skillBody, epicRoot, workflow.pipelineId),
      'utf8',
    );
    written.push(file);
  }

  written.push(...writeTwoLayerCommands(root, { epicRoot, overwrite }).written);
  return written;
}

/**
 * Drop the bundled artifact templates for `workflow` into
 * `.aidlc/aidlc-templates/<pipelineId>/`, which is where
 * {@link import('../runs/EpicScaffold').scaffoldEpic} seeds a new epic's
 * `artifacts/` from.
 */
export function writeWorkflowArtifactTemplates(
  templatesRoot: string,
  root: string,
  workflow: BuiltinWorkflow,
  opts: ProvisionOptions = {},
): string[] {
  const overwrite = opts.overwrite ?? false;
  const dir = path.join(root, WORKSPACE_DIR, 'aidlc-templates', workflow.pipelineId);
  fs.mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const templates = getBuiltinArtifactTemplates(templatesRoot, workflow, {
    stacks: opts.stacks,
    lookupKeys: opts.lookupKeys,
  });
  for (const [fileName, content] of Object.entries(templates)) {
    const dest = path.join(dir, fileName);
    if (fs.existsSync(dest) && !overwrite) { continue; }
    fs.writeFileSync(dest, content, 'utf8');
    written.push(dest);
  }
  return written;
}

/** Both halves for one workflow. */
export function provisionWorkflowFiles(
  templatesRoot: string,
  root: string,
  workflow: BuiltinWorkflow,
  preset: WorkspacePreset,
  opts: ProvisionOptions = {},
): ProvisionResult {
  return {
    commands: writeWorkflowCommands(root, workflow, preset, opts),
    templates: writeWorkflowArtifactTemplates(templatesRoot, root, workflow, opts),
  };
}

/**
 * Provision every built-in workflow whose pipeline id appears in `pipelineIds`
 * — i.e. what this workspace has actually declared.
 *
 * Ids that match no built-in workflow are skipped: a hand-authored or
 * recipe-assembled pipeline (`EPIC-001`) has no bundled files to install.
 * Idempotent, so it is safe on a hot path such as "ensure the command files
 * exist before launching Claude", which is what heals a workspace that was set
 * up by an older build.
 */
export function provisionDeclaredWorkflows(
  templatesRoot: string,
  root: string,
  pipelineIds: readonly string[],
  opts: ProvisionOptions = {},
): ProvisionResult {
  const result: ProvisionResult = { commands: [], templates: [] };
  const seen = new Set<string>();
  for (const id of pipelineIds) {
    const workflow = getBuiltinWorkflowByPipelineId(id);
    if (!workflow || seen.has(workflow.id)) { continue; }
    seen.add(workflow.id);
    const one = provisionWorkflowFiles(
      templatesRoot,
      root,
      workflow,
      loadBuiltinPreset(templatesRoot, workflow),
      opts,
    );
    result.commands.push(...one.commands);
    result.templates.push(...one.templates);
  }
  return result;
}
