# Onboarding — running AIDLC Native on your machine

AIDLC Native is a fork of [`aidlc-io/aidlc`](https://github.com/aidlc-io/aidlc) by
hueanmy, extended with the AI-Native SDLC Playbook. It ships as the extension
`delete101020.aidlc-native` (VS Code Marketplace and Open VSX) and the CLI
`@delete101020/aidlc` (npm).

Sections 1–5 are setup and take about ten minutes. Section 6 onward is how the
workflow runs day to day — read **section 7** before you work your first step.

---

## 1. Prerequisites

| Need | Check | If missing |
|---|---|---|
| Node.js 18+ | `node --version` | Install via [nvm](https://github.com/nvm-sh/nvm). Needed by the CLI. |
| Claude CLI, logged in | `claude --version` | See [Claude Code](https://claude.com/claude-code). The default runner spawns this binary. |

VS Code 1.85.0+, or any editor that installs from Open VSX (Antigravity, Cursor,
VSCodium, Windsurf), opened on a workspace **folder**.

## 2. Install the extension and the CLI

```sh
code --install-extension delete101020.aidlc-native   # or search "AIDLC Native" in Extensions
npm install -g @delete101020/aidlc
aidlc --version
```

- Commands and settings live under `aidlcNative.*`, so it can sit next to the
  upstream `hueanmy.aidlc`. Settings from a pre-4.0 `aidlc.*` install are copied
  on first activation; keybindings you update by hand.
- The npm package is scoped but the command is still `aidlc`. If `npm` says
  `aidlc` already exists, the upstream CLI is installed: `npm uninstall -g aidlc`
  and retry.

## 3. Building from source (optional)

Only to run unreleased changes. Needs pnpm (`npx --yes corepack pnpm --version`)
and the `code` command on PATH.

```sh
git clone git@github.com:delete101020/ai-native-sdlc.git
cd ai-native-sdlc
pnpm install && pnpm -r compile

pnpm package:extension
code --install-extension packages/extension/aidlc-native-<version>.vsix --force

cd packages/cli && pnpm bundle && npm link
```

`--force` re-installs over the same version; reload the window afterwards.
`npm link` points at your checkout, so after `git pull` re-run
`pnpm -r compile && pnpm --filter @delete101020/aidlc bundle`. From inside this
repo, `/install-local` in Claude Code does all of the above.

## 4. Turn on the approval gate

**Easy to miss, and nothing reminds you.** The hook script is committed at
`.claude/hooks/aidlc-approval-gate.py`, but it is registered in
`.claude/settings.json`, which is **gitignored**. Each clone opts in by creating
that file:

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

| Blocked | Why |
|---|---|
| `git push --force` to `main` / `master` | Protected branches are fast-forward only |
| `git add` of a credential-shaped path (`.env`, `*.pem`, `id_rsa`, …) | Secrets never enter a commit |
| Hand-editing `docs/epics/*/state.json` | The runner is the only writer of run state |

It fails open: input it cannot evaluate is allowed — except under an
`autopilot: true` pipeline, where nobody is watching and the same input is
blocked. Such a pipeline will not start at all until the hook is registered
(`aidlc doctor` shows it under **Unattended runs**). Check it with:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}' \
  | python3 .claude/hooks/aidlc-approval-gate.py; echo "exit=$?"   # exit=2
```

## 5. Set up a project

In the project you want to run the playbook on:

```sh
aidlc init                               # scaffolds .aidlc/workspace.yaml
aidlc preset apply ai-native             # agents, skills, the ai-native-full pipeline, native-* recipes
aidlc globals install ai-native-pipeline # REQUIRED — installs the skills the preset points at
aidlc doctor                             # workspace, Claude binary, skill paths, run state
```

Skip `globals install` and every step fails at spawn time with a missing skill.

---

## 6. The workflow

Seven phases. Each writes one artifact into `docs/epics/<EPIC-ID>/artifacts/`
and stops for a human unless noted:

| # | Phase | Persona | Artifact | Gate |
|---|---|---|---|---|
| 1 | `intent` | Originator | `intent.md` — problem, who hurts, cost, evidence, done-looks-like | human |
| 2 | `spec` | Product Owner | `spec.md` — testable requirements, acceptance criteria | human |
| 3 | `build-plan` | Engineer | `plan.md` — files, order, risks, proofs | human |
| 4 | `implement` | Engineer | branch + PR, `implement.md` with executed proofs | human |
| 5 | `verify` | Verifier | `verify.md` — per-criterion verdict with evidence | human |
| 6 | `review` | Reviewer | `review.md` — the diff against policy | human |
| 7 | `maintain` | Operator | `incident.md` — a production signal, diagnosed | **none** |

- **Verify and review run in fresh context**, so the agent judging the work is
  not the session that wrote it. Don't have the engineer verify its own build.
- **`maintain` has no human gate** because a production signal does not wait.
  The gate moves to the `intent.md` of the epic `maintain` opens.

A **recipe** picks which phases an epic runs. Each row adds a gate the row
above skipped:

| Recipe | Steps | When |
|---|---|---|
| `native-spike` | `intent` | Capture the problem only |
| `native-align` | `intent → spec` | Agree scope with a PO before engineering |
| `native-quick` | `intent → build-plan → implement → verify` | Small, well-understood change |
| `native-lite` | `intent → build-plan → implement → review` | Small change with a precedent; humans gate only `intent` and `build-plan` |
| `native-fix` | `intent → build-plan → implement → verify → review` | Bug fix, refactor, tech debt |
| `native-autopilot` | `intent → build-plan → implement → verify → review` | Like `native-fix`, but runs on its own once you approve the plan — see [PIPELINE_CONFIG.md](PIPELINE_CONFIG.md#the-native-autopilot-recipe) |
| `native-full` | `intent → spec → build-plan → implement → verify → review` | Real features — the default |
| `native-hotfix` | `build-plan → implement → review` | Production is burning and the cause is known |
| `native-audit` | `review` | Judge an existing diff against policy |
| `native-incident` | `maintain` | A production signal arrived |

`spec` earns its place when the *behaviour* is up for debate. `verify` asks
"does this meet the spec", `review` asks "does this obey our policy" — they are
not interchangeable. ⚠️ Reach for `native-hotfix` reluctantly: no `intent`, no
independent `verify`, during an incident. Prefer `native-fix`.

For a small epic, start it with **Keep it proportional** (`--no-strict`) so the
phases don't fill out full-size templates. Recipe gates, `strict_mode`,
`epic_id_prefix` and the rest of the step options are in
[PIPELINE_CONFIG.md](PIPELINE_CONFIG.md).

## 7. Working a step — and sending work back

Every step moves through the same states:

```
          Run with Claude
pending ──▶ awaiting_work ──Mark step done──▶ awaiting_review ──Approve──▶ approved ──▶ next step
                 ▲                                  │
                 │                                  ├─Reject, stay on this step──▶ rejected ──Rerun──┐
                 │                                  │                                                │
                 │                                  └─Reject, send back to step N ──▶ step N reopens │
                 └───────────────────────────────────────────────────────────────────────────────────┘
```

**Mark step done ≠ the step passed.** It only says the work is finished and its
`produces` files exist. The verdict is **Approve** or **Reject**, given after
you read the artifact. On a step with `human_review: false`, Mark step done
approves on its own and there is no Reject button.

### Which button

| Situation | Use | What happens |
|---|---|---|
| The artifact is good | **Approve** | Step approved, the next step opens |
| The step itself did a poor job (e.g. a sloppy review of good code) | **Reject → Stay on this step**, then **Rerun** | Step goes to `rejected`; Rerun bumps its revision and reopens it with the feedback you enter (the reject reason is shown for reference) |
| The step found a problem in an **earlier** step's work (e.g. review finds a bug in `implement`) | **Reject → Send back to step N** | Step N reopens with a new revision and your reason as its feedback; everything between N and this step resets to `pending` and runs again |
| You clicked Mark step done too early | **Undo mark done** | Back to `awaiting_work`; also works on an auto-approved step as long as nothing after it has been worked |
| A step was approved, and later turns out wrong | **Request update** on that step | It reopens; every step after it resets to `pending` |
| A step's prompt or skill changed and you want its output regenerated, keeping later work | **Rerun with Claude** on the approved step | It reopens alone; later approved steps stay approved but are marked `dirty` until re-approved |

### The common mistake

When review finds a bug, **don't** approve the review and then go back to
`implement` to Request update or Rerun. That works, but:

- the history says the review **passed**;
- the finding never reaches `implement` unless you retype it;
- with **Rerun with Claude**, the review stays approved (only `dirty`) against
  code that has since changed.

**Reject the review and send it back to `implement`.** The reject reason is
copied into `implement`'s feedback as `Rejected at step N (review): <reason>`,
so **Update with feedback** hands it straight to the agent; `verify` and
`review` reset and judge the new code; and the history records where the work
went back to and why. On a pipeline with `depends_on`, only the steps that
depend on the target are reset.

For a closer look before deciding, open a step's `.md` with **Feedback**: it
renders the Markdown (Mermaid included) in annotron for point-and-click
comments and applies them back into the file.

## 8. Driving it

**Extension.** Click the **AIDLC** icon in the activity bar. Start an epic,
pick a recipe, then work each step from its card as in section 7.
**Run to completion** executes the remaining steps back to back, pausing at the
gates you keep. **Report a Signal** opens an incident epic (`maintain`).

**CLI.**

```sh
aidlc epic start EPIC-1 --brief "fix the login redirect loop"
aidlc run exec <runId>                         # runs steps, stops at each human gate
aidlc run approve <runId>
aidlc run reject <runId> --reason "…"           # stay on this step, then `run rerun`
aidlc run reject <runId> --reason "…" --to <step>  # = Send back to step N
aidlc run rerun <runId> [--feedback "…"]        # retry a rejected step
aidlc run request-update <runId> <step>         # reopen an approved step, reset what follows
aidlc run redo <runId> <step>                   # = Rerun with Claude: keep later steps, mark dirty
aidlc status                                    # all runs; add a runId for detail
```

`run exec` exits `0` completed, `2` paused on a gate (awaiting review, rejected,
over budget), `1` error. `--to` and the other `<step>` arguments take a 0-based
index, a step name or an agent id; `--to` must name a step before the one
being rejected.

## 9. `maintain` — closing the loop

A signal is a small JSON file:

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

aidlc maintain --signal signal.json            # opens INC-… and runs the diagnosis
aidlc maintain follow-up INC-CHECKOUT-RETURNS-500 \
  --problem "Returning customers cannot check out" \
  --who-hurts "Repeat buyers completing a purchase" \
  --done "Checkout succeeds for a customer with prior orders"
```

The follow-up epic starts at `intent` with a human gate. `--signal -` reads
stdin, so a webhook forwarder or cron job can pipe straight in — every phase
must be runnable headless before it gets a button.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `aidlc: command not found` after switching Node versions | Global packages are per Node version. Reinstall, or re-run `npm link` in `packages/cli`. |
| `aidlc --version` prints an old number | Another global install shadows it — check `which aidlc`. |
| Extension changes do nothing | Rebuild (`pnpm package:extension`) and reinstall with `--force`, then reload. |
| A step fails immediately with a missing skill | `aidlc globals install ai-native-pipeline` was skipped — check `aidlc globals status`. |
| No **Reject** button after Mark step done | The step has `human_review: false`, so it auto-approved. **Undo mark done**, turn **Human** on for the step, and mark it done again. |
| Force-push or `.env` staging silently succeeds | `.claude/settings.json` is missing — see section 4. |

## Where to read more

- [PIPELINE_CONFIG.md](PIPELINE_CONFIG.md) — recipe gates, `produces_contains`, `default_skill`, `strict_mode`, `epic_id_prefix`
- `README.md` — architecture, full CLI reference, run-state backends
- `packages/extension/README.md` — the extension's features and commands
- `AI_NATIVE_SDLC_ALIGNMENT.md` — why the playbook was mapped this way
- `aidlc guide` — getting-started material in the terminal
