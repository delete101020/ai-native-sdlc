# AI-Native SDLC Alignment — plan & tracking

**Branch:** `feat/ai-native-sdlc-alignment`
**Reference:** https://claude.com/blog/the-ai-native-sdlc-playbook
**Status:** 🟢 W1 complete — W2 next
**Updated:** 2026-08-31

---

## 1. Goal

Ship our own SDLC pipeline that follows the six stages of the AI-Native SDLC
Playbook, **by extending this codebase** rather than rewriting it.

Decision: **build on this fork**, because:

- The repo is already our own fork (`origin` = `delete101020/ai-native-sdlc`) under
  MIT, so modifying and rebranding is unencumbered.
- The pipeline is **data-driven**: `.aidlc/workspace.yaml` (Zod schema in
  `packages/core/src/schema/WorkspaceSchema.ts`) declares agents, skills, phases and
  the DAG; `packages/core/src/runner/DefaultRunner.ts` only spawns
  `claude --print --append-system-prompt <skill.md>`. Most of the work is therefore
  **markdown plus a preset registration**, not engine surgery.
- Roughly 34k of the 40k TypeScript LOC is VS Code extension plumbing (webviews,
  wizards, token reporting, monitor panel). Rewriting means paying for 34k LOC that
  carries none of our differentiation.

The one thing that would flip this decision: dropping the VS Code extension entirely
in favour of a CLI/CI-first tool. Even then the cheapest path is to fork and delete
`packages/extension`.

---

## 2. Gap analysis — playbook vs. current codebase

Current built-in pipeline (`packages/core/src/presets/builtinWorkflows.ts:104-172`):

```
plan → prototype → design ∥ test-plan → implement(+unit-test) → generate-test-cases → execute-test
```

| Playbook stage | Playbook artifact | Current state | Verdict |
|---|---|---|---|
| 1. Plan | `intent.md` | Starts directly at `PRD.md`; no intent artifact | ⚠️ Missing the root artifact |
| 2. Design | `spec.md` | `design` + `tech-design.md` + `prototype` | ✅ Exceeds the playbook |
| 3. Build | `plan.md`, diffs | `implement` + `unit-test` | ✅ Adequate |
| 4. Test | evals, verifier subagent | `test-plan`, `generate-test-cases`, `execute-test` | ✅ Exceeds the playbook |
| 5. Deploy | PR review, `@claude`, hooks as gates, CI/CD | Exists only as checklist items inside `design.md` / `prd.md` | ❌ **No phase at all** |
| 6. Maintain | monitoring → diagnosis → `intent.md` → loop | `aidlcMonitor` / `otelReceiver` / `observeClient` monitor **agents and tokens**, not production | ❌ **Loop never closes** |

**Assets this repo has that the playbook does not** (the reason not to rewrite):
the `prototype` phase, `discovery-gate`, the traceability validator, the budget
guard, per-epic token cost attribution, the ast-graph MCP server, and seven
task-type recipes.

---

## 3. Architecture — touch points to know before editing

| File | Role | Needs changes? |
|---|---|---|
| `packages/core/src/presets/builtinWorkflows.ts` | `PhaseDef[]`, `RecipeDef[]`, `BUILTIN_WORKFLOWS` | ✅ Add the new workflow |
| `packages/core/src/presets/commandModel.ts` | `CANONICAL_PHASES` — the shared `/plan`, `/design`, … shortcut layer | ✅ Register new phases |
| `packages/core/templates/<dir>/{agents,skills,artifacts}/` | Markdown source for a preset | ✅ New tree |
| `packages/core/src/schema/WorkspaceSchema.ts` | `workspace.yaml` schema, `dependsOn` DAG | ⬜ Already sufficient |
| `packages/core/src/runner/DefaultRunner.ts` | Spawns the `claude` CLI | ⬜ No change |
| `packages/core/src/runs/EpicScaffold.ts` | Creates the epic tree and seeds artifacts | ✅ Done in W3 — `seedArtifacts` |
| `packages/core/src/presets/globalDefaults.ts` | Installs a preset into `~/.claude` | ✅ Verify the new workflow is listed |
| `.claude/commands/*.md` | Slash commands generated from `CANONICAL_PHASES` | ✅ Regenerate |
| `packages/cli/src/commands/preset.ts` | CLI preset command | ⚠️ Line 80 hard-codes `BUILTIN_WORKFLOWS[0]` |

**Important:** adding a phase is **not** just adding a `PhaseDef`. It must also be
added to `CANONICAL_PHASES` (`commandModel.ts:57`) for the shortcut slash command to
exist, and `.claude/commands/` must be regenerated.

