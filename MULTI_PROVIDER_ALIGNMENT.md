# Multi-Provider Support — plan & tracking

**Branch:** `feat/ai-native-sdlc-alignment` (a `feat/multi-provider` branch splits off at P1)
**Sibling doc:** `AI_NATIVE_SDLC_ALIGNMENT.md` — same format, same gating discipline
**Status:** 🟢 P0 locked · P1a shipped (G2, G3, parity check) — P1 (Codex runner) is the next build, on go-ahead
**Updated:** 2026-09-02

---

## 1. Goal

Let an AIDLC phase run on a model that is not Claude — **Codex (OpenAI) and
Gemini**, and anything else shipping a comparable agentic CLI — **without forking
the pipeline**. Gates, artifact contracts (`produces` / `requires`),
`auto_review_runner`, and the budget guard must behave identically no matter who
generated the text.

API-only providers (DeepSeek, and calling OpenAI/Gemini as bare endpoints) were in
this plan's first draft and are now **shelved** — see §1a and P2.

Local models (Ollama, vLLM, LM Studio) are **explicitly out of scope for now**.
They are deferred, not rejected: the provider SPI designed here is the same seam
they would land on later, so nothing in this plan needs to be undone to add them.
See §7.

Decision: **extend the existing runner plug-in point**, not add a second engine.
`workspace.yaml` already carries `runner: custom` + `runner_path` per agent, and
`RunnerRegistry` already loads and caches user modules. The pipeline does not
need to learn what a provider is — it only needs runners that behave.

The one thing that would flip this decision: if the §4c parity gaps turn out not to
be closable for a second CLI — if Codex cannot be given the ast-graph server, say —
then multi-provider is not achievable under §1a at all, and the honest outcome is to
stop, keep AIDLC Claude-only, and bank P1a as an improvement to the Claude path.

---

## 1a. Acceptance rule — what we are allowed to build

**Owner's rule, locked 2026-09-02:** if something can be implemented but cannot be
guaranteed not to degrade output quality, it is shelved. Only work that is
*certainly* quality-neutral gets built.

This is not a rule about models. Swapping Claude for Codex obviously changes the
output — that is the entire point, and it is the user's decision to make at
configuration time. The rule is about **the harness**: AIDLC must hand every
provider the same capabilities it hands Claude. Where the harness itself removes a
capability, the resulting quality drop is ours, not the model's, and that is what
is forbidden.

So every item in this plan is sorted into one of two buckets:

- **Neutral by construction** — the runner gives the model the same tools, the same
  context and the same instructions Claude gets. Any quality difference is then
  purely the model's, measurable and reversible by changing one line of
  `workspace.yaml`. → **Build it.**
- **Structurally degrading** — the runner cannot supply something Claude has, so the
  phase runs blind. → **Shelve it**, however easy it looks.

The rule is stricter than it first appears: applied honestly it removes shape B
entirely (§4), *and* it blocks shape A until the three parity gaps in §4c are
closed.

---

## 2. Gap analysis — what already works vs. what blocks

Measured against the tree at `22442ae`.

