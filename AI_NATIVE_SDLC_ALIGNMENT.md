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
| `packages/core/src/runs/EpicScaffold.ts` | Creates the epic tree and seeds artifacts | ✅ For intent.md + loop closure (W3) |
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
| 6. Maintain | `maintain` | `native-operator` | `incident.md` | 🆕 W3 |

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

- [ ] W3.1 Add `maintain` to `CANONICAL_PHASES` (artifact `incident.md`)
- [ ] W3.2 `PhaseDef` for `maintain`: persona `native-operator`, must run non-interactively
- [ ] W3.3 Write `agents/native-operator.md` and `skills/native-maintain.md` — take a signal, write the diagnosis
- [ ] W3.4 **Engine:** teach `EpicScaffold.ts` to accept `intent.md` as the input to the `plan`/`spec` phase
- [ ] W3.5 **Engine:** have `maintain` emit the `intent.md` of a *new* epic, closing the loop
- [ ] W3.6 Investigate reusing `otelReceiver.ts` / `observeClient.ts` for production signals (Q3)
- [ ] W3.7 Test the loop: maintain → intent.md → the next epic's spec phase reads it

**Acceptance:** running `maintain` against a simulated signal produces a new epic
with a valid `intent.md`, and the next phase on that epic can read it.

---

### W4 — Rebrand and publish *(optional — only if we decide to ship)*

- [ ] W4.1 Change `publisher` in `packages/extension/package.json` (currently `hueanmy`)
- [ ] W4.2 Change the `aidlc.*` command namespace (29 commands) — breaking, needs a migration note
- [ ] W4.3 Fix `repository.url` in the root `package.json` (still points at `aidlc-io/aidlc`)
- [ ] W4.4 LICENSE: **keep** the MIT text and the original copyright line, add ours
- [ ] W4.5 README and CHANGELOG for our build
- [ ] W4.6 Run the `/publish` skill

---

## 5. Open questions

| # | Question | Impact | Status |
|---|---|---|---|
| Q1 | Playbook artifact names or existing repo names? | Every template | ✅ **Locked: playbook names** (§W0) |
| Q2 | `@claude` in the PR loop: GitHub Action, MCP server, or local CLI only? | W2.5 | ✅ **Locked: local CLI (c)** — see §W2 decisions |
| Q3 | Where do production signals come from (existing OTel, Sentry, manual webhook)? | Blocks W3.6 | ⬜ Open |
| Q4 | Replace the existing workflow or run alongside it? | W1.7 and `preset.ts:80` | ✅ **Locked: alongside, third workflow** |
| Q5 | Do we drop the VS Code extension for a CLI/CI-first tool? | Would invert the whole plan | ⬜ Open |

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
to W2 and W3. `native-reviewer` shipped in W2 (below); `native-operator` is still W3.

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