---

## 4. Workstreams

Order: W0 → W1 → W2 → W3 → W4. W4 is optional.

### W0 — Locked design decisions

| # | Decision | Date |
|---|---|---|
| Q1 | **Artifact names follow the playbook.** `intent.md`, `spec.md`, `plan.md`. Phases the playbook does not name an artifact for use the same lowercase style: `implement.md`, `verify.md`, `review.md`, `incident.md`. | 2026-08-31 |
| Q4 | **The new workflow runs alongside the existing ones** as a third workflow; it replaces neither `aidlc-workflow` nor `speckit-pipeline`. | 2026-08-31 |

**New workflow identity:**

| Property | Value |
|---|---|
| `id` | `ai-native-pipeline` (→ `workflowSlug()` = `ai-native`) |
| `pipelineId` | `ai-native-full` |
| `templatesDir` | `ainative` |
| Display name | AI-Native SDLC |

**Phase map — six playbook stages → phase ids:**

| Playbook stage | Phase id | Persona | Artifact | Canonical phase |
|---|---|---|---|---|
| 1. Plan | `intent` | `native-originator` | `intent.md` | 🆕 new |
| 2. Design | `spec` | `native-product-owner` | `spec.md` | 🆕 new |
| 3. Build (plan mode) | `build-plan` | `native-engineer` | `plan.md` | 🆕 new |
| 3. Build (code) | `implement` | `native-engineer` | `implement.md` | ♻️ reused |
| 4. Test | `verify` | `native-verifier` | `verify.md` | 🆕 new |
| 5. Deploy | `review` | `native-reviewer` | `review.md` | 🆕 new |
| 6. Maintain | `maintain` | `native-operator` | `incident.md` | 🆕 new |

**Why phase ids do not map 1:1 onto the playbook's names:** `plan` is already taken
by `aidlc-workflow`, where it means "scaffold the epic and write the PRD". The
playbook's stage-3 `plan.md` is an *implementation plan* — a different thing. Since
the static description on the `/plan` shortcut is shared across every pipeline
(`CANONICAL_PHASES`), reusing the id would make that description wrong for one of
them. Hence `build-plan` as the id, **with `plan.md` still as the artifact** per Q1.

**⚠️ Flat namespace constraint** (found while reading `globalDefaults.ts:130`):
every `agents/<file>.md` and `skills/<file>.md` from *all* workflows installs to
`~/.claude/{agents,skills}/aidlc-<file>.md` — **one shared flat namespace**.
Evidence: speckit had to name its file `speckit-implement.md` to avoid clobbering
`sdlc/skills/implement.md`.
→ **Every agent and skill file in the new workflow carries the `native-` prefix**,
so it installs as `aidlc-native-<name>.md`. Artifact templates live under the
workflow's own directory and cannot collide.

---

### W1 — Own preset, stages 1–4 (no engine changes) ✅ **Done**

> Goal: a workflow that runs end to end for stages 1–4, with playbook artifact names.
> Estimate: ~1 day. Markdown plus preset registration only; no runner or schema logic.
> Stage 5 (`review`) and stage 6 (`maintain`) are split into W2/W3 to keep reviews small.

- [x] W1.0 Lock Q1 and Q4, write the phase map (§W0)
- [x] W1.1 Create `packages/core/templates/ainative/{agents,skills,artifacts}/`
- [x] W1.2 Write four personas: `agents/native-{originator,product-owner,engineer,verifier}.md`
- [x] W1.3 Write five skills: `skills/native-{intent,spec,build-plan,implement,verify}.md`
- [x] W1.4 Write five artifact templates: `artifacts/{intent,spec,build-plan,implement,verify}.md`
- [x] W1.5 Add four canonical phases (`intent`, `spec`, `build-plan`, `verify`) to `CANONICAL_PHASES` (`commandModel.ts:57`)
- [x] W1.6 Add `AINATIVE_PHASES: PhaseDef[]` and `AINATIVE_RECIPES` to `builtinWorkflows.ts`
- [x] W1.7 Register the third entry in `BUILTIN_WORKFLOWS` (`builtinWorkflows.ts:405`)
- [x] W1.8 Fix `packages/cli/src/commands/preset.ts:80` — currently hard-codes `BUILTIN_WORKFLOWS[0]`
- [x] W1.9 Regenerate `.claude/commands/`; verify `/aidlc <epic> [phase]` dispatches to the right pipeline
- [x] W1.10 Tests: `pnpm --filter @aidlc/core test` green; add third-workflow cases to `test/command-model.test.ts`

