// AIDLC core — public exports.
//
// This package is pure TypeScript. No `import 'vscode'`. The extension layer
// (packages/extension) imports from here; the core has zero knowledge of the
// VS Code API and runs identically inside the extension host, a CLI, or a
// future test harness / cloud worker.

export {
  WorkspaceSchema,
  validateWorkspace,
  WorkspaceValidationError,
  normalizeStep,
  stepAgentId,
  stepDagId,
  collectWorkspaceRefIssues,
} from './schema/WorkspaceSchema';
export type {
  WorkspaceConfig,
  AgentConfig,
  SkillConfig,
  SlashCommandConfig,
  PipelineConfig,
  PipelineBudget,
  PipelineStepConfig,
  RecipeConfig,
  NormalizedStep,
  StateConfig,
  PersistenceConfig,
  SidebarConfig,
  SidebarView,
  WorkspaceRefIssue,
} from './schema/WorkspaceSchema';

export {
  assemblePipeline,
  recipePipelineId,
  PipelineAssembleError,
} from './runs/PipelineAssembler';
export type { AssembleOptions } from './runs/PipelineAssembler';

export {
  heuristicClassify,
  buildClassificationPrompt,
  parseClassificationVerdict,
  slugEpicId,
} from './runs/TaskClassifier';
export type { TaskTypeVerdict, Confidence } from './runs/TaskClassifier';

export {
  buildPhaseCatalog,
  buildAdaptationPrompt,
  parseAdaptationVerdict,
  applyAdaptation,
  PipelineAdaptError,
} from './runs/PipelineAdapter';
export type { PhaseCatalogEntry, AdaptationVerdict } from './runs/PipelineAdapter';

export {
  scaffoldEpic,
  mirrorRunStateToEpic,
  mapStepStatusToEpic,
  epicsRoot,
  EpicScaffoldError,
} from './runs/EpicScaffold';
export type {
  EpicStatus,
  ScaffoldEpicArgs,
  ScaffoldEpicResult,
} from './runs/EpicScaffold';

// ── Stage 6: maintain, and the loop back to stage 1 ────────────────
export { SignalSchema, parseSignal, isSignal, SignalParseError } from './maintain/Signal';
export type { Signal } from './maintain/Signal';
export {
  openIncidentEpic,
  openFollowUpEpic,
  renderIntentMarkdown,
  followUpEpicId,
  followUpIdFor,
  existingEpicIds,
  readEpicSignal,
  FOLLOW_UP_ARTIFACT,
  SIGNAL_FILE,
} from './maintain/IncidentLoop';
export type {
  OpenIncidentEpicArgs,
  OpenIncidentEpicResult,
  OpenFollowUpEpicArgs,
  OpenFollowUpEpicResult,
  RenderIntentOptions,
} from './maintain/IncidentLoop';

export { collectContext } from './epics/ContextCollector';
export type { EpicContext } from './epics/ContextCollector';
export { generatePlan, renderPlanMarkdown } from './epics/PlanGenerator';
export type {
  AutopilotPlan,
  AgentAllocation,
  Task,
  ScopeComplexity,
} from './epics/PlanGenerator';

export {
  WorkspaceLoader,
  WorkspaceNotFoundError,
  WorkspaceParseError,
  WORKSPACE_FILENAME,
  WORKSPACE_DIR,
} from './loader/WorkspaceLoader';
export type {
  LoadedWorkspace,
  WorkspaceLoaderOptions,
} from './loader/WorkspaceLoader';

export {
  EnvResolver,
  EnvVarMissingError,
} from './loader/EnvResolver';
export type { EnvResolverOptions } from './loader/EnvResolver';

export {
  SkillLoader,
  SkillNotFoundError,
} from './loader/SkillLoader';
export type { SkillLoaderOptions } from './loader/SkillLoader';

export { PersonaLoader, stripPersonaMetadata } from './loader/PersonaLoader';
export type { LoadedPersona } from './loader/PersonaLoader';

