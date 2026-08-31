# AIDLC v3.5 🚀

**AI-driven SDLC pipeline runner. Plan → Prototype → Design ∥ Test → Implement → Release, plus the six-stage AI-Native SDLC Playbook. See what Claude is building, control every step, track every token.**

[![License: MIT](https://img.shields.io/badge/license-MIT-97ca00)](LICENSE)
[![Build: local](https://img.shields.io/badge/build-local%20%2Evsix-6b7280)](#install-this-build)

> **This is a fork.** Upstream is [`aidlc-io/aidlc`](https://github.com/aidlc-io/aidlc)
> by [hueanmy](https://github.com/hueanmy), published on the Marketplace as
> `hueanmy.aidlc`. **This build is not published anywhere** — it is installed from
> a locally built `.vsix` and a locally linked CLI ([Install this build](#install-this-build)).
> What it adds on top of upstream is the **AI-Native SDLC Playbook** workflow; see
> [`AI_NATIVE_SDLC_ALIGNMENT.md`](AI_NATIVE_SDLC_ALIGNMENT.md) for the full record of
> what was built and why.

AI-driven SDLC + agent workflow runner — drives Claude through any pipeline you
declare in `.aidlc/workspace.yaml`. Use it through the VS Code Builder UI or
straight from the terminal. Pick a **selectable SDLC compliance standard**
(`none` · `agile-lite` · `hybrid` · `iso-ieee`) that governs enforced artifact
sections, a requirements-**traceability** validator, and per-phase persona/skill
in one selector. The built-in **AIDLC Monitor** shows token usage, live agent
observability, and a native session-insights dashboard built from the Claude
Code transcript.

![aidlc demo](packages/extension/media/demo.gif)

## ✨ What's New in v3.5 — the AI-Native SDLC Playbook (this fork)

- **🧭 A third built-in workflow, `ai-native-pipeline`** — the playbook's six stages as one pipeline: **Intent → Spec → Plan → Build → Test → Deploy → Maintain** (`intent.md` · `spec.md` · `plan.md` · diffs & PRs · `verify.md` · `review.md` · `incident.md`). Apply it with `aidlc preset apply ai-native`. The existing `aidlc-workflow` and `speckit-pipeline` are untouched.
- **🛡️ The stage-5 gate lives in the tooling** — a `PreToolUse` hook (`.claude/hooks/aidlc-approval-gate.py`) blocks force-pushes to protected branches, staging credential-shaped files, and hand-edits of pipeline-owned run state. A checklist you can skip is not a gate.
- **🔁 Stage 6 closes the loop back to stage 1** — a production signal opens an incident epic, and the diagnosis opens the follow-up epic with its `intent.md` already written:

  ```sh
  aidlc maintain --signal signal.json        # register the signal → INC-… epic
  aidlc maintain follow-up INC-… --problem … # open the work it turned out to need
  ```

  `maintain` is the only phase with no human gate — a signal does not wait for
  office hours. The gate moved to stage 1 of the epic it opens.
- **⌨️ CLI first, by rule** — every new phase is runnable from a terminal, a cron job or a webhook forwarder before it gets a button. `@aidlc/core` is the API; the extension and the CLI are both callers.

---

## ✨ What's New in v3.4

- **📊 Mermaid renders for every diagram type** — Sequence, state, and mindmap diagrams (and any newer mermaid type) now render as real diagrams in the review/preview, not a dark ASCII box. Common types stay zero-runtime SVG; the rest fall back to a lazily-loaded mermaid runtime.
- **🖼️ Feedback & Preview render the Markdown natively** — the Feedback button and the new **Preview** action open the artifact in annotron itself (diagrams included); revision history is still logged per round.
- **✍️ Inline text edit** — in Annotate mode, selecting plain text offers **Edit** beside Comment to retype/delete it straight into the `.md` (only when it maps to an exact spot in the source).
- **🩹 Sturdier annotron server** — starts reliably from VS Code terminals and stays up after Done.
- **🧭 Autopilot core (experimental)** — unattended run engine + LLM pipeline adapter land in `@aidlc/core`, dormant behind `aidlc.autopilot.enabled`.

---

## ✨ What's New in v3.3

- **🛠️ Custom pipelines now runnable end-to-end** — Building a pipeline in the Builder now wires each named step as a real Claude Code slash command (`.claude/commands/<pipeline>-<step>.md` + a `slash_commands` entry). "Run step" no longer fails with *command not found* on custom pipelines. (Re-save an older custom pipeline once to backfill its commands.)
- **🧭 aidlc-autopilot** — *Experimental, coming soon.* Opt-in scaffolding that collects epic context and drafts a recommended plan (`autopilot-plan.md`) at epic start. Off by default; enable with the `aidlc.autopilot.enabled` setting once you're ready to try it.
- **🔤 Workflow rename** — The default pipeline is now `aidlc-workflow` / `aidlc-workflow-full` (formerly `sdlc-parallel-pipeline` / `sdlc-parallel-full`), aligning naming with the AIDLC brand.

---

## ✨ What's New in v3.2

- **🧠 Agent Skills Management** — Project-level agent configuration without workspace.yaml dependency. Agent files (`.claude/agents/*.md`) now define skills directly in frontmatter: `skills: [skill1, skill2]`. Auto-reload notifications keep UI in sync.
- **🔄 One-Click Reload** — When creating agents/skills, see "Reload VS Code" popup with actionable [Reload] button. No more manual window reloading.
- **✅ Better UI Feedback** — Edit modal now shows checkmarks for selected skills. Changes to skills are reflected in agent file immediately.

---

## ✨ What's New in v3.1

- **📝 Annotron 1.0 — Markdown Editing in Review** — Annotation editor now renders Markdown with inline diagrams (Mermaid: flowchart, sequence, UML, C4, architecture, Gantt). Edit `.md` source directly, press Save to re-render. Auto-apply feedback loop: send annotations → watch Claude apply changes live.
- **🗂️ Outline Navigation** — Long Markdown docs now show an auto-generated sidebar with h1–h4 headings. One-click jump to sections, persist state across sessions.
- **📸 Image Attachments** — Paste/upload images into annotations. Agent reads them by path.
- **⚡ Live Activity Mirror** — Watch Claude's tool calls (Read/Edit/Bash) stream into the annotation editor in real-time. Know exactly what the agent is doing.
- **🔄 Improved Skill Discovery** — Skills created mid-session now immediately visible in agent picker. Fixed deduplication when skills exist in both workspace.yaml and discovered locations.
- **🎙️ Better File Watching** — Manual refresh button (🔄) in sidebar + CLI command for instant discovery without VSCode restart.

---

## ✨ What's New in v3.0

- **🎨 Prototype Phase** — Designers propose multiple UI options (HTML, Figma, lo-fi) before tech design. Users pick a preferred approach, which feeds into Design.
- **🚪 Discovery Gate** — Human-in-the-loop questionnaire for open decisions. When a phase has unresolved questions, it opens a point-and-click form, confirms choices, and resumes.
- **📋 Spec Kit Workflow** — Spec-driven development pipeline (GitHub Spec Kit): Specify → Clarify → Plan → Tasks → Analyze → Implement.
- **🎯 Recipe System** — Pre-built recipes (bugfix, ui-feature, feature-parallel, large-feature, spike) with auto-classifier for task type.
- **🔧 Configurable Git Behavior** — Per-step branch naming, push, auto-PR settings. Survives re-apply.

This is a **monorepo** managed with [pnpm workspaces](https://pnpm.io/workspaces).

## Review artifacts, keep the memory

Open any epic artifact in a **browser annotation editor** ([annotron](https://www.npmjs.com/package/annotron), vendored — no separate install), point-and-click your feedback, and let Claude apply it **back to the Markdown** (the canonical source) and re-render — with a full **revision history**: who changed what, and a per-revision selector to reopen any past version. Each epic also keeps a compact **memory** (`epic-memory.json`: decisions, constraints, reflections) so picking it back up later — with any agent — costs far fewer tokens. Markdown → HTML uses a zero-dependency Node renderer (no Python). Works in the VS Code extension, and from the terminal via `aidlc globals install` (installs the `/annotate-artifact` and `/epic-context` skills + tools under `~/.claude`).

The mirror image runs at the **start** of a phase: a **discovery gate**. When the **Plan** phase (or **Design**) has open questions before it can write a good artifact — scope, target users, which approach, where a boundary sits — it doesn't ask them one-at-a-time in chat or silently guess. The `discovery-gate` skill turns them into a point-and-click **questionnaire** (each question with options, an "Other / notes" blank, and a pre-ticked "Decide for me" default), opens it in annotron the same way, and resumes the phase from your confirmed choices — which land in the PRD's `## Discovery decisions` section. It's a **gate, not a phase** (the questionnaire is a throwaway working doc, never a pipeline artifact), and it only fires when there are ≥ 3 open questions or a single high-impact one — a small, clear epic writes the PRD directly.

## Packages

| Package | Path | Purpose |
|---|---|---|
| [`aidlc`](packages/extension/) (extension) | `packages/extension/` | VS Code extension. Builder UI for `workspace.yaml`, sidebar for active runs, run-state commands, and the **AIDLC Monitor** (token usage + session insights + live agent observability). Installed locally as `delete101020.aidlc` (see [Install this build](#install-this-build)). |
| [`@aidlc/core`](packages/core/) | `packages/core/` | Pure-TypeScript engine: Zod schema, workspace loader, runner registry (`DefaultRunner` shells out to `claude`), pipeline state machine. **No `import 'vscode'`** — runs identically in CLI / tests / cloud. |
| [`aidlc`](packages/cli/) (CLI) | `packages/cli/` | Standalone terminal CLI. Manages `workspace.yaml`, drives runs end-to-end via Claude, no VS Code required. See [packages/cli/README.md](packages/cli/README.md). |

## Quick start

### 1. Install the CLI

This build is not on npm. Install it from the repo:

```sh
pnpm install
pnpm -r compile
cd packages/cli && pnpm bundle && npm link   # puts `aidlc` on your PATH
```

### 2. Bootstrap a workspace

```sh
aidlc init                              # scaffolds .aidlc/workspace.yaml
aidlc preset apply code-review          # or: sdlc, release-notes
aidlc validate                          # check schema
aidlc doctor                            # verify claude binary + auth
```

### 3. Start a run, let Claude do the work

```sh
aidlc run start review-pipeline --context epic=ABC-123
aidlc run exec <runId>                  # spawns claude, streams output, advances on success
# or fully unattended:
aidlc run exec <runId> --auto-approve
```

### 4. Watch what's happening

```sh
aidlc watch                             # live-rendered table of all runs
aidlc tail                              # one-line stream of state transitions
aidlc dashboard                         # browser UI on http://127.0.0.1:8787
aidlc monitor --start                   # agent observability (agents-observe), auto-installs the plugin
```

### 5. Watch from VS Code

Install the extension. Edits made by either side update within ~200ms because
both consume the same `.aidlc/workspace.yaml` and `.aidlc/runs/*.json`.

## Repo dev

```sh
pnpm install                            # installs all packages + creates symlinks
pnpm build                              # tsc -r in every package
pnpm test                               # @aidlc/core unit tests
pnpm package:extension                  # build .vsix for the extension
```

## CLI reference (summary)

The full reference lives in [packages/cli/README.md](packages/cli/README.md).

### Workspace bootstrap
```
aidlc init                    # scaffold .aidlc/workspace.yaml + skills/ + runs/
aidlc validate                # parse + Zod-validate workspace.yaml
aidlc doctor                  # workspace + claude binary + auth + env health checks
aidlc list [--json]           # print agents, skills, pipelines
aidlc guide                   # static getting-started reference (no LLM)
aidlc ask "<question>"        # ask Claude about aidlc — setup, concepts, commands
```

### Dynamic config (mirrors the VS Code Builder)
```
aidlc skill    add | list | show | remove           # 5 built-in templates
aidlc agent    add | list | show | remove
aidlc pipeline add | list | show | remove
aidlc preset   apply | save | list                  # built-ins: code-review, release-notes, sdlc
```

### Epic inspection (mirrors the extension's epics panel)
```
aidlc epic list [--status pending|in_progress|done|failed] [--json]
aidlc epic status <id>        # phase-by-phase view of one epic
aidlc epic start <id> --brief "…" [--llm]   # classify the task → recipe → assembled pipeline
```

### Recipes (task-type pipeline assembly)
```
aidlc recipe init                     # back-fill built-in recipes into older workspaces
aidlc pipeline recipes                # list recipes (bugfix, small-feature, refactor, …)
aidlc pipeline classify "<brief>"     # which recipe fits this task
aidlc pipeline generate               # assemble a pipeline from a recipe into workspace.yaml
```

### Monitoring & observability
```
aidlc monitor                 # agents-observe plugin status + pin stable data dir
aidlc monitor --start         # launch the observe server (offers plugin auto-install; Docker or local runtime)
aidlc monitor --open          # open the dashboard in the browser
```

### Workflow globals (built-in agents + skills under ~/.claude/)
```
aidlc globals status [--json]      # which built-in workflows are installed globally
aidlc globals install [ids...]     # install (default: the standard workflows)
aidlc globals uninstall [ids...]   # remove AIDLC-marked global files (run before removing the extension)
```

### Run lifecycle (sequential, mirrors the upstream PipelineRunner)
```
aidlc run start <pipeline> [--id …] [--context epic=ABC-123]
aidlc run mark-done <runId>      # validate produces, advance or await review
aidlc run approve  <runId> [--comment …]
aidlc run reject   <runId> --reason …
aidlc run rerun    <runId> [--feedback …]
aidlc run request-update <runId> <step> [--feedback …]   # reopen an approved step for changes
aidlc run delete   <runId> [--force]
aidlc run open     <runId> [--path]
aidlc run exec     <runId> [--until …] [--auto-approve] [--require-complete] [--json] [--dry-run]
aidlc run verify   <runId> [--json]              # re-check recorded artifacts still exist (drift check)
aidlc run report   <runId> [--format md|json] [--output <file>]
```

`run exec` runs `auto_review` validators headlessly and exit-codes for CI:
`0` completed, `2` paused on a gate, `1` error (`--require-complete` ⇒ any
non-completed is `1`). See [packages/cli/AUTOMATION.md](packages/cli/AUTOMATION.md) for the
full headless guide + a GitHub Action recipe.

### Step control (jump to any step, any order — bypasses sequential gate)
```
aidlc step start  <runId> <step>          # → awaiting_work, moves pointer
aidlc step done   <runId> <step> [--reason …]
aidlc step skip   <runId> <step>
aidlc step reset  <runId> <step>          # → pending
aidlc step set    <runId> <step> <status> # raw any StepStatus
aidlc step jump   <runId> <step>          # auto-approve earlier pending steps
```

### Live observation
```
aidlc watch [runId]           # cli-table3 view, redraws on any state change
aidlc tail  [runId] [--json]  # streams transitions as one-line events (or NDJSON)
aidlc dashboard [--port …] [--host …]   # browser UI with action buttons
```

### Agent execution (one-shot, no run state)
```
aidlc agent run <agentId> [--message …] [--context epic=ABC-123] [--dry-run]
```

`<step>` accepts a 0-based index or an agent id. Pass `-w <path>` (or
`AIDLC_WORKSPACE=<path>`) to point at a workspace other than `cwd`.

## Architecture

```
                          ┌────────────────────┐
                          │  workspace.yaml    │  ← single source of truth
                          │  (Zod validated)   │
                          └──────────┬─────────┘
                                     │
                  ┌──────────────────┼──────────────────┐
                  │                  │                  │
            ┌─────▼─────┐      ┌─────▼─────┐      ┌─────▼─────┐
            │  CLI      │      │ Extension │      │  Future   │
            │  (Node)   │      │  (VS Code)│      │  cloud    │
            └─────┬─────┘      └─────┬─────┘      └───────────┘
                  │                  │
                  └────────┬─────────┘
                           │
                    ┌──────▼──────┐
                    │ @aidlc/core │  ← shared engine
                    │   (no UI)   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ DefaultRunner│ → spawns `claude --print --append-system-prompt …`
                    └─────────────┘
                           │
                    ┌──────▼──────┐
                    │.aidlc/runs/ │  ← state, watched by both UIs (live sync)
                    │  *.json     │
                    └─────────────┘
```

Both surfaces read and write the same files; the OS handles atomic renames so
neither side ever sees a half-written run state.

## Run-state backends (local file · git-native)

Run state persists to local `.aidlc/runs/*.json` by default — single machine,
no setup. To share runs across a team **without running a server**, switch to
the git backend in `workspace.yaml`:

```yaml
persistence:
  backend: git          # default: file
  branch: aidlc-state   # branch that holds run state (default)
  remote: origin        # remote to sync with (default)
  auto_sync: true       # pull before reads, rebase + push on writes
```

Run state then lives on a dedicated `aidlc-state` branch, checked out into a
hidden worktree (`.aidlc/.state`, auto-added to `.gitignore`) that never
touches your code branch. Every `run` change is committed and pushed, so
teammates on other machines converge through the git remote you already use.
`git log aidlc-state` is a free, append-only audit trail. With no remote
configured it degrades to local commit-only — still durable, just
single-machine. The default file backend is unchanged; git is fully opt-in.

## Install this build

> **New to this fork, or setting it up for someone else?** Read
> [`ONBOARDING.md`](ONBOARDING.md) instead — it covers prerequisites, both
> installs, registering the approval-gate hook (which a clone does **not**
> get automatically), and how the seven-phase workflow is actually run from
> the extension and the CLI.

Nothing here is published — no Marketplace listing, no Open VSX entry, no npm
package. Both artifacts are built from this repo and installed locally.

**The extension:**

```sh
pnpm install
pnpm package:extension                                  # → packages/extension/aidlc-3.5.1.vsix
code --install-extension packages/extension/aidlc-3.5.1.vsix
```

Reload the window afterwards. The extension installs as `delete101020.aidlc`;
if you also have the upstream `hueanmy.aidlc` installed, disable one of them —
they contribute the same `aidlc.*` command ids.

**The CLI:**

```sh
pnpm -r compile
cd packages/cli && pnpm bundle && npm link               # `aidlc` on your PATH
aidlc --version                                          # 3.5.1
```

To pick up later changes, re-run the same two commands — `npm link` points at
the working tree, so a rebuild is enough for the CLI; the extension needs a new
`.vsix` and a reinstall.

## Credit

Built on [`aidlc-io/aidlc`](https://github.com/aidlc-io/aidlc) by
[hueanmy](https://github.com/hueanmy) — the extension, the CLI, the monitor and
the annotation loop are all upstream work. If it saves you time,
[sponsor the original author](https://github.com/sponsors/hueanmy) ❤️.

## License

MIT — see [LICENSE](LICENSE). The original copyright line is kept; this fork's
changes are added under the same terms.
