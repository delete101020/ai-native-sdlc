# Changelog

## 3.6.2

Switching Claude accounts without editing JSON. `aidlc.claude.configDir` landed
in 3.6.0 but was findable only by knowing its id — the Settings UI lists it
under a generic "AIDLC" section, which is indistinguishable from the upstream
extension's when both are installed. And a user with three accounts had no way
to keep a shortlist, or to tell at a glance which account the current window
was talking to.

Claude Code still runs exactly one account per process — it reads a single
`CLAUDE_CONFIG_DIR` — so this does not make several accounts active at once.
What it does is make the *one* active account explicit and one click away, and
`aidlc.claude.configDir` stays `scope: resource`, so three windows on three
workspaces genuinely hold three accounts in parallel.

### Added

- feat(extension): **AIDLC: Switch Claude Account** — a quick pick over the
  saved accounts, plus "Enter path…" and "Browse…". Each entry shows the email
  recorded in that folder's `.claude.json`, so the account is identified by who
  is signed in rather than by a path the user has to recognise. After picking,
  it asks whether to apply to this workspace (the default, and how parallel
  accounts work) or to all windows.
- feat(extension): `aidlc.claude.configDirs` — the saved list, as
  `{ label?, path }` entries. It is an address book only; it never changes
  which account is active. `~/.claude` is always offered even when unlisted, so
  returning to the default is one pick away.
- feat(extension): a status bar item showing the active account, which opens
  the switcher. Hidden for anyone who has configured nothing — it would be pure
  noise with a single account — and appears as soon as a config dir or a saved
  list exists.

### Changed

- refactor(extension): the config-dir resolution, the change listener and the
  reload prompt moved out of `extension.ts` into `v2/claudeAccounts.ts`, beside
  the new UI. Behaviour is unchanged, including the ordering constraint — it
  still runs before anything touches the global Claude folder.
- docs(extension): `aidlc.claude.configDir`'s description now points at the
  command instead of leaving the setting as the only entry point.

## 3.6.1

Model defaults stop aging out. Every built-in phase and agent template asked
for a pinned model id (`claude-opus-4-7`, `claude-sonnet-4-6`), and three
places each kept their own copy of the default. That had already failed once:
the v3.1.0 changelog announced a bump to the then-current generation, but only
the extension's model picker was updated, so presets and agent templates stayed
on the previous generation for several releases while the changelog said
otherwise.

### Changed

- feat(presets): built-in phases and agent templates now ask for Claude Code's
  model *aliases* — `opus`, `sonnet`, `haiku` — which resolve to the current
  generation of each tier. A workspace created today does not need editing
  after the next model release. Aliases and pinned ids are both still accepted
  in `workspace.yaml`; this only changes what the presets write.
- feat(core): the three defaults live in one module, `presets/models.ts`
  (`PLANNING_MODEL` / `CODING_MODEL` / `FAST_MODEL`), exported from
  `@aidlc/core`. `builtinWorkflows`, `aidlc agent add` and the extension's
  agent wizard all read from it instead of carrying their own literal —
  `aidlc agent add` had drifted furthest, still defaulting to an id two
  generations behind the presets.
- feat(extension): all three model pickers — the quick-pick wizard and the Add
  / Edit Agent modals — offer the aliases first (recommended) and keep pinned
  ids below, refreshed to the current models. The two modals had their own
  copy-pasted list; it now lives in one `webview/lib/models.ts`.

### Fixed

- fix(presets): agent template frontmatter is copied verbatim into
  `~/.claude/agents/`, where Claude Code honours `model:` — so a stale id there
  reached the runtime, unlike the informational `model` field in
  `workspace.yaml`. New tests fail if a pinned `claude-*` id reappears in a
  built-in phase or an agent template.

## 3.6.0

Multi-account support. On a machine with more than one Claude account
(personal / work), the accounts are separated by *config dir* — `~/.claude`
holds one account's agents, skills, settings, plugins and session logs, and
`~/.claude.json` its login. AIDLC hardcoded `~/.claude` in ~18 places, so it
always read and wrote the default account no matter which one the session was
actually using: `aidlc globals install` wrote seven `aidlc-native-*.md` files
the running session could not see, and the token monitor read an empty
`projects/` — both with no error.

### Added

- feat(core): `claudeConfigDir` and friends in `@aidlc/core` — one resolution of
  the active Claude config dir, from (in order) an explicit argument, the
  process-wide override the extension installs from its setting,
  `$CLAUDE_CONFIG_DIR` (what the CLI itself reads), then `~/.claude`. Every
  global path AIDLC touches now goes through it: workflow agents/skills
  (`globals install` / `uninstall`), the annotation tools and the epic-memory
  hook, global-scope asset discovery, MCP registration, the token monitor and
  epic token attribution, the OTel receiver, and the agents-observe plugin
  lookup.
- feat(extension): `aidlc.claude.configDir` setting, **workspace**-scoped, so
  one window is pinned to one account — the repo you open decides which Claude
  account the phases run under, rather than which terminal you launched from.
  Changing it offers a window reload, since long-lived watchers hold the old dir.
- feat(extension): every `claude` AIDLC starts carries the account with it —
  `CLAUDE_CONFIG_DIR` is injected into the four `claude` terminals, the
  `buildClaudeSpawnEnv` spawn path (so `ask`, the runner and `claude mcp list`
  follow too), and the ast-graph MCP registration. Nothing is injected on a
  single-account machine, so the environment stays clean by default.
- feat(cli): `aidlc doctor` reports the config dir in use and whether it exists.
  When skills "installed but the session can't see them", this is the line.

### Fixed