export {
  findProjectInstructions,
  PROJECT_INSTRUCTION_FILES,
} from './loader/projectInstructions';
export type { ProjectInstructions } from './loader/projectInstructions';

export { composeAgentPrompt, stripPersonaDirectives } from './loader/promptComposer';
export type { ComposeInput, ComposedPrompt } from './loader/promptComposer';

export {
  discoverAssets,
  scopePaths,
  targetPath,
} from './loader/AssetDiscovery';
export type {
  AssetScope,
  AssetKind,
  DiscoveredAsset,
  DiscoveryResult,
} from './loader/AssetDiscovery';

export { RunnerRegistry } from './runner/RunnerRegistry';
export { DefaultRunner } from './runner/DefaultRunner';
export type { DefaultRunnerOptions } from './runner/DefaultRunner';
export { CodexRunner } from './runner/CodexRunner';
export type { CodexRunnerOptions } from './runner/CodexRunner';
export {
  claudeMcpRegistrar,
  codexMcpRegistrar,
  mcpRegistrarFor,
  readProjectMcpServer,
  codexConfigPath,
  isCodexMcpConfigured,
} from './runner/mcp';
export type { McpRegistrar, McpCommand, StdioMcpServer } from './runner/mcp';
export { createLineSink, createJsonSink } from './runner/ndjson';
export type { LineSink } from './runner/ndjson';
export { isInsideClaudeCodeSession, hasClaudeLogin, buildClaudeSpawnEnv } from './runner/claudeEnv';
export {
  CustomRunnerLoader,
  validateRunnerExport,
} from './runner/CustomRunnerLoader';
export {
  RunnerValidationError,
  NO_HARNESS_CAPABILITIES,
  harnessCapabilities,
} from './runner/types';
export type {
  AidlcRunner,
  RunnerContext,
  RunnerResult,
  AgentCliWrapper,
  ClaudeCliWrapper,
  HarnessCapabilities,
} from './runner/types';

// ── Pipeline runs (phase 1) ────────────────────────────────────────
export { RunStateStore, FileRunStateStore, RUN_ID_PATTERN } from './runs/RunStateStore';
export type { RunStateBackend } from './runs/RunStateStore';
export { GitRunStateStore } from './runs/GitRunStateStore';
export type { GitRunStateStoreOptions, GitExec } from './runs/GitRunStateStore';
export {
  resolveRunStateBackend,
  activateRunStateBackend,
  activateBackendFromWorkspace,
} from './runs/resolveBackend';
export {
  startRun,
  canStartStep,
  markStepDone,
  approveStep,
  rejectStep,
  rerunStep,
  requestStepUpdate,
  submitAutoReviewVerdict,
  PipelineRunError,
} from './runs/PipelineRunner';
export { checkBudget } from './runs/budget';
export type { BudgetCheckArgs, BudgetVerdict } from './runs/budget';
export { runExecLoop } from './runs/execEngine';
export type { ExecOutcome, ExecOptions, ExecHooks } from './runs/execEngine';
export { verifyRun } from './runs/verifyRun';
export type { VerifyReport, StepDrift } from './runs/verifyRun';
export { renderRunReport } from './runs/runReport';
export { runAutoReview, AutoReviewerError } from './runs/AutoReviewer';
export type { AutoReviewerContext, AutoReviewerFn } from './runs/AutoReviewer';
export { resolvePath } from './runs/RunState';
export type {
  RunState,
  StepRecord,
  StepStatus,
  RunStatus,
  AutoReviewVerdict,
  StepHistoryEntry,
} from './runs/RunState';

