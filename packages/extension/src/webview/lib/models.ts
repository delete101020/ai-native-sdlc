/**
 * Model choices for the agent modals.
 *
 * Mirrors `@aidlc/core`'s `presets/models.ts`, which is the source of truth for
 * what the presets and the CLI write. It is duplicated rather than imported
 * because the webview bundle must stay free of core's Node dependencies — keep
 * the two in sync when a tier's alias changes (it should not; that is the point
 * of aliases).
 *
 * Aliases come first and are the recommendation: Claude Code resolves `sonnet`
 * / `opus` / `haiku` to the current generation of each tier, so an agent
 * created today survives the next model release. Pinned ids stay available for
 * anyone who needs one specific generation.
 */
export interface ModelChoice {
  value: string;
  label: string;
  hint: string;
}

export const MODELS: ModelChoice[] = [
  { value: 'sonnet', label: 'sonnet', hint: 'Balanced — current Sonnet (recommended)' },
  { value: 'opus',   label: 'opus',   hint: 'Most capable, slower — current Opus' },
  { value: 'haiku',  label: 'haiku',  hint: 'Fastest, cheapest — current Haiku' },
  { value: 'claude-sonnet-5', label: 'claude-sonnet-5', hint: 'Pinned id' },
  { value: 'claude-opus-5',   label: 'claude-opus-5',   hint: 'Pinned id' },
  { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5', hint: 'Pinned id' },
];