| Capability | Current state | Verdict |
|---|---|---|
| Per-agent runner override | `AgentSchema.runner: 'default' \| 'custom'` + `runner_path`, with a `refine` enforcing the pair (`WorkspaceSchema.ts:62-85`) | ✅ Sufficient |
| Loading a user runner | `CustomRunnerLoader` accepts `.js` / `.cjs` / `.mjs`, three export shapes, busts require cache | ✅ Sufficient |
| Runner contract | `AidlcRunner.run(ctx) => RunnerResult` — `ctx` carries `skill`, `env`, `args`, `workspaceRoot`, `onOutput`, `onError` | ✅ Sufficient |
| Headless execution | `execEngine.ts:293` resolves the runner per step; `cli/src/commands/agent.ts:199` for one-shot | ✅ Already provider-neutral |
| API keys / secrets | `EnvResolver` expands `${env:VAR}` in `workspace.environment` and `agent.env`, layered agent-over-workspace (`EnvResolver.ts:46-75`) | ✅ Works today, no change |
| Cost accounting | `RunnerResult.costUsd` optional; missing is summed as 0 (`execEngine.ts:315-317`) | ⚠️ Non-Claude runs are free-of-charge on paper |
| Model selection | `agent.model` is **informational only** — `DefaultRunner` never passes `--model` (`presets/models.ts:19-21`) | ⚠️ Field is unused; repurpose, don't invent a new one |
| Who writes the artifact | Nobody in the engine. The **agent** writes `docs/epics/$0/artifacts/*.md` with its own tools; the runner only streams stdout | ❌ A plain chat API produces prose that never reaches disk |
| Interactive VS Code path | `workspaceCommands.ts:367` builds `claude '<slash>'` and sends it to a terminal — **bypasses `RunnerRegistry` entirely** | ❌ Biggest gap; a custom runner has no effect here |
| `ctx.claude` wrapper | Typed as `ClaudeCliWrapper`, always passed `null` (`execEngine.ts:301`) | ⚠️ Vendor name baked into a public type |
| Runner isolation | Custom runners are `require()`d into the host process, unsandboxed by design (`CustomRunnerLoader.ts:9-12`) | ⚠️ Acceptable for local files; a shipped provider pack raises the stakes |
| TypeScript runners | Rejected — v1.1 item per the loader's own error message | ⚠️ Our provider runners must ship as compiled JS |

**Assets that make this cheap:** the pipeline never mentions Claude. Gate
evaluation, `produces` validation, `depends_on` DAG, run state, and the budget
ceiling all operate on `RunnerResult`, not on a vendor.

---

## 3. Architecture — touch points to know before editing

| File | Role | Needs changes? |
|---|---|---|
| `packages/core/src/runner/types.ts` | `RunnerContext`, `RunnerResult`, `AidlcRunner` | ⚠️ Generalize `ClaudeCliWrapper`; add cost/usage fields |
| `packages/core/src/runner/RunnerRegistry.ts` | Maps `runner` → implementation; only `default` is registered | ✅ Register the new builtin provider runners |
| `packages/core/src/schema/WorkspaceSchema.ts` | `runner` is a closed `z.enum(['default','custom'])` | ✅ Must widen to admit provider ids |
| `packages/core/src/runner/DefaultRunner.ts` | Spawns `claude --print --output-format stream-json` | ⬜ No change — it becomes one provider among several |
| `packages/core/src/runs/execEngine.ts` | Builds `ctx`, records `costUsd`, validates `produces` | ⚠️ Small: pass `agent.model`, richer cost |
| `packages/core/src/presets/models.ts` | `PLANNING_MODEL` / `CODING_MODEL` / `FAST_MODEL` as Claude aliases | ✅ Becomes a per-provider tier map |
| `packages/extension/src/v2/workspaceCommands.ts:367` | `claude '<slash>'` into a terminal — the interactive path | ✅ P4, the hard one |
| `packages/extension/src/v2/requirementWizard.ts:292` | Same terminal pattern | ✅ P4 |
| `packages/cli/src/commands/agent.ts:199` | One-shot agent run | ⬜ Already routes through the registry |
| `packages/cli/src/commands/doctor.ts` | Environment diagnosis | ✅ Must probe configured providers, not just `claude` |
| `packages/*/templates/*/skills/*.md` | 47 `.claude/…` path references, 25 `argument-hint` | ⚠️ See R2 |

**Important:** widening `runner` in the Zod enum is the load-bearing change. Every
workspace already on disk says `runner: default`, so the widening must be additive
and `default` must keep meaning *Claude via the CLI*. Renaming it to `claude`
would invalidate every existing `workspace.yaml`.

---

## 4. Provider taxonomy — the decision that shapes everything

Providers do not differ by vendor. They differ by **whether the thing we invoke
can touch the filesystem**. Two shapes, and the cost gap between them is large.

