/**
 * The model each built-in phase and agent asks for.
 *
 * These are deliberately Claude Code's *aliases* (`opus` / `sonnet` / `haiku`),
 * not pinned ids like `claude-opus-4-7`. An alias always resolves to the
 * current generation of that tier, so a preset written today keeps working
 * after the next model release. A pinned id does not: it silently ages out,
 * and the repo has already paid for that once — the v3.1.0 changelog announced
 * a bump to `claude-sonnet-5` / `claude-opus-4-8`, but only the extension's
 * model picker was updated, leaving the presets and agent templates on the
 * previous generation for several releases.
 *
 * Keep this the single source of truth. Three places used to carry their own
 * default (`builtinWorkflows`, `aidlc agent add`, the wizard picker) and all
 * three had drifted apart.
 *
 * Where the value actually matters: agent templates are copied verbatim into
 * `~/.claude/agents/`, and Claude Code honours their frontmatter `model:`. The
 * `model` field in workspace.yaml is currently informational — `DefaultRunner`
 * does not pass `--model` to the CLI — but it is what the UI shows the user,
 * so it should not lie about which tier a phase runs on.
 */

/** Deep reasoning: intent, spec, architecture, review of a whole design. */
export const PLANNING_MODEL = 'opus';

/** The default working tier: implementation, verification, routine review. */
export const CODING_MODEL = 'sonnet';

/** Cheap and fast: mechanical passes where judgement is not the bottleneck. */
export const FAST_MODEL = 'haiku';

// ── Cross-provider model resolution (MULTI_PROVIDER_ALIGNMENT.md §P1) ───────

/**
 * The three aliases above are Claude Code's own vocabulary. They mean nothing
 * to `codex` or the Gemini CLI, and every existing workspace.yaml is full of
 * them because until now `model` was display-only.
 */
export const CLAUDE_TIER_ALIASES: readonly string[] = [PLANNING_MODEL, CODING_MODEL, FAST_MODEL];

/** Whether a `model:` value is one of Claude Code's tier aliases. */
export function isClaudeTierAlias(model?: string): boolean {
  return !!model && CLAUDE_TIER_ALIASES.includes(model.trim().toLowerCase());
}

/**
 * The model a provider runner should be told to use, or `undefined` for "say
 * nothing and let the CLI pick its own default".
 *
 * Resolution order:
 *   1. `default` (Claude Code) → always `undefined`; it resolves tiers itself.
 *   2. A user-declared alias for this provider → that concrete model id.
 *   3. A Claude tier alias with no declaration → `undefined`, and `doctor`
 *      says so.
 *   4. Anything else → passed through verbatim; `model: gpt-5-codex` means it.
 *
 * Step 3 is why AIDLC ships no built-in tier map. Mapping `sonnet` onto some
 * provider's mid-tier model would be us inventing an equivalence we have not
 * measured, and quietly downgrading a phase the user believed was on its best
 * model — precisely the silent quality change §1a exists to prevent. Worse, we
 * would have to name model ids for a CLI we cannot query, and a wrong `--model`
 * fails the run outright. Step 2 puts the same table within reach, authored by
 * the one person entitled to assert the equivalence (P0/D8).
 */
export function resolveProviderModel(
  provider: string,
  model?: string,
  aliases?: Record<string, string>,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) { return undefined; }
  if (provider === 'default') { return undefined; } // Claude Code resolves tiers itself.

  const declared = aliases?.[trimmed.toLowerCase()]?.trim();
  if (declared) { return declared; }

  return isClaudeTierAlias(trimmed) ? undefined : trimmed;
}
