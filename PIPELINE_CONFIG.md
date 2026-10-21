# Pipeline configuration reference

How to shape the steps of a pipeline in `.aidlc/workspace.yaml` (or an epic's
own `docs/epics/<id>/pipeline.yaml`). For getting started, read
[ONBOARDING.md](ONBOARDING.md) first.

## Gates per recipe — `gates:`

A recipe may override the gates on any step it selects, so two recipes over
one pipeline can disagree about which steps stop for a person:

```yaml
recipes:
  - id: native-lite
    from: ai-native-full
    steps: [intent, build-plan, implement, review]
    gates:
      intent:     { human_review: true }
      build-plan: { human_review: true }
      implement:  { human_review: false }
      review:     { human_review: false, auto_review: true,
                    auto_review_runner: .aidlc/validators/verdict.mjs }
```

A step with no entry keeps the gates its pipeline declares.

`verdict.mjs` reads the `Verdict: ship|hold` line in `review.md` (or
`Verdict: pass|fail` in `verify.md`). A `hold`, or a report it cannot read,
rejects the step, and the reject reason is the report's "Shortest path to …"
list.

Gates can also be changed on a *running* epic, with
`aidlc epic step set <epic> <step> --no-human-review` or the **Human** /
**Auto** checkboxes on the step in the sidebar. **Auto** runs the script named
by `auto_review_runner`, which returns a pass/reject verdict before the step can
advance — a mechanical gate, not a second opinion from an agent.

## Sending work back on a reject — `on_reject`

By default an auto-review reject stops the run on the step that was
rejected. That is right for a check on the step's own output. It is wrong
for verify and review: running review again on the same code gives the same
verdict, because it is `implement` that has to change. `on_reject` sends the
work back instead:

```yaml
recipes:
  - id: my-autopilot
    from: ai-native-full
    steps: [intent, build-plan, implement, verify, review]
    gates:
      review: { human_review: true, auto_review: true,
                auto_review_runner: .aidlc/validators/verdict.mjs,
                on_reject: { send_back_to: implement } }
```

On a `hold`, `implement` reopens on a new revision with the reviewer's
"Shortest path to ship" list as its feedback, and the steps after it reset
to pending. `aidlc run exec` (or **Run to completion**) then carries on from
there. The same key works on a step in a pipeline.

- The target must come before the step and must not have `human_review`.
  Work a person approved goes back through a person. A bad target is an
  error when workspace.yaml loads or the recipe assembles, not when the run
  is under way.
- A validator may return `sendBackTo` with its verdict. It can confirm the
  target, or give `null` (or its own step) to stop for a person. Naming any
  other step stops the run, and the suggestion is written into the reject
  reason; send it back by hand (`aidlc run reject <run> --to spec --reason …`)
  if you agree. The run only ever sends work back to the `on_reject` target
  on its own.
- **`max_send_backs`** on the pipeline (default 3) caps how many times the run
  sends work back before it stops for a person. Any human action on the run
  (approve, reject, rerun, request update) starts the count again.
- If the step it sent work back to changes no code, the run stops instead of
  going round again (`aidlc run exec` exits 2). This compares the working
  tree before and after the step, leaving out the epic's own artifacts and
  `.aidlc/`.

Only one `aidlc run exec` (or **Run to completion**) can drive a run at a time.
`.aidlc/runs/<id>.lock` holds the pid of the process that owns it. A lock left
behind by a process that is gone is taken over.

## Running unattended — `autopilot`, runner `args`, `timeout_minutes`

### What a headless agent may do — `providers.<runner>.args`

`aidlc run exec` and **Run to completion** run each step as
`claude --print`, where nobody can answer a permission prompt: a tool that is
not allowed up front is denied. Without an allow list `implement` cannot edit
a file or run the tests, and still writes its report. Give the runner its
permissions in workspace.yaml, so the whole team runs with the same ones:

```yaml
providers:
  default:                  # the runner id: default (claude), codex, copilot, custom
    args: [--permission-mode, acceptEdits,
           --allowedTools, "Bash(npm test:*)", "Bash(git commit:*)"]
```