**Planned recipes:**

| id | steps |
|---|---|
| `native-quick` | `intent → build-plan → implement → verify` |
| `native-full` | `intent → spec → build-plan → implement → verify` |
| `native-spike` | `intent` |

**Acceptance:** a sample epic runs from `intent` through `verify` on the new
workflow, and neither `aidlc-workflow` nor `speckit-pipeline` regresses.

---

### W2 — Stage 5: Deploy / Review phase

> Goal: make PR review and approval gates a real phase instead of a checklist inside `design.md`.

- [x] W2.1 Add `review` to `CANONICAL_PHASES` (artifact `review.md`)
- [x] W2.2 `PhaseDef` for `review`: persona `native-reviewer`, `dependsOn: ['verify']`, `humanReview: true`
- [x] W2.3 Write `agents/native-reviewer.md` and `skills/native-review.md` — read the diff/PR, check against the policies in CLAUDE.md and the loaded skills
- [x] W2.4 Hooks as approval gates: add a sample hook under `.claude/hooks/` that blocks out-of-policy actions
- [x] W2.5 Declare `capabilities: ['github']` on the `review` phase (declarative permission only — inert until an MCP server is configured)
- [ ] ~~W2.5b Wire `@claude` into the PR loop via a GitHub Action~~ — **deferred**, see §W2 decisions
- [x] W2.6 Update recipes so the full recipe inserts `review` after `verify`
- [x] W2.7 Tests, plus `.github/workflows/ci.yml` if review is to run in CI

**Acceptance:** `/review <epic>` produces `review.md` with findings traced to policy,
and the hook demonstrably blocks at least one violating action. — **met.**

#### W2 decisions (Q2, locked 2026-08-31)

**Chosen: (c) local CLI.** The `review` phase reads the diff locally, checks it
against the policies in `CLAUDE.md` and the loaded skills, and writes `review.md`.
No CI credentials, no GitHub remote required, runs offline.

This is not merely the cheapest option — it is the mandatory core. `review.md` is the
artifact the pipeline gates on, exactly like every other phase's artifact, so the
phase has to work without any external integration. Options (a) and (b) are ways to
*surface* a review that this phase produces regardless.

Context: our projects have no AI in the review step today, so there is nothing for a
PR-loop integration to plug into yet.

**(b) MCP server — pre-staged, effectively free.** `capabilities` in workspace.yaml
are *declarative permissions*, not runtime wiring: declaring `github` on the review
phase says "this agent may read GitHub" and does nothing until the user configures a
github MCP server. One array entry, inert by default, ready when wanted.

**(a) GitHub Action — deliberately NOT pre-staged.** The YAML is the easy half and
the half that rots; the hard half cannot be pre-staged in the repo at all:

| Needed | Can it be prepared ahead? |
|---|---|
| Workflow file responding to `@claude` on PR comments | Yes — and it can ship disabled, gated on a repo variable |
| `ANTHROPIC_API_KEY` repo secret | No — account-level |
| Billing for per-PR agent runs | No — account-level |
| GitHub app permissions / branch protection | No — repo settings |

A committed workflow that reacts to PR comments is also a security surface: anyone
who can comment on a PR can trigger a job holding repo write access. It must ship
gated off, and turning it on is a deliberate act — which is precisely the moment to
write it, against the action's then-current inputs.

**Decision:** record what (a) requires (this table), implement it when a project
actually needs AI in its PR review step. Not blocked on anything — it is additive
to the phase built in W2.1-W2.4.

---

### W3 — Stage 6: Maintain, and closing the loop

> Goal: production signal → diagnosis → a new `intent.md` → back to stage 1.
> This is the only workstream that genuinely changes the engine, and the change is small.

- [x] W3.1 Add `maintain` to `CANONICAL_PHASES` (artifact `incident.md`)
- [x] W3.2 `PhaseDef` for `maintain`: persona `native-operator`, must run non-interactively
- [x] W3.3 Write `agents/native-operator.md` and `skills/native-maintain.md` — take a signal, write the diagnosis
- [x] W3.4 **Engine:** teach `EpicScaffold.ts` to accept `intent.md` as the input to the `plan`/`spec` phase
- [x] W3.5 **Engine:** have `maintain` emit the `intent.md` of a *new* epic, closing the loop
- [x] W3.6 Investigate reusing `otelReceiver.ts` / `observeClient.ts` for production signals (Q3) — **answered: no**, see §W3 decisions
- [x] W3.7 Test the loop: maintain → intent.md → the next epic's spec phase reads it
- [x] W3.8 **Front door:** `aidlc maintain --signal <file>` + `aidlc maintain follow-up <epic>` — added after the Q5 lock, which put the CLI entry point ahead of any button (§11)