**Shape A — agentic CLI.** The vendor ships a binary with a tool loop that reads
and writes files: `claude`, `codex exec`, the Gemini CLI. The runner spawns it,
streams stdout, and the CLI writes `spec.md` itself. This is exactly what
`DefaultRunner` already does; a new provider is ~100 LOC of argument shaping plus
output parsing. **Every phase works, including `implement` and `review`.**

**Shape B — chat API.** DeepSeek, and any OpenAI-compatible endpoint. No tools,
no filesystem. The runner must assemble the prompt (skill + the artifacts named by
`requires`), call the API, and **write the produced artifact itself** before
returning. Works for the text→text phases — `intent`, `spec`, `build-plan`, most of
`verify`. Does **not** work for `implement` / `review` without building a tool loop,
which is a separate, much larger project.

Consequence for the plan: **P1 ships shape A, P2 ships shape B**, and shape B is
documented as phase-limited rather than quietly producing broken runs.

| Provider | Shape | Notes |
|---|---|---|
| Claude | A | `DefaultRunner`, already shipped |
| Codex (OpenAI) | A | `codex exec` is non-interactive and writes files |
| Gemini | A | Gemini CLI; confirm non-interactive flag + streaming format at P1 |
| DeepSeek | B | OpenAI-compatible API; no first-party agentic CLI — 🚫 shelved (P2) |
| OpenAI API direct | B | Same shape as DeepSeek — 🚫 shelved (P2) |
| Ollama / vLLM | B | 🚫 shelved with P2 (§7) |

---

## 4b. Per-step verdict — which phases can leave Claude

`runner` is per-agent and every phase maps 1:1 to an agent, so each step is
switched independently. But the phases are not equally switchable, and the line
does not fall where "hard phase / easy phase" would put it. It falls on **whether
the step has to touch a shell**.

Measured against `AINATIVE_PHASES` (`builtinWorkflows.ts:430-513`) and the skill
bodies in `packages/extension/templates/ainative/skills/`.

| # | Step | Reads | Writes | Shape B (chat API) |
|---|---|---|---|---|
| 1 | `intent` | `docs/epics/$0/$0.md` — one file | `intent.md` | ✅ Yes, nothing lost |
| 2 | `spec` | `intent.md`, `CLAUDE.md`, project skills, + ast-graph | `spec.md` | ⚠️ Yes, **loses ast-graph** |
| 3 | `build-plan` | `spec.md`, `CLAUDE.md`, the codebase via ast-graph | `plan.md` | ⚠️ Yes, ast-graph loss hurts more |
| 4 | `implement` | `plan.md`, `spec.md` | **branch + code + tests + PR**, `implement.md` | ❌ No |
| 5 | `verify` | `spec.md`, `plan.md`, **checks out the branch and runs tests / build / the app** | `verify.md` | ❌ No |
| 6 | `review` | `git diff <base>...HEAD`, `CLAUDE.md`, `spec.md`, `verify.md`, ast-graph | `review.md` | ⚠️ Yes if the runner pipes the diff in |
| 7 | `maintain` | a signal, `git log`, ast-graph | `incident.md` + the next epic's `intent.md` | ⚠️ Technically yes — see the warning below |

**The boundary sits between steps 3 and 4.** Steps 1–3 and 6–7 only read and only
emit Markdown; they are text→text and shape B can serve them. Steps 4–5 must
*execute*: `native-implement.md` creates a branch, edits code, runs tests and opens
a PR, and `native-verify.md` is explicit — *"Check out the branch. Run the checks
yourself — tests, build, the app, the endpoint. Capture real output."* A chat API
cannot do that, and forced to try it will **fabricate** test output. That is risk
R1 arriving through the front door.

**`review` is read-only on purpose.** Its skill says *"Do not re-run verification;
it is a different phase."* So despite being a checking phase it groups with 1–3,
not with `verify`. This is the non-obvious classification in the table and the one
most likely to be got wrong by inspection.

### What shape B gives up

