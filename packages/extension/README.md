# AIDLC Native

**Drive Claude through the six stages of the AI-Native SDLC Playbook — Plan → Design → Build → Test → Deploy → Maintain — from VS Code or the terminal, and see every step, artifact and token on the way.**

[![License: MIT](https://img.shields.io/badge/license-MIT-97ca00)](https://github.com/delete101020/ai-native-sdlc/blob/main/LICENSE)
[![npm CLI](https://img.shields.io/npm/v/@delete101020/aidlc?label=CLI)](https://www.npmjs.com/package/@delete101020/aidlc)

> **A fork.** AIDLC Native is built from
> [`delete101020/ai-native-sdlc`](https://github.com/delete101020/ai-native-sdlc), a fork of
> [`aidlc-io/aidlc`](https://github.com/aidlc-io/aidlc) by hueanmy (`hueanmy.aidlc`). It is not
> affiliated with or endorsed by the upstream author. Its commands and settings live under
> `aidlcNative.*`, so the two extensions can be installed side by side.

You declare agents, skills and pipelines once in `.aidlc/workspace.yaml`. Each piece of work is an
**epic** that owns its pipeline: Claude runs a step, writes the step's artifact, and the pipeline
waits at the review gates you set. The extension and the [`aidlc` CLI](https://www.npmjs.com/package/@delete101020/aidlc)
read and write the same files, so you can start an epic in one and finish it in the other.

## The six stages

The **AI-Native SDLC** workflow follows the
[AI-Native SDLC Playbook](https://claude.com/blog/the-ai-native-sdlc-playbook). Each stage is run by
its own agent and leaves a file under `docs/epics/<epic>/artifacts/`:

| # | Stage | Phase | Agent | Artifact |
|---|---|---|---|---|
| 1 | Plan | `intent` | Originator | `intent.md` — the problem, who it hurts, what done means |
| 2 | Design | `spec` | Product Owner | `spec.md` — requirements and design in one document |
| 3 | Build | `build-plan` → `implement` | Engineer | `plan.md`, then the code and `implement.md` |
| 4 | Test | `verify` | Verifier | `verify.md` — an independent verdict against the spec |
| 5 | Deploy | `review` | Reviewer | `review.md` — the diff checked against policy |
| 6 | Maintain | `maintain` | Operator | `incident.md` — a production signal, diagnosed |

Verify and review are run by fresh-context agents, not by the session that wrote the code. Stage 6
closes the loop: a production signal becomes an incident epic, and the fix it needs opens as a new
epic at stage 1 with its `intent.md` already written.

Not every change needs all six. **Start Epic** reads a one-line brief and picks a recipe, which you
can override:

| Recipe | Steps | For |
|---|---|---|
| `native-full` | intent → spec → build-plan → implement → verify → review | New behaviour |
| `native-fix` | intent → build-plan → implement → verify → review | Bugs, refactors, tech debt |
| `native-lite` | intent → build-plan → implement → review | Small changes with a precedent in the code |
| `native-quick` | intent → build-plan → implement → verify | Small, well-understood changes |
| `native-align` | intent → spec | Agreeing on scope before any code |
| `native-hotfix` | build-plan → implement → review | Production is down and the cause is known |

## Getting started

1. Make sure the [Claude Code](https://claude.com/claude-code) CLI is installed and signed in
   (`claude --version`).
2. Open a project folder and click the **AIDLC** icon in the activity bar.
3. Apply the **AI-Native SDLC** workflow from the sidebar's workflow list, or run
   `aidlc preset apply ai-native` in a terminal. This writes the six agents, their skills, the
   `ai-native-full` pipeline and the `native-*` recipes into `.aidlc/workspace.yaml`.
4. **Start Epic**, describe the work in a line, and accept or change the suggested recipe.
5. Work each step: run its slash command in Claude (for example `/ai-native-full-intent EPIC-1`),
   read the artifact, then **Approve**, **Reject** with feedback, or **Rerun**. Or use
   **Run to completion** to execute the remaining steps back to back, pausing at the gates you keep.

The same epic from a terminal:

```sh
npm install -g @delete101020/aidlc
aidlc preset apply ai-native
aidlc epic start EPIC-1 --brief "fix the login redirect loop"   # → recipe native-fix
aidlc run exec EPIC-1                                            # runs steps, stops at review gates
```

Just exploring? **AIDLC Native: Load Demo Project** drops a finished example (the classic workflow and
six sample epics) into the open folder.

## Features

- **Epics that own their pipeline** — an epic's assembled pipeline lives in
  `docs/epics/<id>/pipeline.yaml`, its depth (`strict_mode`) in its own `state.json`, and its step list
  and gates stay editable while it runs.
- **Review gates** — `human_review` pauses for you; `auto_review` runs a validator headlessly.
  **Reject** sends your feedback back to the step that produced the artifact and resets what came after.
- **Run to completion** — one button, the same engine as `aidlc run exec`. Cancelling takes effect at
  the next step boundary, so a half-written artifact never passes a gate.
- **Incident loop** — **Report a Signal** turns a production signal into an incident epic;
  `aidlc maintain --signal` does the same from a webhook or a cron job.
- **Artifact review in the browser** — open any artifact in the bundled
  [annotron](https://www.npmjs.com/package/annotron), point and click your feedback, and Claude applies it
  back to the Markdown with an attributed revision history.
- **Epic memory** — a short per-epic digest of decisions and constraints that any agent can load cheaply.
- **Code graph for Claude** — an [ast-graph](https://github.com/emtyty/ast-graph) (default) or
  [CodeGraph](https://github.com/colbymchenry/codegraph) MCP server, registered for the project so Claude
  answers structural questions without grepping. CodeGraph suits large repos.
- **AIDLC Monitor** — token usage and cost, session insights from Claude Code transcripts, and live agent
  sessions through [agents-observe](https://github.com/simple10/agents-observe).
- **One window, one Claude account** — pin a Claude config dir per workspace
  (`aidlcNative.claude.configDir`) or switch with **AIDLC Native: Switch Claude Account**.
- **Workspace Builder** — a visual editor for agents, skills, pipelines and recipes.
- **Requirements import** — pull requirements from Jira, GitHub Issues, Linear, Redmine or a file into
  `requirements.md` (Builder → Analyze, or `aidlc analyze`).

The extension also ships the upstream workflows: the classic **AIDLC SDLC** pipeline
(Plan → (Design ∥ Test Plan) → Implement ∥ Generate Test Cases → Execute Test), **Spec Kit**, and the single-agent
`code-review` and `release-notes` presets.

## Network and privacy

AIDLC Native sends no telemetry of its own. Two things reach the network:

- **Claude** — every agent run shells out to your installed `claude` CLI, under your account.
- **The code-graph binary** — on first use the extension downloads the ast-graph or CodeGraph release
  for your platform from GitHub, checks it against a pinned SHA-256, and keeps it in the extension's
  storage. CodeGraph's own telemetry stays off unless you enable
  `aidlcNative.astGraph.codegraphTelemetry`. Set `aidlcNative.astGraph.enabled` to `false` to skip the
  download altogether.

## Commands

Everything is in the Command Palette under **AIDLC Native**. The ones you will use most:

| Command | What it does |
|---|---|
| `AIDLC Native: Start Epic` | Describe the work, pick a recipe, get a pipeline |
| `AIDLC Native: Open Epics List` | Every epic, its steps, artifacts and gates |
| `AIDLC Native: Report a Signal (open incident epic)` | Stage 6: turn a production signal into an incident epic |
| `AIDLC Native: Load Template` | Apply a workflow such as AI-Native SDLC |
| `AIDLC Native: Open Workspace Builder` | Edit agents, skills, pipelines and recipes |
| `AIDLC Native: Open Claude CLI Terminal` | A terminal with `claude` already running |
| `AIDLC Native: Open AIDLC Monitor (Token Usage + Insights + Agents)` | Tokens, cost and live sessions |
| `AIDLC Native: Analyze Requirements → Create Tasks` | Import requirements from a tracker or a file |
| `AIDLC Native: Switch Claude Account` | Choose which Claude config dir this window uses |
| `AIDLC Native: Load Demo Project (full pipeline + 6 epics)` | A worked example to explore |

## Requirements

- VS Code 1.85+, or an editor that installs from Open VSX (Antigravity, Cursor, VSCodium, Windsurf)
- The [Claude Code](https://claude.com/claude-code) CLI on `PATH`, signed in
- A folder open (single-file mode is not supported)
- For the CLI: Node.js 18+

Upgrading from a build before 4.0? Settings under `aidlc.*` are copied to `aidlcNative.*` the first time
the extension starts. Keybindings are yours to update: change `aidlc.` to `aidlcNative.` in
`keybindings.json`.

## Credit

Built on [`aidlc-io/aidlc`](https://github.com/aidlc-io/aidlc) by
[hueanmy](https://github.com/hueanmy). If it saves you time,
[sponsor the original author](https://github.com/sponsors/hueanmy) ❤️.

## License

MIT — the original copyright line is kept; this fork's changes are added under
the same terms.