**Acceptance:** running `maintain` against a simulated signal produces a new epic
with a valid `intent.md`, and the next phase on that epic can read it — **met**
(`test/maintain-loop.test.ts`, "the loop closes").

#### W3 decisions (Q3, locked 2026-08-31)

**Chosen: (c) signal file / webhook.** `maintain` takes a plain JSON signal that
anything can produce — an alert forwarder, a log line, or a human pasting one in —
and writes `incident.md`. No credentials, no vendor, runs offline.

Same reasoning as Q2: `incident.md` is the artifact the pipeline gates on, so the
phase has to work with no integration configured at all. Options (a) and (b) are
ways to *feed* a phase that must stand on its own either way.

**The signal schema is the actual deliverable.** Define the minimum shape once and
every later source becomes an adapter that fills it, not a change to the phase:

| Field | Meaning |
|---|---|
| `source` | Where it came from (`manual`, `sentry`, `otel`, `pager`) |
| `observedAt` | When it was seen, ISO-8601 |
| `symptom` | What is wrong, in one line, as observed — not as diagnosed |
| `scope` | Who / what is affected, and how much |
| `evidence` | Stack trace, log excerpt, metric window, request id |

**(a) OTel / existing observability — deliberately NOT reused.** W3.6 asked whether
`otelReceiver.ts` (231 lines) or `observeClient.ts` (88 lines) could supply the
signal. They cannot, and it is worth recording why:

| Module | What it actually measures |
|---|---|
| `otelReceiver.ts` | OTLP from **Claude Code itself** — tokens, cost, lines added/removed, commits |
| `observeClient.ts` | agents-observe — session and event counts for **Claude Code** |

Both measure *agent activity*, not the health of the user's system. They know how
many tokens were burned; they do not know that `/checkout` is returning 500s. The
HTTP receiver plumbing is reusable in principle, but none of the data semantics
are. Wiring real OTel means defining which metrics matter and what threshold is
worth opening an epic over — a separate piece of work, not a reuse.

**(b) Sentry — recorded, not built.** The best-shaped source for this phase: a
Sentry issue already *is* an incident with a stack trace, a frequency, and a blast
radius, mapping almost 1:1 onto `incident.md`. But unlike Q2's MCP capability it is
not free to pre-stage — it needs real credentials and a webhook endpoint, which puts
it in the same bucket as Q2's GitHub Action: record the requirement, build it when a
project actually needs it.

**What this does not block.** Q3 gates only W3.6. W3.1–W3.5 — the persona, skill,
artifact template, and the two engine changes (`EpicScaffold.ts` accepting
`intent.md`, `maintain` emitting a new epic) — depend on the signal *shape*, not on
its source, and can be built against the schema above.

---

### W4 — Rebrand and publish *(optional — only if we decide to ship)*

- [ ] W4.1 Change `publisher` in `packages/extension/package.json` (currently `hueanmy`)
- [ ] W4.2 Change the `aidlc.*` command namespace (29 commands) — breaking, needs a migration note
- [ ] W4.3 Fix `repository.url` in the root `package.json` (still points at `aidlc-io/aidlc`)
- [ ] W4.4 LICENSE: **keep** the MIT text and the original copyright line, add ours
- [ ] W4.5 README and CHANGELOG for our build
- [ ] W4.6 Run the `/publish` skill
- [ ] W4.7 Publish `@aidlc/core` + the CLI as their own artifact, not only the `.vsix` (Q5)

#### W4 decisions (Q5, locked 2026-08-31)

**Chosen: (c) keep both — core + CLI is the contract, the extension is a client.**

**The question as originally written no longer holds.** Q5 was drafted before W1,
when its impact line read *"would invert the whole plan"*. After W1–W3 that is
overstated: every line those three workstreams produced lives in
`packages/core` and `templates/`, and none of it imports `vscode`.

| What shipped in W1–W3 | Where | VS Code? |
|---|---|---|
| 6 personas, 6 skills, 7 artifact templates | `templates/ainative/` | no |
| `CANONICAL_PHASES`, `AINATIVE_PHASES`, recipes | `core/src/presets/` | no |
| `Signal.ts`, `IncidentLoop.ts`, `seedArtifacts` | `core/src/` | no |
| Approval gate | `.claude/hooks/aidlc-approval-gate.py` | no |
| Slash commands | `.claude/commands/` | no |