// ── Built-in workflow presets (shared by extension + CLI) ──────────
export {
  BUILTIN_WORKFLOWS,
  PHASES,
  pipelineCommandId,
  builtinTemplatesRoot,
  workflowSlug,
  getBuiltinWorkflow,
  getBuiltinWorkflowByPipelineId,
  getBuiltinPipelineSummary,
  getSdlcBuiltinPipelineSummary,
  getAllBuiltinPipelineSummaries,
  getBuiltinRecipeSummaries,
  planRecipeMigration,
  loadBuiltinPreset,
  loadAllBuiltinPresets,
  builtinClaudeCommand,
  sdlcClaudeCommand,
  phaseArtifactFileName,
  getBuiltinArtifactTemplates,
  getSdlcArtifactTemplates,
  resolvePrimaryStack,
  writeBuiltinAutoReviewValidators,
  BUILTIN_PRESET_IDS,
  isBuiltinPreset,
} from './presets/builtinWorkflows';
export type { BuiltinWorkflow, WorkspacePreset as BuiltinWorkspacePreset, WorkspaceRecipe, ArtifactTemplateOptions } from './presets/builtinWorkflows';

// Model tier the built-in presets, the CLI and the wizards all default to.
// Aliases, not pinned ids, so a preset does not age out on the next release.
export {
  PLANNING_MODEL, CODING_MODEL, FAST_MODEL,
  CLAUDE_TIER_ALIASES, isClaudeTierAlias, resolveProviderModel,
} from './presets/models';

// Global Claude-config-dir install of built-in agent/skill files (ext + CLI).
export {
  installGlobalDefaults,
  installWorkflowGlobalsByIds,
  isWorkflowGloballyInstalled,
  uninstallWorkflowGlobalsByIds,
  detectGlobalBuiltinSource,
  DEFAULT_GLOBAL_WORKFLOW_IDS,
} from './presets/globalDefaults';
export { renderTemplate } from './presets/templateRenderer';

// ── Two-layer command model (GH-71) ────────────────────────────────
export {
  CANONICAL_PHASES,
  CANONICAL_PHASE_IDS,
  BACKBONE_COMMAND_ID,
  isCanonicalPhase,
  getCanonicalPhase,
  shortcutCommandId,
  resolveComposition,
  nextEligiblePhase,
  unprovisionedPhases,
  backboneCommandDoc,
  shortcutCommandDoc,
  writeTwoLayerCommands,
  provisionShortcutDocs,
} from './presets/commandModel';
export type {
  CanonicalPhase,
  PhaseComposition,
  EligiblePhase,
  WriteCommandsResult,
} from './presets/commandModel';
// Annotation + epic-memory tooling install (shared by ext + CLI).
export {
  installAnnotationTools,
  isEpicMemoryHookEnabled,
  setEpicMemoryHook,
} from './presets/annotationTools';
export type { AnnotationToolsReport } from './presets/annotationTools';

// ── Compliance profiles / SDLC standard (GH-69) ────────────────────
export {
  BUILTIN_PROFILE_IDS,
  DEFAULT_PROFILE_ID,
  PROFILES_DIR,
  TRACE_RULES,
  ProfileSchema,
  isBuiltinProfileId,
  workspaceStandard,
  resolveStandard,
  listProfileManifests,
  loadProfile,
  loadActiveProfile,
  builtinProfiles,
  UnknownStandardError,
  ProfileLoadError,
} from './profiles/StandardProfile';
export type {
  BuiltinProfileId,
  StandardProfile,
  TraceRule,
  ResolveStandardOptions,
} from './profiles/StandardProfile';

// Path helpers for resolving workspace.yaml-declared paths (`~/` aware).
export { expandHome, resolveDeclaredPath } from './util/paths';

// Claude account/config dir resolution — `~/.claude` unless the user separates
// accounts with `CLAUDE_CONFIG_DIR` / the `aidlc.claude.configDir` setting.
export {
  setClaudeConfigDir,
  getClaudeConfigDirOverride,
  defaultClaudeConfigDir,
  resolveClaudeConfigDir,
  claudeConfigDir,
  isDefaultClaudeConfigDir,
  claudeJsonPath,
  claudeConfigEnv,
  remapClaudePath,
} from './util/claudeHome';
export type { ClaudeHomeOptions } from './util/claudeHome';

// Shared help/knowledge content for `ask` + `guide` (CLI + extension).
export { AIDLC_KNOWLEDGE, AIDLC_CLI_GUIDE_TEXT } from './help/aidlcGuide';

export const AIDLC_CORE_VERSION = '0.1.0';
