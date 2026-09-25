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
  producesEntries,
  stepAgentId,
  stepDagId,
  stepSkillAlternatives,
  resolveStepSkills,
  collectWorkspaceRefIssues,
} from './schema/WorkspaceSchema';
export type {
  WorkspaceConfig,
  AgentConfig,
  SkillConfig,
  SlashCommandConfig,
  PipelineConfig,
  PipelineBudget,
  ProviderConfig,
  ProviderRate,
  PipelineStepConfig,
  RecipeConfig,
  NormalizedStep,
  ProducesEntry,
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
  commitApprovedArtifacts,
  resolveArtifactCommitConfig,
} from './runs/EpicArtifactCommit';
export type {
  ArtifactCommitConfig,
  CommitApprovedArtifactsArgs,
  CommitApprovedArtifactsResult,
} from './runs/EpicArtifactCommit';

export {
  scaffoldEpic,
  mirrorRunStateToEpic,
  mapStepStatusToEpic,
  epicsRoot,
  EpicScaffoldError,
  lockedEpicDirError,
} from './runs/EpicScaffold';
export type {
  EpicStatus,
  ScaffoldEpicArgs,
  ScaffoldEpicResult,
} from './runs/EpicScaffold';

export {
  setEpicDescription,
  EpicDescriptionError,
} from './runs/EpicDescription';
export type {
  EpicDescriptionEdit,
  EpicDocOutcome,
} from './runs/EpicDescription';

export {
  planEpicWorkflowSwitch,
  stageEpicWorkflowSwitch,
  applyEpicWorkflowSwitch,
  epicWorkflowLock,
  canSwitchEpicWorkflow,
  EpicWorkflowSwitchError,
} from './runs/EpicWorkflowSwitch';
export type {
  EpicWorkflowTarget,
  EpicWorkflowSwitchPlan,
  EpicWorkflowSwitchResult,
} from './runs/EpicWorkflowSwitch';

export {
  planAddEpicStep,
  planRemoveEpicStep,
  planSetEpicStepGates,
  commitEpicStepEdit,
  describeGateEffect,
  resolveStepRef,
  EpicStepEditError,
} from './runs/EpicStepEdit';
export type {
  EpicStepSpec,
  EpicStepPosition,
  EpicStepEditPlan,
  EpicStepGateSpec,
  EpicStepGateChange,
  EpicStepGatePlan,
  CommitEpicStepEditArgs,
} from './runs/EpicStepEdit';

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

// ── Follow-up manifests: any finished epic handing work forward ─────
export {
  FollowUpItemSchema,
  FollowUpManifestSchema,
  FollowUpsParseError,
  parseFollowUps,
  readEpicFollowUps,
  followUpsOf,
  followUpChildId,
  openManifestFollowUp,
  FOLLOW_UPS_FILE,
  FOLLOW_UP_INTENT,
} from './epics/FollowUps';
export type {
  FollowUpItem,
  FollowUpManifest,
  OpenedFollowUp,
  OpenManifestFollowUpArgs,
  OpenManifestFollowUpResult,
} from './epics/FollowUps';
export {
  FOLLOW_UP_HOOK_KEYS,
  FOLLOW_UP_HOOK_PLACEHOLDERS,
  collectFollowUpHookIssues,
  stepProducesFollowUps,
} from './schema/FollowUpHookSchema';
export type { FollowUpHookKey, FollowUpHookIssue } from './schema/FollowUpHookSchema';
export {
  FOLLOW_UP_HOOKS_LEDGER,
  FOLLOW_UP_HOOK_TIMEOUT_MS,
  epicPipelineId,
  resolveFollowUpHooks,
  fillFollowUpHookCommand,
  runFollowUpHook,
  followUpHookLedgerPath,
  readFollowUpHookLedger,
  writeFollowUpHookLedger,
  trackFollowUpChildren,
  applyFollowUpHookRun,
  pendingFollowUpDone,
  followUpHookFailures,
} from './epics/FollowUpHooks';
export type {
  FollowUpHooks,
  FollowUpHookChild,
  FollowUpHookEvent,
  FollowUpHookPayload,
  FollowUpHookRun,
  RunFollowUpHookArgs,
  FollowUpHookLedger,
  FollowUpDoneBySync,
  LedgerRun,
} from './epics/FollowUpHooks';

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
  recipesDrawingFrom,
  dropRecipeStep,
  dropRecipesForPipeline,
} from './loader/recipeRefs';
export type { RecipeCarrier, RecipeRefEdit } from './loader/recipeRefs';

export {
  renameAgentRefs,
  renameSkillRefs,
  agentReferences,
  skillReferences,
  unusedAfterStepRemoval,
} from './loader/renameRefs';
export type {
  WorkspaceRefCarrier,
  IdRenameEdit,
  DanglingRefs,
  UnusedAgent,
} from './loader/renameRefs';