So Q5 decides the *front door*, not the engine. Whichever way it went, W1–W3
stood.

**Q2 and Q3 had already answered half of it.** Stage 5 runs on the local CLI
(Q2) and stage 6 takes a JSON file (Q3) — both phases were deliberately built to
run with no IDE present. The decision here mostly ratifies a shape the previous
two locks already chose.

**Why not (b), CLI-only.** The CLI already carries the full state machine
(`epic start`, `run done/approve/reject/retry`, `step ...`, `preset apply
ai-native`, which installs `~/.claude` on its own), so dropping the extension
would cost nothing structural. What it would cost is everything the extension is
*actually* made of: `packages/extension/src` is ~34k lines against core's ~9k and
the CLI's ~5.5k, and that difference is not pipeline code — it is the token/cost
monitor and OTel receiver, the ast-graph integration, the epic wizard, the
sidebar / workspace / monitor webviews, the standard picker and the tech-stack
detector. Deleting a working IDE surface to make a point about architecture is a
bad trade.

**Why not (a), extension-first.** It would make every future phase reachable only
by a human clicking, which contradicts what stage 6 is *for*: a signal arrives
unattended, and `maintain` was built with no human gate for exactly that reason.

**What (c) commits us to, concretely:**

1. Every new phase must be runnable from the CLI **before** it gets a button.
   This is the rule W2 and W3 already followed; it is now written down.
2. `@aidlc/core` is the API. The extension and the CLI are both callers, and
   neither may hold logic the other needs.
3. W4 publishes two artifacts, not one — hence W4.7. A `.vsix` alone would make
   the CI/unattended path unreachable for anyone who is not us.

**Known gap this exposed — closed 2026-08-31 (W3.8).** `openFollowUpEpic` and
`parseSignal` were exported from core with no caller outside the tests: W3 closed
the loop at the library layer, which is what its acceptance asked for, but neither
front door could trigger stage 6. Under (c) the CLI entry point came first, and
it now exists — `aidlc maintain --signal <file>` and `aidlc maintain follow-up
<epic>`. This is commitment 1 above being honoured on its first test: stage 6 is
runnable from a terminal, a cron job or a webhook forwarder, and has no button
anywhere. See §11.

---

## 5. Open questions

| # | Question | Impact | Status |
|---|---|---|---|
| Q1 | Playbook artifact names or existing repo names? | Every template | ✅ **Locked: playbook names** (§W0) |
| Q2 | `@claude` in the PR loop: GitHub Action, MCP server, or local CLI only? | W2.5 | ✅ **Locked: local CLI (c)** — see §W2 decisions |
| Q3 | Where do production signals come from (existing OTel, Sentry, manual webhook)? | W3.6 | ✅ **Locked: signal file / webhook (c)** — see §W3 decisions |
| Q4 | Replace the existing workflow or run alongside it? | W1.7 and `preset.ts:80` | ✅ **Locked: alongside, third workflow** |
| Q5 | Do we drop the VS Code extension for a CLI/CI-first tool? | W4, and the shape of every phase after it | ✅ **Locked: keep both, core + CLI is the contract (c)** — see §W4 decisions |

---

## 6. Risks

| Risk | Level | Mitigation |
|---|---|---|
| New phases break the two existing workflows | Medium | `CANONICAL_PHASES` is a union — a new phase only appears in pipelines that declare it. Regression-test all three. |
| ~~`preset.ts:80` hard-codes `BUILTIN_WORKFLOWS[0]`~~ | Low | ✅ Resolved in W1.8 — extracted `applyBuiltinWorkflow(id, doc)`, lookup by id |
| Drift from upstream `aidlc-io/aidlc` | Medium | Keep the new preset in its own directory and minimise edits to shared files, so upstream merges stay easy |
| Scope creep into W4 too early | Medium | W4 opens only once W1–W3 are done and the workflow has been used for real |
| Agent/skill filename collisions across workflows (flat `~/.claude` namespace) | **High** | Mandatory `native-` prefix, now enforced by a regression test in `test/ainative-workflow.test.ts` |

---

## 7. Progress log