- fix(core): `hasClaudeLogin` probed `~/.claude.json` unconditionally. With a
  pinned account it would report "no login", `buildClaudeSpawnEnv` would then
  keep an inherited `ANTHROPIC_API_KEY` instead of stripping it, and the spawned
  CLI would fail with "Invalid API key" — the exact failure that module exists
  to prevent. It now follows the active dir. Note the asymmetry, verified
  against the CLI rather than assumed: `.claude.json` sits *beside* the default
  `~/.claude` but *inside* a custom `CLAUDE_CONFIG_DIR`.

### Changed

- refactor(core): `expandHome` resolves a declared `~/.claude/…` onto the active
  config dir, so `workspace.yaml` keeps the portable `~/.claude/skills/<f>.md`
  form and still resolves per account. Other `~/` paths — including AIDLC's own
  `~/.aidlc/observe-data` — are untouched, and the workspace's `.claude/` is
  project data that never moves.
- refactor(core): `isEpicMemoryHookEnabled` / `setEpicMemoryHook` take an
  optional config dir instead of a required home dir; callers pass nothing.

## 3.5.1

A patch on top of 3.5.0: one real bug in `aidlc doctor`, and the onboarding
documentation this fork needs because it is distributed by hand.

### Fixed

- fix(cli): `aidlc doctor` reported every skill declared as `~/.claude/skills/…`
  as `file not found`, even when the file was installed and runs using it
  succeeded. It resolved declared paths with `path.resolve(root, declared)`,
  which treats `~` as an ordinary directory name and yields
  `<root>/~/.claude/…` — a path that never exists. Since `preset apply
  ai-native` writes exactly that path form for all seven native skills, a
  correct install looked broken. The same defect affected `doctor`'s custom
  runner check and `aidlc skill show` / `skill add --path`.

### Changed

- refactor(core): the `~/` expansion that `SkillLoader` and the extension's
  workspace webview each carried a private copy of is now one exported helper —
  `expandHome` / `resolveDeclaredPath` in `@aidlc/core`. Three copies were how
  the `doctor` path came to be missing one.

### Docs

- docs: **`ONBOARDING.md`** — a setup and workflow guide for a second person on
  the team: prerequisites, both local installs, registering the approval-gate
  hook (which a clone does **not** get, since `.claude/settings.json` is
  gitignored), the seven phases and four recipes, and how the flow is driven
  from the extension versus the CLI.
- docs(extension): the Getting Started step still said "install from the VS Code
  Marketplace or Open VSX", which is not true of this fork; it now gives the
  `.vsix` build-and-install commands. Requirements gained the `hueanmy.aidlc`
  clash warning.

## 3.5.0

First release of this fork. Upstream (`aidlc-io/aidlc`, published as
`hueanmy.aidlc`) stops at 3.4.1; everything below is added on top of it and is
distributed only as a locally built `.vsix` plus a locally linked CLI — there is
no Marketplace, Open VSX or npm listing for this build.

### Added — the AI-Native SDLC Playbook workflow

- feat(workflow): **`ai-native-pipeline`**, a third built-in workflow alongside
  `aidlc-workflow` and `speckit-pipeline` (neither is changed). It runs the
  playbook's six stages as seven phases — `intent` → `spec` → `build-plan` →
  `implement` → `verify` → `review` → `maintain` — producing `intent.md`,
  `spec.md`, `plan.md`, `implement.md`, `verify.md`, `review.md` and
  `incident.md`. Six personas and six skills ship under `templates/ainative/`,
  all `native-`-prefixed so the flat `~/.claude/{agents,skills}` namespace stays
  collision-free. Apply it with `aidlc preset apply ai-native` or from the
  Builder. Recipes: `native-quick`, `native-full`, `native-spike`,
  `native-incident`.
- feat(commands): six new canonical phases (`intent`, `spec`, `build-plan`,
  `verify`, `review`, `maintain`) join the two-layer command model, so each gets
  a shortcut command and `/aidlc <epic> [phase]` dispatches to it. `plan` keeps
  its AIDLC meaning (scaffold + PRD); the playbook's implementation plan is
  `build-plan` with `plan.md` as its artifact.
- feat(review): **stage 5 is a phase, not a checklist.** `review` depends on
  `verify`, is human-gated, reads the diff locally against the policies in
  `CLAUDE.md`, and writes `review.md`. It declares `capabilities: ['github']` —
  a declarative permission, inert until a github MCP server is configured. No CI
  credentials and no remote required.
- feat(hooks): **the approval gate runs in the tooling.**
  `.claude/hooks/aidlc-approval-gate.py` is a `PreToolUse` hook that blocks
  force-pushes to protected branches, staging credential-shaped files (`.env`,
  `*.pem`), and hand-edits of pipeline-owned run state (`state.json`), each with
  the reason on stderr. It fails open on input it cannot parse.
- feat(maintain): **stage 6 closes the loop back to stage 1.** A production
  signal (`source` / `observedAt` / `symptom` / `scope` / `evidence`, Zod-parsed)
  opens an incident epic; the diagnosis then opens the follow-up epic with its
  `intent.md` already written, and anything the signal did not establish is
  rendered as an explicit open question rather than a guess. `maintain` is the
  only phase with no human gate — a signal does not wait for office hours; the
  gate moved to stage 1 of the epic it opens.