**ast-graph disappears.** It is an MCP server; a plain chat endpoint cannot call
it. Steps 2, 3, 6 and 7 all reach for `blast-radius`. On `spec` the loss is
tolerable. On `build-plan` it is not: `plan.md` must name files and ordering, and
without the graph the model guesses. This is why step 3 is riskier than step 2
even though both are marked "yes".

**Context inflates.** Shape B must inline everything shape A reads for itself. For
`review` a real epic's `git diff` can exceed the window — the skill already
anticipates this (*"If the diff is too large to read in one pass, review it file by
file"*), but shape A can honour that by reading file by file where shape B has to
push the whole thing into one request.

### What makes the swap survivable

Six of seven phases carry `humanReview: true`. A weaker model on `spec` is caught
at the gate rather than propagating downstream.

**The exception is `maintain` — `humanReview: false`.** The code comment explains
why: a signal arrives unattended, so the phase runs unattended. That makes it the
only step whose output flows into the next epic with nobody reviewing it. Keep it
on Claude longest, notwithstanding that it is text→text and shape B would run it.

### Recommended configuration

```
intent, spec, build-plan   → switch freely (shape A or B)
review                     → switchable; prefer shape A (diff size)
implement, verify          → shape A only, never shape B
maintain                   → stay on Claude until there is a reason not to
```

This matches the tiers already assigned: steps 1–3 are `PLANNING_MODEL`, steps 4–7
are `CODING_MODEL`.

This table is the concrete form of the capability flag locked in P0.4 — it is the
list P2's refusal check enforces.

---

## 4c. Parity gaps — why shape A is not neutral *yet*

Wrapping another agentic CLI looks neutral: it has its own tools, it reads and
writes files, `DefaultRunner` already proves the spawn pattern. Three things break
that, and all three are silent — the step succeeds, the artifact appears, and the
quality is quietly lower.

> **Status after P1a (2026-09-02):** G2 and G3 are closed — see P1a below. G1
> remains open and ships with the first provider runner in P1.

**G1 — ast-graph is registered with the Claude CLI specifically.**
`packages/extension/src/v2/astGraph/mcpRegister.ts:37` shells out to
`claude mcp add ast-graph --scope local -- <bin> mcp --db <db>`. Codex and the
Gemini CLI both speak MCP but read their own configuration, so under either of
them the server is simply absent. Steps 2, 3, 6 and 7 ask for `blast-radius` and
get nothing. **Certain degradation.** Fix: register the same stdio server through
each CLI's own config during `aidlc init` / `doctor`.

**G2 — the persona never reaches the prompt.** `loadAgentSkills`
(`execEngine.ts:227-229`) joins the agent's *skills* and nothing else; the persona
is pulled in by the model itself, following the literal instruction *"Load your
full persona from `.claude/agents/aidlc-native-product-owner.md`"* in the skill
body. That path does not exist for another CLI, so the phase runs with no persona
at all. **Certain degradation.** Fix: inline the persona into `ctx.skill` in
`execEngine`. Note this is an improvement for Claude too — it removes a filesystem
dependency from the prompt and makes the system prompt self-contained and
testable.

**G3 — project instructions live under a Claude-specific filename.** Every skill
opens with *"Read `CLAUDE.md`"*. Codex looks for `AGENTS.md`, the Gemini CLI for
`GEMINI.md`. The constraint file the phase is supposed to be bound by is not read.
**Certain degradation.** Fix: resolve the instruction file per provider and inline
it, or generate the sibling filename during `init`.

Until G1–G3 are closed, a Codex run is not "Codex instead of Claude" — it is
Codex with no graph, no persona and no project constraints. Under §1a that
disqualifies shape A as much as it disqualifies shape B, which is why parity is
now P1a and comes first. With G2 and G3 closed, a provider runner now inherits
the persona and the project's conventions the moment it is registered; the graph
is the one thing it still has to earn.

---

## 5. Workstreams

Order: **P0 → P1a → P1 → P3**. P2 is **shelved** under §1a and P4/P5 stay optional.

P1a comes before P1 deliberately: shipping a Codex runner on top of the §4c parity
gaps would ship a guaranteed quality regression, which §1a forbids. P1a is also the
only workstream that improves the Claude path as a side effect, so it carries value
even if no second provider is ever added.

### P0 — Locked design decisions ✅ **Locked 2026-09-02**

Eight decisions, settled. Changing any of them later is expensive, so each carries
its reason. D3 and D4 are recorded as void rather than deleted — they were live in
the first draft and their reasoning still applies if P2 is ever revived.

**D1 — `runner` stays a closed enum, widened to agentic CLIs only.**
`z.enum(['default','custom'])` becomes `z.enum(['default','custom','codex','gemini'])`.
`openai-compat` is *not* included: shape B is shelved, and an enum member is a
promise. A closed enum keeps `aidlc validate` able to reject a typo. `default`
keeps meaning Claude — renaming it to `claude` would invalidate every
`workspace.yaml` already on disk, and the migration buys nothing.

**D2 — Provider runners ship as builtins, not `runner_path` files.** They compile
into `@aidlc/core` and register in `RunnerRegistry`'s constructor beside
`DefaultRunner`. Rationale: `CustomRunnerLoader` `require()`s user modules into the
host process unsandboxed and rejects `.ts` outright, so shipping our own providers
that way would mean hand-maintained JavaScript in the repo. `runner: custom` stays
exactly as it is, for genuine user extensions.

**D3 — ~~One OpenAI-compatible runner, not one per vendor.~~ Void.** Shape B is
shelved (P2). The reasoning stands if it returns: DeepSeek, OpenAI direct and
Ollama differ only by base URL, model id and auth header — config, not code.

**D4 — ~~Shape B runners write the artifact.~~ Void** with P2. Shape A needs no
write-back at all: the CLI writes its own files, exactly as `claude` does today.
This is the single largest reason shape A is cheap and shape B is not.

**D5 — Cost is per-provider and best-effort.** `costUsd` stays optional on
`RunnerResult`; a runner parses whatever its CLI reports. A provider that reports
nothing keeps summing as 0 — the budget guard is then blind for that agent, and
`aidlc doctor` must say so out loud rather than presenting a confident wrong total.
No estimating from token counts we did not measure.

**D6 — No auto-fallback between providers.** If Codex fails, the step fails. Silent
substitution would make a run's provenance unreproducible, which is precisely what
gates exist to prevent. Retry-same-provider is allowed; switch-provider is not.

**D7 — Parity before providers.** No provider ships until §4c's G1–G3 are closed
for it. A provider running without the graph, the persona, or the project
instructions is not an option in a picker — it is a regression behind a config
flag. This is the §1a acceptance rule applied to the one place it is easiest to
ignore.

**D8 — `agent.model` becomes load-bearing.** It stops being display-only (today
`DefaultRunner` never passes `--model`, per the comment in `presets/models.ts`) and
is handed to the runner. `models.ts` grows a per-provider tier map so `sonnet`,
`gpt-5-codex` and `gemini-2.5-pro` are all reachable by tier. The Claude entry
keeps its current aliases, so nothing shifts for existing workspaces.

**Also settled while locking, folded out of §6:**

- **Providers in scope: Codex first, Gemini second.** Both go in the D1 enum;
  only Codex gets a runner in P1. Gemini follows once its non-interactive
  behaviour is confirmed stable.
- **G3 is solved by inlining, not by generating files.** AIDLC resolves the
  project-instruction file and puts its content in the prompt. It does **not**
  write `AGENTS.md` or `GEMINI.md` into the user's repository — creating files
  the user did not ask for, in a repo we do not own, is out of scope for a
  provider switch.
- **`auto_review_runner` is unaffected.** `AutoReviewer.ts` loads a local module
  and calls it for `{ decision, reason }`; it is deterministic JavaScript, not an
  LLM call, so no provider work touches it.

### P1a — Harness parity (§4c) ✅ **Shipped 2026-09-02**

Close G1–G3 so that "which provider" is the only variable left. Every item here is
quality-neutral by construction: it either adds a capability a provider was
missing, or moves an existing capability from a filesystem path into the prompt.

**The mechanism.** A runner now declares `HarnessCapabilities` — what its harness
supplies *without* AIDLC saying anything (`persona`, `projectInstructions`,
`astGraph`, plus the `instructionFile` it reads natively). `composeAgentPrompt`
inlines exactly the layers that are false. So the composed prompt differs per
harness while the information reaching the model does not: Claude Code declares
`projectInstructions: true` and is not handed `CLAUDE.md` twice; a runner that
declares nothing is handed everything. Omitting the field is legal and means
`NO_HARNESS_CAPABILITIES` — the conservative reading, so every custom runner
written against the Phase 1 SPI keeps working and simply starts receiving a
fuller prompt.

- **G2 — persona ✅.** `PersonaLoader` resolves `<agent-id>.md` across the same
  three scopes as `AssetDiscovery` (project › `.aidlc` › global), strips the
  frontmatter and the install marker, and caches. `execEngine` resolves the
  runner *before* the prompt (the prompt depends on the harness) and composes
  persona + instructions + skills into `ctx.skill`.
- **G3 — project instructions ✅.** `findProjectInstructions` reads whichever of
  `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `GEMINI.md` the repository
  already has, honouring a per-provider preference so a repo keeping two files
  gives each harness the one written for it. AIDLC still never **writes** one
  (P0, D-locked).
- **G1 — ast-graph ⏭ moved into P1.** Registering the stdio server through
  another CLI's own config cannot be written, let alone verified, before that
  CLI has a runner: the command shape is guesswork today. Under §1a that is the
  textbook "implementable but unverifiable" case, so it ships *with* `CodexRunner`
  rather than ahead of it. `astGraph` is already a declared capability, so the
  wiring it will hang off exists.
- **Parity check in `doctor` ✅.** A new **Harness parity** section names the
  instruction file in force, and per agent whether its persona was found, from
  which scope, and whether it is inlined or harness-loaded. Missing layers print
  as `⚠` and do **not** fail the exit code — an agent with no persona is a
  legitimate configuration, not a broken one. `doctor` also says plainly that it
  does *not* verify MCP registration rather than implying it did (D5).

**Deviation from the plan, deliberate.** The plan said to strip the *"Load your
full persona from `.claude/agents/…`"* line from the skill templates. It is
stripped from the **composed prompt** instead, at the moment the persona is
actually inlined, reusing `composeSkill`'s own regex. Editing 47 template
occurrences would have broken those skills for anyone invoking them directly in
Claude Code outside AIDLC, where the line is the only thing that loads the
persona — and R2 says not to rewrite templates per vendor. Composing gets the
same result with no path dependency in the prompt and no loss anywhere else.

**Done when** ✅: the same step composes a persona-bearing prompt with `CLAUDE.md`
inlined for a capability-less runner and *not* inlined for `DefaultRunner`,
verified end to end through `aidlc run exec --dry-run`; `doctor` reports the
parity of every agent. 21 new tests, 322 core + 25 extension green.

### P1 — Provider SPI + the first shape A runner (Codex)

The goal is to prove the seam with one real non-Claude provider end to end.
P1a has cleared the way; G1 (ast-graph registration for the provider's own CLI)
now ships here, where it can be verified against a CLI that exists.

- Widen the `runner` enum; add `provider`-specific optional fields to
  `AgentSchema` only if unavoidable (prefer `env` + `model`).
- Generalize `runner/types.ts`: rename `ClaudeCliWrapper` → `AgentCliWrapper`
  (keep a deprecated alias export), and extend `RunnerResult` with an optional
  `usage: { inputTokens, outputTokens }` so P3 can price it.
- Extract the NDJSON/stream plumbing shared by `DefaultRunner` into a small
  helper so a second CLI runner is argument shaping, not a rewrite.
- Add `CodexRunner`: spawn `codex exec`, stream stdout through `onOutput`, map
  exit code to `success`, parse usage if the CLI emits it.
- Register it in `RunnerRegistry`'s constructor, with `capabilities` declared
  honestly — `persona: false`, `projectInstructions: false` until proven
  otherwise, `astGraph` only once registration works.
- **G1, carried from P1a**: register the ast-graph stdio server through the
  Codex CLI's own MCP config, and drop the "not verified here" caveat from
  `doctor` for the providers that can be checked.
- Tests: fake `child_process` exactly as the `DefaultRunner` tests do.

**Done when:** a workspace with one agent on `runner: codex` completes `/spec` for
a real epic via `aidlc agent run`, and `spec.md` lands on disk with `produces`
validation passing.

### P2 — Shape B runner (OpenAI-compatible) — 🚫 **SHELVED**

Shelved 2026-09-02 under the §1a acceptance rule. Not cancelled, not blocked on
effort — it is a few hundred lines and entirely buildable. It is shelved because it
cannot be made quality-neutral, by construction:

- On steps 2, 3, 6 and 7 it cannot call ast-graph at all, so it runs blind where
  Claude runs informed. Closing G1 does not help — there is no tool loop to call
  the server *from*.
- On steps 4 and 5 it cannot execute anything, so it either refuses or fabricates.
- On step 1, the only phase it could serve at full capability, the value of a
  second provider is smallest.

That is the whole of shape B: every phase it can serve, it serves worse. The rule
says shelve it, and the rule is right — the alternative is a provider that appears
to work while silently lowering the quality of `plan.md`, which is the artifact the
rest of the pipeline is built on.

**Consequence:** DeepSeek and any API-only provider are out of scope. Multi-provider
means *agentic CLIs* — Claude, Codex, Gemini. §7's local-model note stands: local
models arrive through shape B, so they are shelved with it.

**What would un-shelve it:** a tool loop in the runner (filesystem + shell + an MCP
client) that reaches parity with an agentic CLI. At that point it is no longer
shape B; it is us writing an agent harness, which is a different project with a
different justification.

### P3 — Cost, model tiers, and budget honesty

- Per-provider rate table + `usage` → `costUsd`, so the existing budget ceiling
  works across providers.
- `models.ts` becomes `{ provider → { planning, coding, fast } }`. Keep the
  existing Claude aliases as the `default` provider's entry so nothing shifts.
- Surface the provider next to the model wherever the UI shows a tier today, so a
  user can see that `/spec` ran on Gemini and `/implement` on Claude.
- `aidlc doctor`: probe each configured provider (binary on PATH for shape A, key
  present for shape B) and report which agents have blind cost accounting.

**Done when:** a mixed-provider run reports a non-zero, roughly correct total, and
`doctor` names every misconfigured provider before a run starts rather than during.

### P4 — The interactive path (optional, and the expensive one)

Today `workspaceCommands.ts:367` and `requirementWizard.ts:292` build
`claude '<slash command>'` and push it into a VS Code terminal. Slash commands,
skill auto-selection by `description`, and `.claude/agents/` persona loading are
all Claude Code features — none of them exist in another CLI. So this is not a
matter of swapping a binary name.

Options, cheapest first:

- **(a) Leave it.** Interactive work stays Claude; multi-provider is a headless
  capability (`aidlc run exec`, `aidlc agent run`, CI). Cost: 0. Honest.
- **(b) Route interactive runs through the registry** — replace the terminal
  hand-off with `execEngine` plus an output channel. Loses the live terminal REPL
  feel, gains uniformity. Medium cost, and it changes UX for existing users.
- **(c) Per-provider command translation** — build the equivalent invocation for
  each CLI. Highest cost, highest breakage rate as those CLIs evolve.

**Recommendation: (a) until P1–P3 have real usage.** Ship multi-provider headless,
and let demand decide whether (b) is worth the UX regression.

### P5 — Config surface and docs (optional)

- Builder / wizard: a provider picker on an agent, writing `runner` + `model`.
- `aidlc validate`: cross-check that a shape B runner is not attached to a
  filesystem-writing phase.
- README + preset docs: the shape A / shape B distinction, stated once, plainly.

---

## 6. Open questions

*Three of the original five were answered while locking P0 — see the end of that
section. What remains:*

1. **Do we pin provider CLI versions?** A `codex exec` flag change breaks
   `CodexRunner` silently. A version probe in `doctor` mitigates; pinning does not
   fit a tool the user installs themselves.
2. **Where do provider API keys live for CI?** `${env:VAR}` works locally; CI needs
   the same names documented in one place.

---

## 7. Deferred — local models

Ollama and friends would land on the P2 `OpenAICompatRunner` with only a base URL
change — which means they are shelved along with it, for the same reason: no tool
loop, therefore no parity, therefore a guaranteed quality drop. No separate
workstream is planned. Two things must be recorded now so
they are not rediscovered painfully later:

- **`num_ctx` defaults to 4096 in Ollama, and truncation is silent.** A skill
  (~450 words) plus a persona (~490 words) plus inlined `requires` artifacts will
  exceed it, and the model will answer off-topic with no error. Any local
  configuration must set `num_ctx` explicitly.
- **Tool-calling reliability varies per model**, which is why local models are a
  shape B concern only. Shape A for local models means wrapping an existing local
  agent harness, not building one.

---

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A shape B run "succeeds" having written a plausible artifact while changing no code, and passes the gate | P0.4 write-back plus P2's hard refusal on the phases §4b marks shape-A-only; `produces` alone is not enough evidence |
| R2 | Skills reference `.claude/agents/…` (47 occurrences) and `argument-hint` (25); another CLI ignores both | Shape A providers get the persona inlined into the system prompt instead of by path. Do not rewrite the templates per vendor |
| R3 | Cost under-reporting makes the budget guard useless on mixed runs | P3 rate table; `doctor` warns explicitly rather than reporting a confident wrong number |
| R4 | Provider CLI flags drift, breaking runners between releases | Keep runners thin; version probe in `doctor`; integration test per provider behind an env flag so CI skips without keys |
| R5 | Maintenance load grows linearly with providers | P0.3 — one OpenAI-compatible runner covers most of the field. Resist per-vendor code |
| R6 | Widening the `runner` enum invalidates existing workspaces | Additive only; `default` keeps its meaning and its behaviour |
| R7 | Scope creep into P4 turns a headless feature into a UX rewrite | P4 recommendation is explicitly "leave it" until P1–P3 have usage |

---

## 9. Progress log

| Date | Entry |
|---|---|
| 2026-09-01 | Plan written. Gap analysis measured against `22442ae`. Nothing implemented — awaiting go-ahead per workstream. |
| 2026-09-02 | P0 locked: eight decisions, D1 narrowed to `codex`/`gemini` (no `openai-compat` — shape B is shelved, and an enum member is a promise), D3/D4 recorded void. Three open questions closed: Codex first then Gemini; G3 by inlining, never by writing `AGENTS.md` into the user's repo; `auto_review_runner` unaffected (`AutoReviewer.ts` runs deterministic JS, not an LLM). |
| 2026-09-02 | Owner locked the acceptance rule (§1a): build only what is certainly quality-neutral. Consequences: added §4c (three parity gaps that make even shape A non-neutral today), added P1a and moved it ahead of P1, shelved P2 and with it DeepSeek and local models. |
| 2026-09-02 | P1a shipped: `HarnessCapabilities` on the runner SPI, `PersonaLoader`, `findProjectInstructions`, `composeAgentPrompt`, `execEngine` composing all three layers, `doctor` **Harness parity** section, 21 tests. Two deliberate deviations: the persona directive is stripped at compose time rather than from 47 templates (R2), and G1 moves into P1 because another CLI's MCP config cannot be verified before that CLI has a runner (§1a). |
| 2026-09-02 | Added §4b, the per-step verdict, after walking every `AINATIVE_PHASES` entry and skill body. Corrects P2's refusal list: the blocked pair is `implement` + `verify`, not `implement` + `review` — `review` is read-only by design. |