export {
  EPIC_PIPELINE_FILENAME,
  epicPipelinePath,
  mergeEpicPipelines,
  splitEpicPipelines,
  writeEpicPipelines,
  stageEpicPipeline,
  unstageEpicPipeline,
  epicOwningPipeline,
  planEpicPipelineExtraction,
  epicPipelineReport,
} from './loader/EpicPipelineStore';
export type {
  EpicPipelineConflict,
  MergeEpicPipelinesResult,
  SplitEpicPipelinesResult,
  ExternalEpicPipeline,
  EpicPipelineExtraction,
} from './loader/EpicPipelineStore';

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
// The workspace-wide artifact language, and the prompt section that states it.
export {
  ARTIFACT_LANGUAGE_HEADING,
  artifactLanguageSection,
  commandBodyPredatesArtifactLanguage,
  resolveArtifactLanguage,
} from './loader/artifactLanguage';
// Per-checkout epic id prefix, and the id suggester both front doors share.
export {
  EPIC_ID_PREFIX_KEY,
  EPIC_ID_PREFIX_PATTERN,
  deriveEpicIdPrefix,
  epicIdDateStamp,
  resolveEpicIdPrefix,
  resolveEpicIdPrefixChain,
  suggestEpicId,
} from './loader/epicId';
export type { EpicIdPrefixResolution, EpicIdPrefixSource } from './loader/epicId';
// The per-checkout settings file the prefix actually lives in.
export {
  USER_CONFIG_IGNORE_LINE,
  USER_CONFIG_RELPATH,
  ensureUserConfigIgnored,
  readGitUserName,
  readUserConfig,
  userConfigPath,
  writeUserEpicIdPrefix,
} from './loader/userConfig';
// Per-epic depth of work, and the prompt section that states it.
export {
  STRICT_MODE_HEADING,
  STRICT_MODE_KEY,
  commandBodyPredatesStrictMode,
  epicStrictMode,
  resolveEpicStrictMode,
  strictModeSection,
} from './loader/strictMode';
// Epic tags — free text in, one canonical SCREAMING-KEBAB form on disk.
export {
  EPIC_TAGS_KEY,
  MAX_TAG_LENGTH,
  applyTagEdit,
  epicMatchesTags,
  normalizeTag,
  normalizeTags,
  readEpicTags,
} from './loader/epicTags';
export { commandBodyIsStale } from './presets/commandBodyFreshness';
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
export { DefaultRunner, claudeModelArg } from './runner/DefaultRunner';
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
  RunnerUsage,
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
  canUndoStepDone,
  undoStepDone,
  approveStep,
  rejectStep,
  rerunStep,
  requestStepUpdate,
  chooseStepSkill,
  canRerunApprovedStep,
  rerunApprovedStep,
  dirtyUpstreamOf,
  submitAutoReviewVerdict,
  retryAutoReview,
  PipelineRunError,
} from './runs/PipelineRunner';
export {
  deriveRunProgress,
  isRunComplete,
  isStepOptional,
  isActiveStatus,
  weighStepProgress,
} from './runs/runProgress';
export type { RunProgress, ProgressStep, ProgressWeighting } from './runs/runProgress';
export { checkBudget } from './runs/budget';
export type { BudgetCheckArgs, BudgetVerdict, CostAccounting, CostConfidence } from './runs/budget';
export {
  BUILTIN_RATES,
  mergeRates,
  ratesFromConfig,
  providerAliases,
  estimateCostUsd,
} from './runs/pricing';
export type { ModelRate, PricingTable, CostEstimate } from './runs/pricing';
export { runExecLoop } from './runs/execEngine';
export type { ExecOutcome, ExecOptions, ExecHooks } from './runs/execEngine';
export { verifyRun } from './runs/verifyRun';
export type { VerifyReport, StepDrift } from './runs/verifyRun';
export { renderRunReport } from './runs/runReport';
export { runAutoReview, AutoReviewerError } from './runs/AutoReviewer';
export type { AutoReviewerContext, AutoReviewerFn } from './runs/AutoReviewer';
export { resolvePath, stepIdentity, migrateRunState, RUN_STATE_SCHEMA_VERSION } from './runs/RunState';
export {
  reconcileRunSteps,
  describeDrift,
  withBackfilledStepNames,
} from './runs/reconcileRun';
export type {
  RunReconciliation,
  StepAlignment,
  StepAlignmentKind,
} from './runs/reconcileRun';
export type {
  RunState,
  StepRecord,
  StepStatus,
  RunStatus,
  AutoReviewVerdict,
  StepHistoryEntry,
  StepDirtyMark,
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
// Project-file provisioning for a built-in workflow: `.claude/commands/*` and
// `.aidlc/aidlc-templates/<pipelineId>/*`. Shared so `preset apply` produces
// the same workspace from the CLI as it does from the extension.
export {
  writeWorkflowCommands,
  writeWorkflowArtifactTemplates,
  provisionWorkflowFiles,
  provisionDeclaredWorkflows,
  relativeEpicRoot,
} from './presets/workflowProvisioning';
export type {
  ProvisionOptions,
  ProvisionResult,
} from './presets/workflowProvisioning';
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
// accounts with `CLAUDE_CONFIG_DIR` / the `aidlcNative.claude.configDir` setting.
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

// Spawnable form of a CLI name — resolves Windows npm .cmd shims.
export { resolveCommand, clearResolveCommandCache } from './util/resolveCommand';
export type { ResolvedCommand } from './util/resolveCommand';

// Shared help/knowledge content for `ask` + `guide` (CLI + extension).
export { AIDLC_KNOWLEDGE, AIDLC_CLI_GUIDE_TEXT } from './help/aidlcGuide';

export const AIDLC_CORE_VERSION = '0.1.0';