The args go on every step that runner runs, before the prompt. Flags that
switch permission checks off altogether make workspace.yaml fail to load:
`--dangerously-skip-permissions`, `--permission-mode bypassPermissions`,
Codex's `--dangerously-bypass-approvals-and-sandbox` and
`--sandbox danger-full-access`, Copilot's `--allow-all` and `--yolo`. If an
agent really needs a free hand, give it one inside a sandbox you control, with
`runner: custom`. `aidlc doctor` lists what is allowed under
**Unattended runs**.

### `autopilot: true`

A pipeline (or a recipe, which passes it on) marked `autopilot: true` is meant
to be left alone. `aidlc run exec` and **Run to completion** then refuse to
start it until:

- the checkout is on a branch of its own: not `main`, `master` or the remote's
  default branch, and not a detached HEAD;
- the working tree is clean, apart from the epic's own folder and `.aidlc/`;
- for steps Claude runs, the approval-gate hook is registered and its script
  exists (see [ONBOARDING.md](ONBOARDING.md) §4).

The run's agents get `AIDLC_AUTOPILOT=1` in their environment, and the gate
reads it: input it cannot evaluate, which it allows when someone is watching,
is blocked. The gate is a Claude Code hook, so Codex and Copilot steps run
without it; `doctor` warns about each one.

### A step only a person runs — `attended: true`

A step that has to ask someone (a close-out, a sign-off interview) gets
`attended: true` on the step itself. `run exec` stops before it — exit 0,
**Run to completion** says the next step is yours — and leaves it
`awaiting_work`; run it by hand. Without the flag the loop spawns the agent,
the skill refuses under `AIDLC_AUTOPILOT=1`, and the missing artifact stops
the run as an error.

### Stopping a step — `timeout_minutes`

```yaml
recipes:
  - id: my-autopilot
    autopilot: true
    gates:
      implement: { timeout_minutes: 30 }
      verify:    { timeout_minutes: 20 }
```