- feat(cli): **`aidlc maintain`** — stage 6's front door, and the rule that every
  new phase is runnable from a terminal before it gets a button:
  - `aidlc maintain --signal <file>` (`-` reads stdin) registers a signal as an
    `INC-…` epic and parks the payload at `docs/epics/<epic>/signal.json`, where
    the `native-maintain` skill looks for it.
  - `aidlc maintain follow-up <epic>` opens the `INC-…-FIX` epic the diagnosis
    calls for, reading the signal back from disk so it need not be repeated.
    `--problem` / `--who-hurts` / `--cost` / `--done` / `--question` fill
    `intent.md`, or `--intent <file>` supplies the markdown verbatim.
  - Both accept `--recipe` / `--pipeline` / `--from` / `--epic` / `--json`.
- feat(core): `Signal.ts` and `IncidentLoop.ts` — `parseSignal`,
  `openIncidentEpic`, `openFollowUpEpic`, `renderIntentMarkdown`,
  `readEpicSignal`, `followUpEpicId`, `followUpIdFor`. `@aidlc/core` is the API;
  the extension and the CLI are both callers, and neither holds logic the other
  needs.
- feat(epics): `scaffoldEpic` gains `seedArtifacts` — a caller that already knows
  an artifact's content can hand it to the new epic, so stage 6 creates the
  follow-up with a real `intent.md` instead of a blank template. Filenames only;
  a key with a path separator is rejected.

### Changed

- chore(identity): `publisher` is now `delete101020` (extension id
  `delete101020.aidlc`) and every `repository` / `homepage` / `bugs` URL points at
  this fork. The `aidlc.*` command namespace is deliberately **unchanged** — see
  the migration note below. The upstream sponsor links are removed from package
  metadata and kept as a credit line in the READMEs instead.
- docs: READMEs state plainly that this build is installed from a local `.vsix` /
  `npm link` and is published nowhere; `LICENSE` keeps the original MIT copyright
  line and adds this fork's.

### Migration

Nothing to migrate. Command ids, settings, `workspace.yaml` and existing epics
are byte-compatible with 3.4.1 — the new workflow is additive. If both this build
and upstream `hueanmy.aidlc` are installed, **disable one**: they contribute the
same `aidlc.*` commands.

## 3.4.1

### Fixed