| Date | Work | Notes |
|---|---|---|
| 2026-08-31 | Reviewed the playbook and the codebase; locked the "build on the fork" direction | Gap analysis in §2 |
| 2026-08-31 | Created branch `feat/ai-native-sdlc-alignment` and this document | No code yet |
| 2026-08-31 | Locked Q1 (playbook artifact names) and Q4 (parallel workflow); wrote the phase map; found the flat-namespace constraint | §W0 |
| 2026-08-31 | W1.1–W1.2: template tree plus four personas under `templates/ainative/agents/` | Prefix settled as `native-` so files install as `aidlc-native-*.md` |
| 2026-08-31 | W1 complete: `ainative` template tree (4 personas, 5 skills, 5 artifact templates), 4 canonical phases, third workflow registered, `preset.ts` id lookup, commands regenerated, 13 new tests | 243 core + 22 extension tests green |
| 2026-08-31 | Q2 locked: local CLI for the review phase; MCP capability pre-staged, GitHub Action deferred with its prerequisites recorded | §W2 decisions |
| 2026-08-31 | W2 complete: `review` phase (persona, skill, artifact template, canonical phase, recipe step), `aidlc-approval-gate.py` hook, `/review` command, 8 new tests | 251 core tests green; W2.5b still deferred |
| 2026-08-31 | Q3 locked: signal file / webhook, with the signal schema as the contract; W3.6 answered "no" — the existing OTel/observe modules measure Claude Code, not production | §W3 decisions. No code — W3.1–W3.5 unblocked |
| 2026-08-31 | W3 complete: `maintain` phase (persona, skill, artifact template, canonical phase, `native-incident` recipe), `Signal` schema, `IncidentLoop` (`openFollowUpEpic`), `seedArtifacts` in `EpicScaffold`, `/maintain` command, 18 new tests | 269 core + 22 extension tests green; the loop closes end to end |
| 2026-08-31 | Q5 locked: keep both surfaces, core + CLI is the contract; Q5's original "would invert the whole plan" impact re-scoped — W1–W3 contain no VS Code code. Added W4.7 (publish the CLI too) and recorded the missing `aidlc maintain --signal` entry point | §W4 decisions. No code |
| 2026-08-31 | W3.8: stage 6's front door — `aidlc maintain --signal` / `aidlc maintain follow-up`, with `openIncidentEpic` / `readEpicSignal` / `followUpIdFor` added to core. Closes the gap the Q5 lock recorded | `cli/src/commands/maintain.ts`, `core/src/maintain/IncidentLoop.ts`, `+6` tests (275/275) |

---

## 8. W1 delivery notes

**What shipped**

| Area | Files |
|---|---|
| Templates | `packages/core/templates/ainative/{agents,skills,artifacts}/` — 14 markdown files |
| Canonical phases | `commandModel.ts` — `intent`, `spec`, `build-plan`, `verify` |
| Workflow | `builtinWorkflows.ts` — `AINATIVE_PHASES`, `AINATIVE_RECIPES`, `ai-native-pipeline` |
| CLI | `preset.ts` — `applyBuiltinWorkflow(id, doc)` helper plus an `ai-native` preset |
| Commands | `.claude/commands/{intent,spec,build-plan,verify}.md` |
| Tests | `packages/core/test/ainative-workflow.test.ts` — 13 cases |

**Verification:** `pnpm -r compile` clean; `@aidlc/core` 243/243 pass; extension 22/22 pass.

**Side effect worth knowing:** regenerating `.claude/commands/` also created the
missing `prototype.md`. `prototype` has been a canonical phase since GH-77 but its
shortcut command file had never been written; the generator simply filled the gap.

**Not done in W1, by design:** stage 5 (`review`) and stage 6 (`maintain`) — deferred
to W2 and W3. `native-reviewer` shipped in W2 and `native-operator` in W3 (both below).

---

## 9. W2 delivery notes

**What shipped**

| Area | Files |
|---|---|
| Persona | `templates/ainative/agents/native-reviewer.md` |
| Skill | `templates/ainative/skills/native-review.md` |
| Artifact template | `templates/ainative/artifacts/review.md` |
| Canonical phase | `commandModel.ts` — `review` → `review.md` |
| Workflow | `builtinWorkflows.ts` — `review` phase (`dependsOn: ['verify']`, `humanReview`, `capabilities: ['github','files']`), appended to the `native-full` recipe |
| Approval gate | `.claude/hooks/aidlc-approval-gate.py` |
| Command | `.claude/commands/review.md` |
| Tests | `ainative-workflow.test.ts` — 8 new cases (2 phase wiring, 6 hook behavior) |