A step with `timeout_minutes` (on the step, or in a recipe's `gates`) is
stopped when it runs longer: the agent's whole process tree gets SIGTERM, then
SIGKILL 10 seconds later. The run fails (`aidlc run exec` exits 1). The step
stays `awaiting_work` on the same revision, with the stop in its history. It
is not sent back and does not count toward `max_send_backs`. Without the key
there is no limit.

You can stop a run by hand at two speeds:

| | CLI | Extension |
|---|---|---|
| After the running step finishes | Ctrl+C | Cancel on the progress notification |
| Now, killing the running step | Ctrl+C again | **Stop now** on the message that follows |

A step stopped halfway leaves whatever it wrote in the working tree. Check
`git status` before you carry on: an autopilot run will not start again until
the tree is clean.

### One plan, several sessions — `batches`

A headless `implement` that works through a whole plan in one session runs
until auto-compact starts dropping what it read, and a `timeout_minutes` long
enough for the whole plan stops nothing. `batches: true` runs the step as a
series of fresh sessions instead:

```yaml
recipes:
  - id: my-autopilot
    gates:
      implement: { batches: true, timeout_minutes: 30 }   # 30 minutes per batch
```

- `build-plan` groups the plan's `Order` into batches, so the person who
  approves the plan approves the slicing. `implement` does one batch per
  session. It may split a batch smaller, but never does two in one session.
- Each session updates the Progress table in its report (the step's first
  `produces` file) and ends it with `Status: continue` or `Status: done`. On
  `continue` the loop starts the next session on the same revision. On `done`
  the step finishes as usual.
- **Fail closed.** If the report has no such line, or its last `Status:` line
  says something else, the step fails and the run stops (exit 1).
- **Limits.** `timeout_minutes` applies to each batch. A `continue` batch that
  changed no code stops the run (exit 2), as a send-back that changes nothing
  does. `max_batches` (default 10) caps how many batches one `aidlc run exec`
  runs on the step. At the cap it stops (exit 2); running exec again allows as
  many more.
- **`pause_between_batches: true`** stops after every `continue` batch (exit 2,
  **Run to completion** says "paused between batches"), so a person can read
  the progress before the next one. An autopilot recipe leaves it off.
- **Sent back for another revision?** The first batch is the fixes the
  feedback asks for. The Progress table keeps the earlier revision's rows.
- The step's cost is the sum of its batches. Each batch is in its history and
  in `aidlc run report`.

A step without `batches` runs as before, in one session.

### The `native-autopilot` recipe

Every AI-Native workspace has a recipe that puts the pieces above together.
A person approves `intent` and `build-plan`. After that, nobody has to watch
until the finished branch reaches `review`:

```yaml
recipes:
  - id: native-autopilot
    from: ai-native-full
    steps: [intent, build-plan, implement, verify, review]
    autopilot: true
    max_send_backs: 3
    gates:
      intent:     { human_review: true, timeout_minutes: 20 }
      build-plan: { human_review: true, timeout_minutes: 20 }
      implement:  { human_review: false, auto_review: true,
                    auto_review_runner: .aidlc/validators/ci.mjs,
                    batches: true, timeout_minutes: 30 }
      verify:     { human_review: false, auto_review: true,
                    auto_review_runner: .aidlc/validators/verdict.mjs,
                    on_reject: { send_back_to: implement }, timeout_minutes: 20 }
      review:     { human_review: true, auto_review: true,
                    auto_review_runner: .aidlc/validators/verdict.mjs,
                    on_reject: { send_back_to: implement }, timeout_minutes: 20 }
```

There is no `spec`. If an epic needs one, start it on `ai-native-full` and add
`autopilot: true` to the epic's pipeline.

**Before the first run:**

1. Put your lint, typecheck and test commands in `CHECKS` in
   `.aidlc/validators/ci.mjs`. While the list is empty, the validator passes
   every build. An autopilot run refuses to start, and `aidlc doctor` warns.
2. Give the runner its permissions (`providers.default.args`, above).
3. Register the approval-gate hook ([ONBOARDING.md](ONBOARDING.md) §4).
4. Create a branch for the epic and commit or stash your own changes.

`aidlc doctor` checks 1–3 under **Unattended runs**.

**How a run goes.** Approve `intent` and `build-plan`, then
`aidlc run exec <epic>` (or **Run to completion**):

- `implement` works through the plan one batch per session. When it says
  `Status: done`, `ci.mjs` runs your checks. A failing check rejects
  `implement` and the run stops (exit 2), with the check's output in the
  reject reason. Fix it, or `aidlc run rerun` it.
- `verify` writes `Verdict: pass|fail`. A `fail` sends the work back to
  `implement` with the "Shortest path to …" list as feedback.
- `review` writes `Verdict: ship|hold`. A `hold` sends the work back to
  `implement` the same way. A `ship` stops the run at `awaiting_review`
  (exit 2) for you to read the branch and **Approve**.
- After three send-backs the run stops for you. It also stops when a
  send-back or a batch changes no code.

Once you trust the validators, set `review: { human_review: false }` in the
recipe. A `ship` then completes the run, and you only merge the PR.

## Optional `produces` entries

Output written only sometimes (a diagram rendered when there is something to
draw) is declared as `{ path, optional: true }`:

```yaml
steps:
  - agent: architect
    name: cr-intake
    produces:
      - docs/cr/{epic}/business.md
      - path: docs/cr/{epic}/diagrams/overview.html
        optional: true
```

The step lists it when it exists and marks it **optional · not produced** when
it does not. Mark-done requires only the plain entries, and an absent optional
file is left out of what the step recorded, so `produces_contains` and
`aidlc run verify` never look for it. A recipe that borrows the step keeps the
flag.

## `produces_contains` — gating on what is *in* the artifact

`produces` says which files must exist. `produces_contains` says what must be
inside them: every marker has to appear in at least one produced file, or
mark-done refuses the step.

```yaml
steps:
  - agent: architect
    name: cr-intake
    produces:
      - docs/cr/{epic}/kickoff.md
      - docs/cr/{epic}/comparison.md
    produces_contains:
      - '```mermaid'
      - sequenceDiagram
      - stateDiagram-v2
```

Markers are plain substrings — no regex, no per-file targeting — checked
against the concatenated contents of the produced files.

A skill can insist "draw two Mermaid diagrams" and an agent can still skip it;
prose in a prompt is not enforcement. Use `produces_contains` whenever a
required *section* matters more than the file's presence: a diagram, a decision
table, a `## Risks` heading. Keep markers short and stable — a fence, a heading
or a keyword, not a sentence from a template.

`aidlc run verify <runId>` re-checks the markers later, so an artifact edited
down after approval shows up as drift.

## Step `description`

The Epics panel shows a line under each step. Without a `description` it falls
back to the agent's, which cannot tell apart two steps on the same agent:

```yaml
steps:
  - agent: cr-dev
    name: cr-build-spec
    skills: [cr-build-spec]
    description: Write the build spec from the approved business analysis.
  - agent: cr-dev
    name: cr-build
    skills: [cr-build]
    description: Build against the approved spec.
```

The panel uses the first that exists:

1. The step's `description`.
2. The frontmatter `description` of the step's skill, when `skills:` names
   exactly one (looked up at the declared path, then
   `.claude/commands/<id>.md`, then `.claude/skills/`).
3. The agent's description.

It is display text only and never reaches the prompt.

## `default_skill` — one step, interchangeable skills

A step's `skills:` normally means *all of these*. When two skills are
alternative ways to do the same step, `default_skill` turns the list into *one
of these*:

```yaml
steps:
  - agent: cr-reviewer
    name: cr-review
    skills: [cr-review, cr-review-ocr]
    default_skill: cr-review
```

- The epic card shows a **Skill** picker, preselected with the default. **Run
  with Claude**, **Update with feedback** and **Rerun with Claude** launch the
  picked skill's command (`/<skill-id> <epic>`), so each alternative needs its
  own command file.
- The pick is remembered on the step; **Run to completion** and
  `aidlc run exec` use it, and `aidlc run exec --skill <id>` overrides it.
- Each approve / reject records which skill produced the revision, so two
  skills can be compared in `aidlc run report`.
- `default_skill` must be one of the step's `skills`, and both alternatives
  must satisfy the same `produces` and `produces_contains`.

## An epic owns its pipeline

Starting an epic assembles a pipeline from the recipe and stores it beside the
epic:

    docs/epics/EPIC-001/
      pipeline.yaml     ← the epic's own pipeline
      state.json        ← names it ("pipeline": "EPIC-001")
      artifacts/

`.aidlc/workspace.yaml` keeps only team-wide agents, skills, recipes and base
pipelines, so concurrent epics never append to the same place. The epic's
pipeline is spliced into `pipelines:` when the workspace is read, so the CLI,
the sidebar and the runner still find it. Commit `pipeline.yaml` with the epic.

Workspaces that predate this keep epic pipelines inline until moved:

```bash
aidlc epic pipeline extract --dry-run   # list what would move
aidlc epic pipeline extract             # move it, in its own commit
```

Only a pipeline an epic both names in `state.json` *and* owns by name
(`EPIC-001`, `EPIC-001-native-lite`) is moved. `aidlc doctor` lists what is
left.

## Epic ids — `epic_id_prefix`

Unset, new epics are suggested as `EPIC-001`, `EPIC-002`, …, which collides
as soon as two people work in one repo. Set two letters per checkout:

```yaml
epic_id_prefix: NG
```

The suggestion becomes `EPIC-260908-NG-001`: the local date the epic was
opened (`yymmdd`), the prefix, then a counter that restarts each day. Date
first means sorting `docs/epics/` by name gives the team one timeline. Set it
from the sidebar's **Epic ID prefix** box or by hand; from a terminal,
`aidlc epic next-id` prints the next suggestion.

## Epic depth — `strict_mode`

A recipe decides *which steps* run; `strict_mode` decides *how far each one
goes*. It is set per epic (`"strict_mode": false` in its `state.json`):

```bash
aidlc epic start EPIC-003 --recipe native-lite --no-strict
aidlc epic strict EPIC-003            # show it
aidlc epic strict EPIC-003 off        # change it on a running epic
```

In the extension it is **Keep it proportional** in the Start epic modal and the
**Full depth / Proportional** chip on the epic card. It applies from the next
phase run; nothing already written changes.

Under `strict_mode: false` a phase covers what the change needs and stops. It
still keeps every template heading — the auto-reviewer and the traceability
validator match on them — and gives a heading that does not apply one honest
line instead of invented content. Absent means `true`.