- fix(annotron): **GH-84: Mermaid flowchart edge labels no longer render broken.** merslim renders flowchart *edge* labels verbatim — unlike node labels it doesn't strip the wrapping `"…"` quotes or turn `<br/>` into line breaks — so a label like `-.->|"customer knows,<br/>but cannot tell CF"|` came out with visible quotes and a literal `<br/>` that overflowed the edge. Such flowcharts now fall back to the client-side mermaid runtime (as sequence/state/mindmap already do), which lays the label out faithfully. Flowcharts with plain edge labels still use merslim's offline SVG unchanged.
- fix(annotron): **GH-83 (part 3): the browser now auto-opens on Windows.** `openBrowser` spawned the `start` command directly, but `start` is a `cmd.exe` builtin, not an executable — on Windows the spawn threw `ENOENT`, so clicking **Feedback**/**Preview** started the server but never opened the page, forcing the user to hunt for the URL in the chat log. It now launches via `cmd /c start "" <url>`. macOS/Linux paths are unchanged. (GH-83 parts 1 & 2 — Mermaid not rendering in the HTML view, and MD→HTML latency with no hot reload — were already resolved in 3.4.0, which serves the `.md` directly through annotron with on-the-fly rendering and file-watch reload.)

## 3.4.0

### Annotron diagram rendering + review fixes (customer-reported)

- fix(annotron): **Mermaid diagrams now render for every type**. Sequence, state, and mindmap diagrams (which merslim can't lay out headless) previously fell back to a dark ASCII box; they now render as real diagrams via a lazily-injected client-side mermaid runtime. merslim SVG is still used for the 11 headless types (flowchart, class, er, pie, gantt, journey, timeline, c4, architecture, gitgraph, quadrant) — offline, no runtime. Any unrecognized type also falls through to mermaid, so nothing renders as raw code anymore.
- fix(annotron): the **Feedback** button opens annotron on the `.md` (annotron renders it, diagrams included) instead of feeding it a static `md-to-html` render — so the review shows diagrams and each round still logs to the step's history.
- fix(annotron): "Open HTML" → **Preview** — opens the artifact in annotron (diagrams, read-only) rather than a static HTML file.
- fix(annotron): the annotron server starts reliably from VS Code-launched terminals (strip `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`) and stays up after **Done** (no more empty pane from an unregistered file).
- feat(annotron): inline text edit in Annotate mode — selecting plain text offers **Edit** beside Comment to retype/delete it straight into the `.md` (shown only when the selection maps to a single exact run in the source).

### Autopilot (experimental, off by default)

- feat(autopilot): core auto-run engine (`runExecLoop`) extracted into `@aidlc/core` and an LLM-driven pipeline adapter (context → classify → assemble → adapt). Dormant until wired into the UI; gated behind `aidlc.autopilot.enabled`.

## 3.3.0

- fix(builder): custom pipelines created/edited inline now generate their slash commands — `.claude/commands/<pipelineId>-<step>.md` plus a matching `slash_commands` entry in `workspace.yaml` — for every named step. Previously "Run step" on a custom pipeline executed `/<pipelineId>-<step>` with no backing command file and failed with *command not found*. Idempotent: hand-authored command files and existing entries are left untouched. (Re-save an older custom pipeline once to backfill.)
- feat(autopilot): introduce **aidlc-autopilot** (experimental, "coming soon") — collects epic context and generates a recommended plan (`context.json` + `autopilot-plan.{json,md}`) at epic-scaffold time. Gated behind the new `aidlc.autopilot.enabled` setting and **off by default**; when disabled, epics scaffold exactly as before.
- feat(workflow): rename the default workflow `sdlc-parallel-pipeline` → `aidlc-workflow` and pipeline `sdlc-parallel-full` → `aidlc-workflow-full`, aligning naming with the AIDLC brand.

## 3.1.0

### Annotron 1.0 Integration

- feat(annotron): upgrade to v1.0.0 with major new features:
  - **Markdown rendering with Mermaid diagrams** — view `.md` files with inline flowchart, sequence, UML, ER, C4, architecture, Gantt, timeline diagrams
  - **Editable Markdown pane** — edit Markdown source directly in annotron; press Save (⌘/Ctrl+S) to re-render HTML
  - **Outline navigation sidebar** — auto-generated sidebar for h1–h4 headings in long docs; one-click jump to sections
  - **Auto-apply feedback loop** — integrated agent loop engineering: send annotations → watch Claude apply changes live in real-time
  - **Live activity mirror** — stream of agent's tool calls (Read/Edit/Bash/Run) visible in sidebar during execution
  - **Image attachments** — paste/upload images into annotations and replies
  - **Permission approval in browser** — approve/deny Claude Code tool permissions directly in annotation UI

### Skill Discovery & Agent Picker Improvements

- fix(extension): improve file watcher pattern (`.claude/**`) reliability. Added manual refresh button (🔄) to sidebar and AIDLC command palette command for instant discovery without VSCode restart.
- fix(wizards): skill picker in agent creation now includes discovered skills (not just `workspace.yaml`-declared ones). Skills created via `aidlc.addSkill` immediately appear without restart.
- fix(workspaceWebview): deduplicate skills and agents when declared in both `workspace.yaml` AND discovered in `.claude/skills/`. Uses precedence: aidlc > project > global. Each skill ID now appears once; single checkbox per skill.

### Model Version Updates

- fix(models): update Claude model defaults to current versions:
  - `claude-sonnet-4-6` → `claude-sonnet-5` (latest, balanced default)
  - `claude-opus-4-7` → `claude-opus-4-8` (current most capable)
  - `claude-haiku-4-5-20251001` (unchanged)

## 2.6.0

### Discovery gate (GH-76)

- feat(sdlc): a new **`discovery-gate`** skill, shipped as an AIDLC default — the mirror image of `/annotate-artifact`. Where that reviews a *finished* artifact, this runs at the **start** of a phase: when the agent has open questions before it can write a good artifact, it turns them into a point-and-click questionnaire (`DISCOVERY.md`), opens it in annotron, blocks until you finalize, and applies your answers **back to the Markdown** (canonical), then resumes the phase from the confirmed choices.
- feat(sdlc): the **Plan** phase runs the gate up front and writes a `## Discovery decisions` section into `PRD.md`; **Design** runs it when open questions surface while writing the plan. Discovery is a **gate, not a phase** — no new pipeline node or slash command, and `DISCOVERY.md` is a working doc, never a `produces:` / `depends_on` artifact. Fires only when there are ≥ 3 open questions or a single high-impact one; a small, clear epic writes the artifact directly.
- feat(sdlc): `TECH-DESIGN.md` (Design phase) now carries a **complete implementation plan** — ordered tasks, per-file checklist, and tests-to-write — not just a bare file-impact list.
- feat(vendor/annotron): the review editor now captures **form-control changes** (checkbox / radio / select / text inputs), so questionnaire ticks are picked up automatically, not just text annotations.

### Spec Kit workflow

- feat(workflow): add **Spec Kit** (spec-driven development, from GitHub Spec Kit) as a built-in workflow: Specify → Clarify → Plan → Tasks → Analyze → Implement. The project "constitution" lives in the workspace SDLC standard rather than a per-epic phase.

## 2.5.0

### Selectable SDLC compliance standard (GH-69)

- feat: a single `standard:` selector in `workspace.yaml` — `none` · `agile-lite` · `hybrid` · `iso-ieee` (or a custom `.aidlc/profiles/<name>.yaml`) — governs, in one value, the enforced artifact sections, the requirements-traceability validator rules, and the per-phase persona/skill. Default is `none` (nothing enforced) so existing projects are unaffected.
- feat(extension): pick the standard from a card-based **webview picker** (sidebar ⚖️ button or the **“AIDLC: Select SDLC Standard”** command), from a dropdown at **Start Epic** (asked once, skippable → `none`), or by hand-editing `workspace.yaml`.
- feat(core): phase-progressive **traceability validator** (`templates/sdlc/validators/traceability.mjs`) enforcing FR → AC → test case → result and RTM integrity — a rule only fires once the artifact it checks exists, so early phases are never blocked. Wires into the existing `auto_review` gate.
- feat(core): `standard` is validated when the workspace loads — an unknown profile is rejected with the list of valid values instead of silently running undefined.

### Two-layer command model (GH-71)

- feat: generate a fixed set of shortcut phase commands (`/plan`, `/design`, `/implement`, `/unit-test`, `/benchmark`, `/test-plan`, `/generate-test-cases`, `/execute-test`) plus a single **`/aidlc <epic> [phase]`** dispatcher. Composition resolves at runtime from the epic’s bound pipeline (two pipelines reusing a phase name no longer collide), and `/aidlc <epic>` with no phase runs the next eligible step. Emitted alongside the existing per-pipeline commands (backward-compatible).

## 2.4.0

### Bundled annotron 0.3.0 → 0.6.0

- chore(vendor): bump vendored [annotron](https://github.com/hueanmy/annotron) from 0.3.0 to 0.6.0. The browser review editor that drives the `/annotate-artifact` feedback loop gains several user-facing capabilities, available automatically the next time you open Feedback:
  - **Annotation persistence** — every annotation is saved to a sidecar JSON beside the artifact and restored on reload/restart, so past context is never lost.
  - **Per-annotation threads** — each annotation card shows its own conversation (your notes + agent replies); reply inline without leaving context. Clicking a card jumps to and highlights the corresponding element.
  - **Annotations / History tabs** — the sidebar splits into an annotations view and a history of past feedback rounds with timestamps and counts.
  - **Image attachments** — paste or upload images into the composer or any annotation note; they're saved to `.annotron-uploads/` beside the artifact so the agent can read them.
  - **Live step log + cancel** — the agent's steps stream into the sidebar like a CLI, and a Cancel button stops an in-flight round.
- note: the project continues to vendor only annotron's `bin/` + `src/` (not its stock `skills/`/`commands/`/`hooks/`) — the annotation loop is driven by AIDLC's own `/annotate-artifact` skill. The 0.6.0 headline features (live CLI activity mirror, turn-status bar, remote permission approval) are hook-driven and ship in annotron's unvendored `hooks/`, so they are **not yet active** here; their server endpoints (`/hook/*`, `/permission/*`) exist in the vendored binary but need agent/skill wiring — a follow-up.
- chore(cli): `aidlc` CLI bumped 0.9.0 → **0.9.1** in lockstep so the terminal install (`aidlc globals install`) ships annotron 0.6.0 too (no functional CLI changes).

## 2.3.0

### Annotron artifact menu: separate Open HTML and Feedback

- feat(extension): the artifact dropdown now splits the old "Open HTML + feedback" entry into two distinct actions — **Open HTML** (shown only once the rendered `.html` exists; opens it read-only in your browser) and **Feedback** (always shown; runs `/annotate-artifact`, rendering the HTML first if it's missing, then opens annotron for the review loop).
- fix(extension): the annotate terminal is now recreated instead of silently reused when its Claude process has already exited. Previously, clicking Feedback again after a finished loop just re-focused a dead terminal and ran no command.
- chore: `aidlc` CLI bumped to 0.9.0 in lockstep (no functional CLI changes this release).

## 2.2.0

### Epic-memory auto-load + git-aware AST rescan

- feat(extension): **Epic-memory auto-load** (opt-in) — a "Memory auto-load: On/Off" toggle at the top of the Epics list. When on, a Claude Code `UserPromptSubmit` hook injects an epic's `epic-memory.json` (summary, decisions/constraints, reflections) into context whenever a prompt refers to that epic — so working on an epic loads its prior context automatically, without running `/epic-context`. Nothing is enabled unless you flip it; toggling only adds/removes the hook entry in `~/.claude/settings.json`.
- feat(cli): `aidlc globals memory-hook enable | disable | status` — the terminal equivalent of the toggle (enable also installs the tooling first).
- feat(extension): **git-aware AST rescan** — the AST graph now does a full clean rescan after git operations that change the working tree (branch switch/checkout, merge, rebase, reset, pull), via a watcher on `.git/{HEAD,ORIG_HEAD,MERGE_HEAD}`. Individual saves still trigger the fast incremental rescan.
- chore: the epic-memory hook script ships in the tooling payload and installs under `~/.claude/tools` with the rest (extension activation and `aidlc globals install`).

## 2.1.0

### Artifact annotation loop (annotron) + epic memory

- feat(extension): **Annotate artifacts in a browser** — clicking a step's `.md` artifact opens a popover with **Open Markdown** and **Open HTML + feedback**. The feedback option renders the Markdown to a self-contained, Claude-styled HTML (zero-dep Node renderer, `marked` vendored — no Python/pip) and opens it in **annotron** (vendored, no global install) for point-and-click review. Feedback is applied **back to the `.md`** (canonical source), never the HTML, then re-rendered live via the `/annotate-artifact` skill.
- feat(extension): **Revision history** — every applied round is snapshotted to `.revisions/<artifact>/rev-N.{md,html}`, attributed to the editing dev (git identity, hostname fallback), and shown both in the rendered HTML's "Revision history" section (with a per-revision selector to reopen old versions) and in the pipeline **History** panel. Reopening an unchanged artifact skips re-rendering.
- feat(extension): **Epic memory** — a compact per-epic digest (`docs/epics/<epic>/epic-memory.json`: summary, decisions/constraints, and reflections on how to prompt better next time) so continuing an epic with any agent is cheap on tokens. Viewable via the **Memory** button in the epic footer and maintained with the `/epic-context` skill; annotation rounds auto-append context entries.
- feat(cli): `aidlc globals install` now also installs the annotation tooling (renderer + annotron + epic-memory + the `/annotate-artifact` and `/epic-context` skills) under `~/.claude` — the loop works from a plain terminal + Claude Code, no VS Code required.
- chore: the annotation tooling auto-installs into `~/.claude` on extension activation and is shared with the CLI via `@aidlc/core`; it never modifies your `settings.json`.

## 2.0.1

- fix(extension): correctly handle claude mcp list timeout (#61)
- chore(cli): add .npmrc to use NPM_TOKEN for public registry publish
- chore: update pnpm-lock.yaml with vitest (fix frozen-lockfile CI)

## 2.0.0

### Test Agent + Analyze Requirements

- feat(extension): **Tests tab** in the Workspace Builder — integrates [`aidlc-testagent`](https://github.com/aidlc-io/aidlc-testagent) (`ata`) for AI-powered E2E tests. Shows the full **Explore → Plan → Confirm → Generate → Execute → Heal → Verdict** pipeline, lists targets from `testagent.config.yaml` with per-target **Plan** / **Run** buttons, a settings (⚙) button that opens the `.target.yaml` directly in the editor, and a global **Validate all** action. Setup prompt with "Run ata config" when no config exists.
- feat(extension): **Analyze Requirements tab** — import requirements from Jira, GitHub Issues, Linear, Redmine, or a local file/URL and convert them into a `requirements.md` via the `/analyze-requirements` slash command. Interactive wizard with platform picker, parent epic/issue ref, brief mode, and custom instructions.
- feat(cli): `aidlc analyze` — terminal equivalent of the Analyze Requirements wizard. Supports `--source`, `--text`, `--platform`, `--parent`, `--brief`, `--instruction`, `--id`, `-y`. Works without a `workspace.yaml`.

## 1.4.0

### Ask AIDLC + Bedrock/Vertex auth

- feat(extension): **Ask AIDLC** — a new button at the top of the AIDLC sidebar (and `AIDLC: Ask AIDLC` command) that opens a **chat panel** for asking what AIDLC does and how to set it up. Common questions (the suggestion chips + close paraphrases) answer **instantly** from curated templates; anything else streams from the local `claude` with a "Thinking…" indicator and conversation context for follow-ups — all grounded in a shared knowledge reference so answers stay accurate.
- feat(cli): `aidlc ask "<question>"` — ask Claude about AIDLC (setup, concepts, commands), and `aidlc guide` — a static, no-LLM getting-started reference card. Both work before a workspace is initialized.
- fix(cli): `aidlc doctor` now recognizes every auth mode Claude Code supports — **AWS Bedrock** (`CLAUDE_CODE_USE_BEDROCK`), **Google Vertex** (`CLAUDE_CODE_USE_VERTEX`), gateway `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, and a normal `claude login` (detected offline via `~/.claude.json`, no model call). Fixes false "Not authenticated" reports for Bedrock/Vertex users ([#55](https://github.com/aidlc-io/aidlc/issues/55)).
- fix(core/cli/extension): AIDLC now strips an inherited `ANTHROPIC_API_KEY` before spawning `claude` whenever the user has a `claude login` (or is inside a Claude Code session, where the key is ephemeral) — a stale/scoped shell key was shadowing a good OAuth login and failing with "Invalid API key". Pipeline runs, `aidlc ask`, and the extension's Ask now use the login, matching aidlc-testagent. A deliberately-set key with no login is left untouched, and a workspace.yaml `environment` key always wins.

## 1.3.2

- feat(extension): ❤️ **Sponsor** button on the Marketplace listing (`sponsor.url` → [github.com/sponsors/hueanmy](https://github.com/sponsors/hueanmy)); the CLI package gains a matching npm `funding` field.
- docs: new demo GIF/MP4 recorded against 1.3.1 (Monitor + Insights era); badges header (Marketplace / Open VSX / license / Sponsor) on the extension, CLI, and repo READMEs; feature lists refreshed to current state (Session Insights, OTel strip, monitor auto-install, `epic start --brief`, recipe commands).
- chore(extension): the Monitor command title now reads "Open AIDLC Monitor (Token Usage + Insights + Agents)".

## 1.3.1

### Native session-insights dashboard

- feat(extension): new **Insights** tab in AIDLC Monitor, built entirely from the Claude Code transcript (`~/.claude/projects/**.jsonl`) — no plugin, no server, no Docker. A session picker plus seven panels: overview, a context+cache area chart over turns, hooks (with errors), agents/subagents, prompts, context management (compactions/peak/file edits), retrieval (reads/search/MCP) and tool usage. Live via `fs.watch` on the active session + its `subagents/` dir.
- feat(extension): live **OTel** strip — a minimal OTLP/JSON receiver for Claude Code's native telemetry, with a one-click "enable telemetry" that writes the env to `~/.claude/settings.json`.
- feat(cli): `aidlc monitor --start` now offers to **auto-install** the agents-observe plugin (with confirmation) instead of only printing manual steps; `monitor` distinguishes a plugin that is **installed-but-failed-to-load** from a healthy one; the local-runtime launch pins `npm install` to the public npm registry so it never inherits a private CodeArtifact default.

## 1.3.0

### AIDLC Monitor — token usage + agent observability

- feat(extension): **AIDLC Monitor** panel (`AIDLC: Open AIDLC Monitor`) with **Token Usage** and **Agents** tabs. The Agents tab embeds the [agents-observe](https://github.com/simple10/agents-observe) dashboard so you can watch live agent sessions and history without leaving VS Code.
- feat(extension): status bar item that polls the agents-observe server and opens the Monitor. New settings `aidlc.monitor.enabled` (default on) and `aidlc.monitor.pollIntervalSeconds` (default 10); polling pauses while the window is unfocused. No-op surface when the server isn't running.
- feat(extension): when the server is down, the Agents tab shows a **Start Monitor** action (instead of an error) that launches it in a terminal.
- feat(cli): `aidlc monitor` — checks the agents-observe plugin install, pins a stable data dir in `~/.claude/settings.json` (data survives plugin upgrades), and prints live server status. `--json`, `--dry-run`, `--open` flags.
- feat(cli): `aidlc monitor --start` — actually launches the observe server when it's down. Uses Docker when available, otherwise falls back to the plugin's **local** runtime (no Docker required); the **Start Monitor** button now wires through this.

## 1.2.0

### Run verify & report (issue #23 E2, E6)

- feat: `aidlc run verify <runId>` — read-only post-run **drift check**. Re-checks every step's recorded artifacts still exist and pass the same `produces_contains` markers the gate applied; exits non-zero on drift (handy as a CI post-check).
- feat: `aidlc run report <runId> [--format md|json] [--output <file>]` — renders run history (steps, revisions, durations, reject reasons, approve comments, cost) as shareable Markdown.
- feat(extension): **Verify** / **Report** buttons in the run panel header, wired via `aidlc.verifyRun` / `aidlc.runReport`.

### Run-exec guards (issue #23 C1, C2, C4)

- feat: cost-guard `budget` for the `aidlc run exec` autopilot — accumulates per-step cost and pauses/fails when a ceiling is crossed.
- fix(core): bound the auto-reviewer runtime with a timeout (`auto_review_timeout_ms`) so a hung validator can't stall a run.
- fix(core): `markStepDone` is now idempotent — a duplicate mark-done for an already-advanced step is a safe no-op.

### Stronger gate (issue #23 E1)

- feat(core): `produces_contains` content assertions on the produces gate — assert minimum content (section markers) in produced files without writing a JS validator.
- feat(extension): edit `produces_contains` + `auto_review_timeout_ms` in the Step config modal; the pipeline builder carries both fields.

### SDLC artifact templates

- feat: per-tech-stack implement templates (`implement.backend.md`, `implement.web.md`, `implement.web-react.md`) with tech-stack detection; refreshed plan / design / implement / unit-test templates & skills.

## 1.1.1

- fix(epic): a recipe-assembled epic now shows a **runnable** slash command. Its per-epic pipeline (e.g. `SWIFT-142`) has no command files of its own, so step commands now resolve to the recipe's source pipeline (`/sdlc-parallel-full-implement …`) — which reads the epic id from its argument. Previously the UI surfaced `/<epic>-<step>`, which Claude reported as an unknown command.

## 1.1.0

### Task-type recipes & smart Start Epic

- feat(recipes): built-in recipes — `bugfix`, `small-feature`, `refactor`, `feature-parallel`, `large-feature`, `spike`. Start Epic suggests the right one from a one-line brief and assembles a pipeline from it.
- feat(recipes): back-fill recipes into older workspaces automatically (extension, on load) or via `aidlc recipe init` (CLI), so projects scaffolded before recipes existed gain suggestion support.
- feat(cli): `aidlc epic start <id> --brief "…"` classifies the task and assembles a pipeline; `--llm` for model-backed classification. New `recipe`, `classify`, and `generate` commands.

### Pipelines

- feat(pipeline): rename **and** duplicate pipelines.
- feat(pipeline): namespaced slash commands & command files per pipeline — multiple pipelines no longer collide.
- feat(pipeline): "Load AIDLC default" button in the Add-pipeline modal.
- feat(pipeline): pick the step **name** first, then the agent; a "Runs after" dependency editor; duplicate agent ids are allowed.
- fix(pipeline): deleting a pipeline also removes the agents & skills it owned (counts now drop too).
- fix(pipeline): built-in agents sync with their real skills (no more bogus `<id>-skill`).

### Start Epic

- feat(epic): no-pipeline actions — "Load SDLC example" / "Create new pipeline".
- feat(start-epic): fetch GitHub issues host-side via the `gh` CLI (~1s, no Claude loop); live seconds counter; clearer message when a project's connector isn't enabled; don't dismiss on backdrop click.
- pipeline runs now display by **step name**, not agent name.

### Sidebar & Builder

- feat(sidebar): clickable Agents / Skills / Flows / Epics tiles open the matching view; Epics opens the top-level Epics view.
- chore(sidebar): remove the "Pipeline runs" and "Slash commands" sections.

### Built-in SDLC preset

- feat: streamlined to **po · tech-lead · developer · qa** with `implement` + `unit-test` skills (developer gets both); QA keeps `test-plan` / `generate-test-cases` / `execute-test` (+ `test-report`).
- refactor(core): single source of truth for the SDLC preset, templates, and global install moved into `@aidlc/core` — the extension and the `aidlc` CLI now share it.
- feat(core): opt-in global install of `~/.claude/agents/aidlc-*.md` + matching skills.

### Misc

- chore(ast-graph): bundle the ast-graph CLI v0.3.0.
- chore: update GitHub reference links to `novapizza/claude-token-monitor`.

## 1.0.1

- feat(skill-templates): expand library to 45 templates across 9 categories

## 1.0.0

- feat(workflow): non-destructive preset apply, DAG-aware modal, scoped skill picker
- feat(workflow): step skills, tech-stack templating, artifact wiring
- feat(workflow-presets): multi-domain templates + opt-in global install
- feat(workflow): SDLC built-in pipeline + artifact templates per workflow

## 0.9.0

- feat(ast-graph): auto-scan workspace + wire as Claude MCP server
- fix(report): label $ as API-equivalent, lead overview with tokens
- feat(report): full Token Usage Report panel from status bar click
- feat(sidebar): cost suggestions list + detail are stacked modals
- feat(sidebar): cost suggestions list moves into a popup
- fix(sidebar): cap cost-suggestions list height + tighter rows
- fix(sidebar): cost suggestions open in a modal — inline expand was too cramped
- feat(sidebar): cost-suggestion engine ported from claude-token-monitor
- fix(demo): scale synthetic usage ~10× smaller so demo doesn't scare users
- feat(demo): synthetic token usage so demo epics showcase the ⚡ badge
- feat(epics): per-history-entry token usage in step history
- feat(token-monitor): tokens primary, $ as API-equivalent secondary
- fix(epics): drop run-level fallback for token attribution
- feat(epics): per-epic + per-step token usage badge
- chore(cli): prep aidlc for npm publish
- feat(extension): token monitor status bar — today/month Claude spend
- feat(epics): "Load from file…" for description / feedback
- feat(sidebar): "MCP servers" section — show what Claude is connected to
- fix(epics): migration toast surfaces *why* epics were skipped
- feat(epics): migration backfills runState for legacy epics that only have state.json
- feat(epics): "Migrate Epic State Files" command — bring legacy state.json up to current schema
- feat(sidebar): inline "Load Demo Project" picker — replace VS Code notification
- fix(epics): "Run with Claude" first-time runs skip the modal
- fix(epics): button label is "Run with Claude" until the step has actually started
- feat(runs): "Request update" — reopen approved steps when requirements change
- feat(epics): live artifact refresh + Update-with-feedback modal w/ optional input
- feat(epics): "Run in Claude" button on awaiting_work steps — no more manual copy
- fix(demo): mirror agents into .claude/commands so slash commands work in Claude Code
- fix(epics): "Update with feedback" sends prompt INTO the Claude REPL, not the shell
- feat(epics): "Update with feedback" button — pre-types slash command into Claude
- feat(demo): two example epics with rich step history
- feat(epics): mirror run state into docs/epics/<id>/state.json on every transition
- feat(runs): per-step append-only history (reject reasons, reruns, verdicts)
- fix(epics): step badge and epic status now reflect run-state advances
- feat(webview): inline Rerun + SavePreset + Apply-overwrite confirm
- feat(webview): inline StartEpicModal — pipeline/agent + capability inputs in one form
- feat(webview): inline AddAgent + AddSkill modals (Tier 3)
- feat(webview): edit existing pipelines via inline modal
- feat(webview): inline AddPipelineModal — pick + configure all steps in one form
- feat(webview): inline modals for start-run and edit-step-config (Tier 2)
- feat(webview): inline modals for rename, delete confirm, add step (Tier 1)
- fix(core): AutoReviewer dynamic import — use native import() under module:node16
- feat(runs): inline Reject modal — no more VS Code input box pop-up
- feat: migrate webview to React + Vite; mono+teal theme; restore drag-and-drop step reorder

## 0.8.6

- feat: collapsible run cards in pipeline runs sidebar
- feat: kebab menu with rename/duplicate/delete for agent and skill cards; drag-and-drop workflow reorder; custom tooltip for truncated names
- Fix: Readme & Dashboard view
- M4 + M5: Fix and add command list epic
- M5: Doctor, tail, dashboard

## 0.8.5

- feat: add Get Started walkthrough (6 steps with command buttons)
- feat: ✕ button on sidebar project bar to close the open folder
- README: refresh demo gif (full pipeline run @ 2x speed) and refresh content (epics/runs, Load Demo Project, walkthrough)
- fix: AutoReviewer dynamic import (route through `new Function` so CJS transpile keeps `import()`)
- feat: Load Demo Project command, reject-to-upstream cascade, debug fixes
- feat: surface slash commands in sidebar runs and Epics panel step detail

## 0.8.4

- fix: ship bundled extension.js so commands register on activation. v0.8.3 packaged the unbundled tsc output, which threw on `require("@aidlc/core")` at startup and left every `aidlc.*` command unregistered ("command 'aidlc.openBuilder' not found"). v0.8.4 ships the esbuild bundle as intended.

## 0.8.3

- Discover and display Claude Code native skills + agents from `.claude/` (project) and `~/.claude/` (global), unified with AIDLC-scoped items declared in `workspace.yaml`. Builder + sidebar group items by scope, count items across all three scopes, and flag overridden ids. Add Skill / Add Agent wizards now prompt for a scope. Watchers on `.claude/{skills,agents}/**` and `.aidlc/{skills,agents}/**` keep the catalog in sync without a manual refresh.

## 0.8.2

- Drop the legacy SDLC-pipeline branding from README and CHANGELOG.
- Fix a dangling command call in the workspace builder webview ("Open Claude Terminal" was no-op after the v2 namespace migration).

## 0.8.1

- Marketplace metadata + demo asset fixes.

## 0.8.0

Initial release of the agent-workflow runner.

- `@aidlc/core` engine — Zod-validated `workspace.yaml` schema, `WorkspaceLoader`, `EnvResolver`, `SkillLoader`, `RunnerRegistry`, `DefaultRunner` (claude CLI shell-out), `CustomRunnerLoader`. 24 unit tests.
- Activity bar entry **AIDLC** with a single sidebar webview (**Workspace**) that surfaces agents · skills · pipelines stats and slash commands defined in `workspace.yaml`.
- `aidlc.openBuilder` — main-area visual builder with agent / skill / pipeline cards, ↑↓ step reorder, on-failure toggle, delete actions.
- `aidlc.initWorkspace` — scaffold `.aidlc/workspace.yaml` + sample skill, opens the folder if not already a workspace.
- `aidlc.addSkill` — wizard with 4 sources: load template (5 starters: hello-world, code-reviewer, test-converter, doc-writer, release-notes), paste markdown, upload `.md` file, or open blank file.
- `aidlc.addAgent` — wizard: id + display name + skill picker + Claude model picker (sonnet-4-6 / opus-4-7 / haiku-4-5).
- `aidlc.addPipeline` — wizard: id + multi-pick agents (in execution order) + on_failure (stop / continue).
- `aidlc.savePreset` / `aidlc.applyPreset` / `aidlc.deletePreset` — save and reload entire workspace configurations as named templates.
- `aidlc.startEpic` / `aidlc.openEpicsList` / `aidlc.insertDemoEpic` — manage epics inside the workspace.
- `aidlc.openClaudeTerminal` — open a zsh terminal in the bottom panel with the `claude` CLI auto-launched; reuses an existing terminal if open.
- `aidlc.showWorkspaceConfig` — dump parsed workspace.yaml to the AIDLC output channel (validated, env-resolved).