**Reviewer vs. Verifier.** They answer different questions, which is why they are
separate phases rather than one bigger one. The Verifier asks *does it do what the
spec said?* and re-derives its checks from `spec.md`. The Reviewer asks *is this how
we build things here, and is it safe to ship?* and derives its checks from written
policy — `CLAUDE.md`, the loaded skills, the active standard. A change can satisfy
every acceptance criterion and still hard-code a secret or swallow an error; nothing
in the spec forbids that, the policy does.

Every finding cites the policy line it breaks, or is explicitly labelled `opinion`.
That constraint is what keeps the phase from degenerating into taste, and it makes
the report's last section — **Policy amendments** — meaningful: a rule that keeps
being violated is a broken rule, and that observation is exactly what stage 6 (W3)
feeds back into `CLAUDE.md`.

**The approval gate is a hook, not prose.** A skill can be talked past by an agent
that has convinced itself; a `PreToolUse` hook cannot. `aidlc-approval-gate.py`
reads the hook payload on stdin and exits 2 to block, with the reason on stderr:

| Blocked | Why |
|---|---|
| `git push --force` to `main`/`master` | Protected branches are fast-forward only |
| `git add` of a credential-looking path (`.env`, `*.pem`, `id_rsa`, …) | Secrets never enter a commit |
| Hand-editing `docs/epics/*/state.json` | The runner is the single writer; state advances via "Mark step done" |

It **fails open** — malformed JSON, an unknown tool, or an unevaluable rule allows
the action. A gate that fails closed on its own bugs blocks real work, and would be
uninstalled within a day.

Registration lives in `.claude/settings.json`, which is gitignored, so each clone
opts in deliberately; the snippet is in the hook's own docstring. Because the hook is
therefore not exercised by simply having the file, the test suite runs it directly
against six payloads (three that must block, three that must not).

**Verification:** `pnpm -r compile` clean; `@aidlc/core` 251/251 pass (up from 243).

**Deferred, deliberately:** W2.5b, the `@claude` GitHub Action — see §W2 decisions.
No `ci.yml` change was needed: the hook tests run inside the existing
`pnpm --filter @aidlc/core test` step.

---

## 10. W3 delivery notes

**What shipped**

| Area | Files |
|---|---|
| Persona | `templates/ainative/agents/native-operator.md` |
| Skill | `templates/ainative/skills/native-maintain.md` |
| Artifact template | `templates/ainative/artifacts/maintain.md` → `incident.md` |
| Canonical phase | `commandModel.ts` — `maintain` → `incident.md` |
| Workflow | `builtinWorkflows.ts` — `maintain` phase (`dependsOn: ['review']`, **no human gate**) plus the `native-incident` recipe |
| Signal contract | `core/src/maintain/Signal.ts` — Zod schema, `parseSignal`, `isSignal` |
| Loop closure | `core/src/maintain/IncidentLoop.ts` — `followUpEpicId`, `renderIntentMarkdown`, `openFollowUpEpic` |
| Engine | `EpicScaffold.ts` — `seedArtifacts` |
| Command | `.claude/commands/maintain.md` |
| Tests | `maintain-loop.test.ts` (16 cases) + 2 in `ainative-workflow.test.ts` |

**The loop, concretely.** Stage 6 is the only stage whose output is another
stage's input rather than a deliverable. A signal arrives → the Operator writes
`incident.md` → when the fix is real work, `openFollowUpEpic` scaffolds a new epic
with `intent.md` **already written**, so the spec phase has something to read on
its first run. That last step is the whole of the engine change: `scaffoldEpic`
previously only ever laid down blank templates.

`seedArtifacts` is deliberately generic — a map of filename → content, written
after the templates so it wins — and rejects any key with a path separator or
`..`, so a seed can never escape `artifacts/`. Nothing in it knows about the
playbook; any caller that already has an artifact's content can use it.

**The only phase with no human gate.** A production signal arrives at 3am, so the
phase has to run with nobody present. The gate did not disappear — it moved to
stage 1 of the epic this phase opens, where the emitted `intent.md` is reviewed
like any other intent. The agent diagnoses and hands forward; it never repairs. A
hotfix decided unattended is precisely what stage 5 exists to prevent.

**Why `maintain` is not in the `native-full` recipe.** It is declared last in the
pipeline so the DAG stays a chain, but a feature epic that shipped is *done* —
appending an incident phase to it would end every epic with a report saying "no
signal yet". Stage 6 is entered on its own, via `native-incident`
(`steps: ['maintain']`); `PipelineAssembler` prunes the dangling `depends_on`.

