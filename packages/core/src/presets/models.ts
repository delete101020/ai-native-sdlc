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
