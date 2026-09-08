# Onboarding — running this fork on your machine

This is a fork of [`aidlc-io/aidlc`](https://github.com/aidlc-io/aidlc) by hueanmy,
extended with the AI-Native SDLC Playbook. **Nothing here is published** — not to
the VS Code Marketplace, not to Open VSX, not to npm. Both the extension and the
CLI are built from this repo and installed locally, so this page is the whole
distribution channel.

Read it end to end the first time. Steps 1–4 are setup and take about ten
minutes; step 5 onward is how the workflow actually runs day to day.

---

## 1. Prerequisites

| Need | Check | If missing |
|---|---|---|
| Node.js 20+ | `node --version` | Install via [nvm](https://github.com/nvm-sh/nvm). This repo is developed on v24.12.0. |
| pnpm | `npx --yes corepack pnpm --version` | Nothing to install — `corepack` ships with Node and reads the `packageManager` field. |
| The `code` command | `code --version` | In VS Code: `Cmd+Shift+P` → **Shell Command: Install 'code' command in PATH**. |
| Claude CLI, logged in | `claude --version` | See [Claude Code](https://claude.com/claude-code). The default runner spawns this binary; without it, runs cannot execute. |

VS Code 1.85.0+ (or VSCodium / Cursor / Windsurf). A workspace **folder** —
single-file mode is not supported.

## 2. Get the repo

```sh
git clone git@github.com:delete101020/ai-native-sdlc.git
cd ai-native-sdlc
pnpm install
pnpm -r compile
```

Keep this checkout where it is. Step 4 links the CLI **into** this directory —
moving or deleting it later breaks the `aidlc` command.

## 3. Install the extension

```sh
pnpm package:extension                                        # → packages/extension/aidlc-<version>.vsix
code --install-extension packages/extension/aidlc-3.5.1.vsix --force
```

`--force` is what lets you re-install over the same version number; without it
`code` refuses when the version has not changed.

Then **`Cmd+Shift+P` → Developer: Reload Window**. A newly installed `.vsix` has
no effect in windows that are already open.

Verify, and check for the clash:

```sh
code --list-extensions --show-versions | grep -i aidlc
```

You want `delete101020.aidlc@3.5.1`. **If `hueanmy.aidlc` also appears, disable
one of them** (Extensions view → the extension → Disable). Both builds
contribute the same `aidlc.*` command ids, and VS Code binds each command to
whichever extension activated first — with both enabled, which one answers a
command is not predictable.

## 4. Install the CLI

```sh
cd packages/cli && pnpm bundle && npm link
aidlc --version        # 3.5.1
which aidlc
```

`pnpm bundle` is required — a plain `tsc` build is not enough, because the
package's `bin` entry points at `dist/bundle.js`, which esbuild produces along
with the templates, tools and vendored assets copied beside it.

Two things to know about the link:

- It points at your **checkout**, so after `git pull` a `pnpm -r compile &&
  pnpm --filter aidlc bundle` is enough to update the CLI. The extension is not
  live-linked — it needs a fresh `.vsix` and a re-install (step 3).
- It is installed under the Node version active when you ran it. Switch Node
  versions with nvm and `aidlc` disappears from `PATH`; re-run `npm link` under
  the new version.

If `aidlc --version` prints something other than `3.5.1`, an older global
install is shadowing the link — check `which aidlc` before assuming the build
is wrong.

## 5. Turn on the approval gate

**This step is easy to miss and nothing will remind you.** The hook script is
committed at `.claude/hooks/aidlc-approval-gate.py`, but its registration lives
in `.claude/settings.json`, which is **gitignored** — so a fresh clone has the
gate's code and none of its effect. Each clone opts in deliberately.

Create `.claude/settings.json` in the repo you want gated:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          { "type": "command", "command": ".claude/hooks/aidlc-approval-gate.py" }
        ]
      }
    ]
  }
}
```

What it blocks, and why:

| Blocked | Why |
|---|---|
| `git push --force` to `main` / `master` | Protected branches are fast-forward only |
| `git add` of a credential-shaped path (`.env`, `*.pem`, `id_rsa`, …) | Secrets never enter a commit |
| Hand-editing `docs/epics/*/state.json` | The runner is the single writer; state advances through "Mark step done" |

It **fails open** — malformed input, an unknown tool, or a rule it cannot
evaluate allows the action. A gate that fails closed on its own bugs blocks real
work and gets uninstalled within a day.

Sanity-check it directly:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | python3 .claude/hooks/aidlc-approval-gate.py; echo "exit=$?"   # exit=2, reason on stderr
```

---

## 6. Set up a project to use the workflow

In the project you want to run the playbook on (not necessarily this repo):

```sh
aidlc init                      # scaffolds .aidlc/workspace.yaml
aidlc preset apply ai-native    # 6 agents, 7 skills, 1 pipeline
aidlc globals install ai-native-pipeline
aidlc validate
```

`aidlc globals install` is **not optional**. The preset writes skill paths of
the form `~/.claude/skills/aidlc-native-*.md`, and those files only exist once
the globals are installed. Skip it and every step fails at spawn time with a
missing skill.

Finish with `aidlc doctor` — it checks the workspace, the Claude binary and
auth, every declared skill path, and the run-state files in one pass. All seven
native skills should come back green; if they do not, `aidlc globals status`
tells you whether the workflow is installed at all.

## 7. The workflow itself

Seven phases, run in order. Each writes one artifact and stops for a human
unless noted:

| # | Phase | Persona | Artifact | Gate |
|---|---|---|---|---|
| 1 | `intent` | Originator | `intent.md` — problem, who hurts, cost, evidence, done-looks-like | human |
| 2 | `spec` | Product Owner | `spec.md` — testable requirements, acceptance criteria | human |
| 3 | `build-plan` | Engineer | `plan.md` — files, order, risks, proofs | human |
| 4 | `implement` | Engineer | branch + PR, `implement.md` with executed proofs | human |
| 5 | `verify` | Verifier | `verify.md` — per-criterion verdict with evidence | human |
| 6 | `review` | Reviewer | `review.md` — the diff against policy | human |
| 7 | `maintain` | Operator | `incident.md` — a production signal, diagnosed | **none** |

Two design points worth internalising before you use it:

- **Verify and review run in fresh context.** They are separate phases with
  separate personas precisely so the agent judging the work is not the session
  that wrote it. Do not "save a step" by having the engineer verify its own
  build — that is the entire point of the split.
- **`maintain` has no human gate.** A production signal does not wait for
  office hours. The gate has not been removed, it has moved: to stage 1 of the
  epic that `maintain` opens, where the generated `intent.md` is reviewed
  before anything is built.

Nine recipes pick how much of that you run. Read the table as a ladder: each
row adds a gate the row above skipped.

| Recipe | Steps | When |
|---|---|---|
| `native-spike` | `intent` | Capture the problem only — no spec, no code |
| `native-align` | `intent → spec` | Agree the scope with a PO before engineering starts |
| `native-quick` | `intent → build-plan → implement → verify` | Small, well-understood change |
| `native-lite` | `intent → build-plan → implement → review` | Small change with a precedent to follow — the human gates sit on `intent` and `build-plan` only |
| `native-fix` | `intent → build-plan → implement → verify → review` | Bug fix, refactor, tech debt — no new behaviour to specify, but still gated |
| `native-full` | `intent → spec → build-plan → implement → verify → review` | The default for real features |
| `native-hotfix` | `build-plan → implement → review` | Production is burning and the cause is known — see the warning below |
| `native-audit` | `review` | Judge a diff that already exists against policy |
| `native-incident` | `maintain` | A production signal arrived |

**Choosing between them** comes down to which of `spec`, `verify` and `review`
the work actually needs:

- `spec` earns its place when the *behaviour* is up for debate. A refactor has
  no new behaviour, so `native-fix` drops it; a feature does, so `native-full`
  keeps it.
- `verify` and `review` are the two gates, and they are not interchangeable —
  `verify` asks "does this meet the spec", `review` asks "does this obey our
  policy". Dropping both is what makes `native-quick` quick.

**Where the human stands is part of the recipe too.** A recipe may override
the gates on any step it selects, so two recipes over one pipeline can
disagree about which steps stop for a person:

```yaml
recipes:
  - id: native-lite
    from: ai-native-full
    steps: [intent, build-plan, implement, review]
    gates:
      intent:     { human_review: true }
      build-plan: { human_review: true }
      implement:  { human_review: false }
      review:     { human_review: false }
```

A step with no entry keeps the gates its pipeline declares. `native-lite`
spends its attention where a wrong direction is cheapest to correct — on the
intent and the plan — and lets the branch run to the end from there. That is
only safe when the change has a precedent in the codebase to follow; without
one, use `native-fix`.

Gates can also be turned on and off per step on a *running* epic, with
`aidlc epic step set <epic> <step> --no-human-review` or the **Human** / **Auto**
checkboxes on the pipeline step in the sidebar. **Auto** means the step runs an
auto-reviewer — a script named by `auto_review_runner` that returns a
pass/reject verdict — before the step can advance; it is a mechanical gate, not
a second opinion from an agent.

⚠️ **`native-hotfix` is the one recipe to reach for reluctantly.** Without
`intent` the engineer starts with nothing but the epic description as context,
and without `verify` nobody independently checks the fix — during an incident,
which is when haste makes mistakes likeliest. It exists because the clock
sometimes genuinely forbids the longer path. Prefer `native-fix`, which costs
one extra phase and keeps both gates.

Artifacts land in `docs/epics/<EPIC-ID>/artifacts/` (configurable via
`state.root` in `workspace.yaml`), alongside the epic's `state.json` — which you
never edit by hand; see step 5.

### An epic owns its pipeline

Starting an epic assembles a pipeline from the recipe and keeps it, because
`state.json` names it and every later step edit rewrites it. That definition
lives with the epic, not in the shared file:

    docs/epics/EPIC-001/
      pipeline.yaml     ← the epic's own pipeline
      state.json        ← names it ("pipeline": "EPIC-001")
      artifacts/

`.aidlc/workspace.yaml` therefore stays what it is meant to be: team-wide
agents, skills, recipes and the base pipelines everyone draws from. The reason
is merge behaviour. One shared list means every concurrent epic appends at the
same place — a conflict per epic, forever — and the file grows by a near-copy
of the base pipeline each time. One file per epic has one owner and no shared
append point.

Nothing else changes. The pipeline is spliced into `pipelines:` when the
workspace is read and routed back out when it is written, so the CLI, the
sidebar and the runner all still find it exactly where they always looked.
Commit `pipeline.yaml` with the epic — `artifact_commit` already puts it on the
epic's branch next to `state.json`.

**Workspaces that predate this** keep their epic pipelines inline until you
move them:

```bash
aidlc epic pipeline extract --dry-run   # list what would move
aidlc epic pipeline extract             # move it, in its own commit
```

It moves only a pipeline an epic both names in its `state.json` *and* owns by
name (`EPIC-001`, or `EPIC-001-native-lite`). A shared, hand-authored pipeline
that an epic happens to run stays in `workspace.yaml`, where the other epics
running it can still see it. `aidlc doctor` lists what is left.

### How deep an epic goes — `strict_mode`

A recipe decides *which steps* an epic runs. `strict_mode` decides *how far
each one goes*, and it is set per epic because depth is a property of the work
item, not of the team:

```bash
aidlc epic start EPIC-003 --recipe native-lite --no-strict
aidlc epic strict EPIC-003            # show it
aidlc epic strict EPIC-003 off        # change it on an epic already running
```

In the extension it is the **Keep it proportional** checkbox under Workflow in
the Start epic modal, and the **Full depth / Proportional** chip on the epic
card. Either way it lands as `"strict_mode": false` in the epic's `state.json`,
and it takes effect on the next phase run — nothing already written changes.

The templates are built for the largest thing an epic can be: a spec with
non-functional requirements, risks, alternatives considered, a migration and
rollback plan. That is right for an epic that earns it, and wrong for an epic
the size of one migration task, where the same template produces pages nobody
asked for, every phase after it has more to read, and two hours of work takes a
day to get through the pipeline.

Under `strict_mode: false` a phase covers what the change actually needs and
stops. It keeps every heading the template has — the auto-reviewer and the
traceability validator match on those exact strings, so a section dropped for
brevity is a gate failed — and gives a heading that does not apply one honest
line instead of invented content. It is a budget on breadth, never on
correctness: the phase still reads the code it is changing, and still leaves
the next phase what it needs.

Absent means `true`, so every epic started before this keeps the depth it had.

## 8. Driving it from the extension

Click the **AIDLC** icon in the activity bar. From the sidebar you can start an
epic, watch each step's status, open the artifact a step produced, and approve
or reject a step at its gate. Rejecting asks for a reason, which is fed back to
the agent on re-run; "Request update" reopens an already-approved step and
resets everything downstream of it.

For reviewing an artifact properly rather than skimming it in the editor, use
the **Feedback** action on a step's `.md`: it renders the Markdown (Mermaid
diagrams included) and opens it in annotron for point-and-click comments, then
applies your feedback back into the `.md` with an attributed revision history.

**What the extension does not cover:** there is no command for stage 6. The
`AIDLC: …` command palette entries predate the playbook, and adding buttons for
`maintain` was deliberately left undone — the CLI-first rule below explains why.
Stage 6 is terminal-only. Everything else in the playbook is drivable from
either surface.

## 9. Driving it from the CLI

```sh
aidlc run start ai-native-full --context epic=ABC-123
aidlc run exec <runId>              # spawns claude, streams output, stops at each gate
aidlc run approve <runId>           # or: reject / rerun / request-update
aidlc status                        # all runs; add a runId for detail
aidlc watch                         # live table
```

`run exec` stops at every `human_review` step unless you pass `--auto-approve`.
Its exit codes are meant for scripting: `0` completed, `2` paused on a gate
(awaiting review, rejected, or over budget), `1` error.

## 10. Stage 6 — closing the loop back to stage 1

A signal is a small JSON file (`source`, `observedAt`, `symptom`, `scope`,
`evidence`):

```sh
cat > signal.json <<'EOF'
{
  "source": "sentry",
  "observedAt": "2026-08-31T09:14:00Z",
  "symptom": "Checkout returns 500 for returning customers",
  "scope": "~4% of checkout attempts, EU region",
  "evidence": "https://sentry.io/issues/12345"
}
EOF

aidlc maintain --signal signal.json
# → opens INC-CHECKOUT-RETURNS-500 and runs the diagnosis
```

Then turn the diagnosis into the next epic, with its `intent.md` already
written from the signal:

```sh
aidlc maintain follow-up INC-CHECKOUT-RETURNS-500 \
  --problem "Returning customers cannot check out" \
  --who-hurts "Repeat buyers completing a purchase" \
  --done "Checkout succeeds for a customer with prior orders" \
  --question "Is this specific to the EU payment provider?"
```

That epic enters at stage 1 with a human gate on the intent — which is where
the gate that `maintain` skipped reappears. `--signal -` reads stdin, so a
webhook forwarder or a cron job can pipe straight in; that is what "CLI first"
buys you.

**Why CLI first is a rule, not a preference:** every new phase must be runnable
from a terminal, a cron job, or a webhook forwarder before it gets a button.
`@aidlc/core` is the API; the extension and the CLI are both callers of it.
Stage 6 exists to be triggered by machines at 3am, on hosts where VS Code is
never opened.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `aidlc: command not found` after switching Node versions | The link is per-Node-version. Re-run `npm link` in `packages/cli`. |
| `aidlc --version` prints an old number | An older global install shadows the link. Check `which aidlc`. |
| Extension commands behave inconsistently | Both `delete101020.aidlc` and `hueanmy.aidlc` are enabled. Disable one. |
| Changes to the extension do nothing | You reloaded but did not rebuild: `pnpm package:extension` then re-install with `--force`. |
| `doctor` says the native skills are missing | `aidlc globals install ai-native-pipeline` has not been run on this machine — check `aidlc globals status`. |
| A step fails immediately with a missing skill | `aidlc globals install ai-native-pipeline` was skipped. |
| Force-push or `.env` staging silently succeeds | `.claude/settings.json` does not exist — the gate was never registered. See step 5. |

## Where to read more

- `README.md` — architecture, full CLI reference, run-state backends
- `packages/extension/README.md` — the extension's features and command list
- `AI_NATIVE_SDLC_ALIGNMENT.md` — why the playbook was mapped this way, what was
  deliberately not built, and the decisions behind each workstream
- `aidlc guide` — the same getting-started material in the terminal, no LLM, no cost