**Two rules the emitted intent inherits from stage 1**, both enforced by
`renderIntentMarkdown` rather than left to the agent's discretion:

1. *No solution language.* However sure the Operator is about which line is at
   fault, that belongs in `incident.md`. An intent that names the fix has
   pre-decided the spec, and the next four stages become theatre.
2. *Never invent evidence.* Anything the caller did not supply is rendered as an
   explicit open question, not as a plausible sentence. A visible gap gets
   answered; a fabricated line gets believed.

**Epic ids read as the symptom** (`INC-CHECKOUT-RETURNS-500-FOR`), because the id
ends up in a branch name, a folder, and every later reference — `INC-7` tells a
reader nothing six weeks on. A recurrence gets a `-2` suffix rather than a
collision error: the same signal coming back is exactly when you want the two
epics side by side.

**Verification:** `pnpm -r compile` clean; `@aidlc/core` 269/269 (up from 251),
extension 22/22. The loop test asserts the full chain — new epic exists, its
`intent.md` is written rather than blank, the `spec` step's `requires` names that
exact file, the run starts at step 0 behind its human gate, and provenance
(`from_epic`, `signal_source`) is queryable from `inputs.json`.

**Not built, by decision:** the Sentry adapter (Q3(b)) and OTel wiring (Q3(a)) —
both are sources that fill the same five-field schema, and neither changes the
phase. See §W3 decisions.

---

## 11. W3.8 delivery notes — stage 6's front door

**What shipped**

| Area | Files |
|---|---|
| CLI command | `cli/src/commands/maintain.ts` — `maintain --signal`, `maintain follow-up` |
| Core API | `IncidentLoop.ts` — `openIncidentEpic`, `readEpicSignal`, `followUpIdFor`, `SIGNAL_FILE` |
| Skill | `native-maintain.md` step 7 now names the command instead of a core function |
| Docs | `cli/README.md` — a `maintain` section |
| Tests | 6 new cases in `maintain-loop.test.ts` (22 in the file, 275 in core) |

**Why the door is split in two.** `maintain --signal` registers; `maintain
follow-up` opens the work. It would have been one flag away to have the first
command do both, and that would have been wrong: whether a signal deserves five
stages is a diagnosis, made against the code by the Operator agent that runs
*between* the two calls. A front door that decided it from five JSON fields would
be guessing, and `IncidentLoop` already says in its own header that a rendering
function is a bad place to decide whether to page someone at 3am. So the CLI
registers, the agent judges, and the CLI is called again — by the agent itself,
which is why the command had to exist at all: an agent cannot call a TypeScript
export.

**The layering follows the Q5 lock literally.** Everything the command does that
touches disk went into `@aidlc/core` (`openIncidentEpic` is the mirror of
`openFollowUpEpic`); `maintain.ts` is flag parsing, pipeline resolution and
printing. That is why the six new tests live in core and the CLI package still
has no test harness — the logic worth testing is not in it.

**`signal.json` is a file, not a field in `inputs.json`.** The `native-maintain`
skill reads `docs/epics/<epic>/signal.json` when it is handed no path, so writing
it there is what lets an unattended agent find its own input. Keeping the payload
whole and re-parseable also keeps later sources comparable: a Sentry adapter fills
the same five fields, and the report stays diffable against a manual one.

**Ids: `INC-…` and `INC-…-FIX`.** The follow-up id is derived from the incident's
rather than re-slugged from the symptom, so the incident and the work it opened
sort adjacent in `aidlc epic list` — the only place these ids are ever read. The
pipeline is assembled *after* the id is derived, so the epic and its pipeline
carry the same name, matching what `aidlc epic start` produces.

**Errors assume nobody is watching.** A malformed signal prints every problem at
once plus the expected shape, because the caller is usually a forwarder and one
round-trip beats five. A `follow-up` on an epic with no `signal.json` says so and
stops rather than inventing a signal — the same rule the persona is given.

**Verification:** `pnpm -r compile` clean; core 275/275, extension 22/22. Smoke-run
end to end against a scratch workspace (`aidlc init` → `preset apply ai-native` →
`maintain --signal` → `maintain follow-up`): the epics scaffold, `signal.json`
round-trips through `parseSignal`, the follow-up's `intent.md` is written with the
supplied prose and the rest as open questions, a recurrence gets `-2` rather than
a collision, and `aidlc validate` passes on the workspace afterwards.

**Not built, by decision:** no `--open-follow-up` shortcut on `maintain` (it would
pre-empt the diagnosis), and no extension command — under (c) the button is
optional and comes second, if at all.
