# Changelog

## 3.11.0

Starting an epic added a pipeline, and that pipeline was then offered as a
workflow to start the next epic with. After a dozen epics the Domain picker was
mostly rows nobody would ever pick. They are gone from the pickers — and because
that closed the only way to edit one, two new ways in open.

### Added

- **`Show epic pipelines` — Builder > Workflows.**
  Puts the hidden rows back, in a dropdown group of their own, for when an
  epic's own workflow does need a change. Off by default and remembered between
  sessions. The toggle also renders beside the empty state: with every pipeline
  in the workspace owned by an epic, hiding them would otherwise leave an empty
  picker and no visible way back.

- **`Edit workflow` on the epic card.**
  Opens the Builder on that epic's own pipeline — unhiding it first, since
  landing on the Workflows tab is no use when the target is filtered out of the
  list. What can be changed there is unchanged: gates and `depends_on` always,
  the step list until a run pins the positions its history indexes into.

- **`Reload` on the Epics page.**
  Re-reads the epics from disk. The panel follows file changes on its own; this
  is the way back when it has not.

### Changed

- **Epic-owned pipelines no longer appear as workflows.**
  Builder > Workflows > Domain, its count badge, the Workflows tab badge and the
  Start-epic modal all filter through one helper now. An epic's pipeline is that
  epic's run shape, not something to start other work with.

  Only the modal filtered before, and only on `derived_from` — a marker inside
  the YAML, absent from any epic pipeline written before it existed or edited by
  hand. The second signal is where the definition was read from
  (`docs/epics/<id>/pipeline.yaml`), which is a fact about the file rather than
  its contents, so nothing can strip it.

- **The extension description and the Details tab.**
  The blurb still advertised a fixed six-stage pipeline that recipes replaced,
  and `README.md` — which renders as the Details tab — stopped at "New in 3.6".
  3.7 through 3.10 are now described there.

### Fixed

- **A deleted epic kept its card.**
  The file watchers are registered on the very files a recursive folder delete
  removes, and such a delete does not reliably emit an event per file. Deletion
  now refreshes the panel itself instead of waiting for a watcher that may never
  fire.


## 3.10.0

`runExecLoop` was extracted into `@aidlc/core` so both front ends could drive a
run, and then only the CLI ever called it: from the editor a pipeline advanced
one button at a time. It now has a front door. Alongside it, two ways the panel
could mislead you are closed — a stepper that moved while the body stayed put,
and a start button that reset a finished epic.

### Added

- **`Run to completion` — the unattended loop, from the panel.**
  One button on an epic card executes every remaining step back to back:
  spawning each agent, checking its `produces` artifacts, running `auto_review`
  headlessly, advancing. The same engine the CLI's `aidlc run exec` drives, so
  the two front ends stop and resume at exactly the same places. A modal asks
  the only two questions that change where it stops — whether `human_review`
  gates pause it (naming the agents it would approve unread) and whether to run
  the pipeline out or halt after a step you pick. The gates it cannot be told to
  ignore are listed rather than offered: auto-review rejecting an artifact, a
  runner exiting non-zero, the pipeline's budget ceiling.

  The loop spawns in the extension host, so unlike `Run with Claude` there is no
  terminal to read: output goes to `Output → AIDLC Autopilot`, progress to a
  cancellable notification, and every transition refreshes the panel so the
  stepper moves as the run does. It registers in the same activity registry as a
  dispatched agent, so `Mark step done`, `Approve`, `Reject` and `Delete` are
  already disabled while it runs, with no second busy channel to keep honest.

- **Cancelling an exec loop (`shouldCancel`).**
  The progress notification's Cancel takes effect at the next step boundary, not
  during a step, and says so. The runner owns a spawned process it can only
  kill, and a half-written artifact left behind by a killed agent would satisfy
  the `produces` check on the next attempt — the gate cannot tell a finished
  file from an abandoned one. So the step in flight runs to its own end and the
  loop stops before spawning another, leaving the run somewhere a person can
  pick it up by hand. The CLI reports the new `cancelled` outcome as exit 2,
  alongside the other stops that are not failures.

### Fixed

- **`Start pipeline run` no longer resets a finished epic.**
  `.aidlc/runs/` is gitignored while `docs/epics/<id>/state.json` is tracked, so
  an epic that finished long ago and had its run file cleaned up read as
  `!epic.runId` — "never started" — and was offered the start button again.
  Starting mirrors a fresh all-pending run state over the epic's `state.json`:
  approvals, revisions, feedback and history gone, for a click that reads like
  it only creates something. The artifacts on disk survive; the record of them
  having been reviewed does not. A `done` epic is now offered no start button at
  all, and an epic with completed steps behind a missing run file gets a modal
  that counts them and says what will be discarded, pointing at a follow-up epic
  as the way forward.

- **The body follows the stepper when a step is approved.**
  Approving at `build-plan` moved the stepper to `implement` and left the panel
  below it showing the step that had just been approved.

### Changed

- **`AIDLC Autopilot` is gone from Workflows → Common.**
  It advertised a setting from a row that could not show whether it was doing
  anything. The `aidlc.autopilot.enabled` setting, the scaffold hook and the
  core plan generation are untouched — only the advertisement is removed.

- `Epic id prefix` reads `Epic ID prefix`.

## 3.9.0

An epic stops being a row in the team's shared file. Its pipeline moves into its
own directory, its artifacts get a git branch of their own, and its depth, its id
and its gates stop being decisions the workspace makes on everyone's behalf.
Alongside that, stage 6 — which had a CLI and no front door — gets a form to
report a signal, and the work that comes out of a diagnosis is finally drawn as a
link rather than left as two rows that happen to sort next to each other.

### Added

- **`docs/epics/<id>/pipeline.yaml` — an epic owns its pipeline.**
  Starting an epic used to append its assembled pipeline to
  `.aidlc/workspace.yaml`, so per-epic state and team-wide config shared one
  tracked file with a single append point: every concurrent epic conflicted
  there, and the file grew ~50 near-duplicate lines per epic with nothing to
  garbage-collect. The definition now lives beside the epic's `state.json`.
  Nothing downstream learns about it — the document is spliced together on read
  and routed back out on write, so the ~40 call sites that look up
  `doc.pipelines` are untouched and `WorkspaceLoader` still validates one whole
  workspace with its cross-ref checks intact. Existing workspaces keep their
  pipelines inline until `aidlc epic pipeline extract` moves them, deliberately a
  command rather than a silent migration; `aidlc doctor` reports what is left
  inline, what no longer parses, and a definition that exists in both places.

- **`strict_mode` — how deep an epic's phases go.**
  The artifact templates are built for the largest thing an epic can be. That is
  right for an epic that earns it and wrong for one the size of a single task,
  where the same template produces pages nobody asked for and every phase after
  it has more to read. Depth now lives in the epic's own `state.json`, because it
  is a property of the work item and not of the team. Absent means `true`, so
  every epic started before this composes byte-identical prompts. Set it with
  `aidlc epic start --no-strict`, read or change it with
  `aidlc epic strict <id> [on|off]`, or use the checkbox in Start epic and the
  `Depth:` badge on the epic card. The rule is a budget on breadth, never on
  correctness: every heading the template has survives — auto-review rules assert
  on those exact strings — and an inapplicable one gets one honest line instead
  of invented content.

- **`artifact_commit: on_approve` — an epic's artifacts get a branch of their own.**
  Until a step's artifact was committed it was a dirty file on whatever branch
  the user happened to be standing on, swept up later into the engineer's
  `git add` and into the same commit as the code. Approving a step now writes it
  to `epic/<id>` with git plumbing — a throwaway index, `hash-object`,
  `commit-tree`, `update-ref` — so HEAD, the real index and the working tree are
  never touched and a mid-epic approval cannot move the checkout out from under
  an open editor. The branch is created lazily at the first approval and deleted
  with `git branch -D` if the epic is abandoned, safe precisely because it was
  never checked out. `docs/epics/` stays tracked on the user's own branch: this
  is a durable second home, not a relocation. Off by default.

- **`gates:` on a recipe — where the human review stands, per task type.**
  A recipe picked which steps ran and nothing else, so every recipe drawn from
  one pipeline inherited the same gates, and the only way to disagree was to
  start the epic and turn gates off step by step. A recipe now states only where
  it disagrees; the rest inherits. A gate keyed to a step the recipe does not run
  is reported by `aidlc validate` instead of sitting there reading as if it were
  in force, and `auto_review` with no runner to clear it is refused at assembly
  rather than parking the step in `awaiting_auto_review` forever.

- **`native-lite` — intent → build-plan → implement → review**, human gates on
  the first two only. The shape a change with a precedent in the codebase
  actually wants: no spec because the behaviour is not in question, no verify
  because there is a pattern to follow, and review as the one quality gate, read
  after the branch is finished rather than before.

- **`epic_id_prefix` — two letters and a date in every epic id.**
  Scanning `docs/epics/` for the highest `EPIC-NNN` fails twice on a shared repo:
  two people are both offered the same number, and a hand-written prefix is not
  counted at all, so the suggester keeps proposing an id that is already taken.
  The suggestion becomes `EPIC-260908-NG-001`. The date leads on purpose —
  `docs/epics/` is shared, so sorting by name is a team-wide timeline rather than
  a grouping by author with time scattered inside it — and it is built from the
  local calendar, not from slicing an ISO string, which at UTC+7 would file every
  epic opened before 07:00 under yesterday. The prefix lives in gitignored
  `.aidlc/user.yaml` so it belongs to the checkout and not the team, and a value
  is derived from `git config user.name` (diacritics folded) as a suggestion that
  is never written until someone accepts it. Unset behaves exactly as before, and
  nothing renames an epic that already exists. `aidlc epic next-id` prints the
  suggestion for scripting.

- **Report a signal — stage 6 has a front door.**
  `native-incident` was pickable in Start epic and reachable nowhere else: the
  modal cannot write `signal.json`, and the skill's rule when the file is missing
  is to write an `incident.md` saying so and stop — a green run whose artifact is
  one line of apology. The new form collects the five `Signal` fields and
  scaffolds the epic around them, so it cannot exist without its input. Start
  epic warns when the picked recipe contains `maintain` and offers the other
  form, without blocking. Incident epics default to proportional depth, unlike
  every other front door: one unattended step writing one file about one signal
  is precisely the shape full depth handles worst.

- **The incident → follow-up edge, on the UI.**
  `openFollowUpEpic` has always written `from_epic` into the new epic's
  `inputs.json`, but nothing read it back. The card header now carries the link
  in both directions, an incident and its follow-ups collapse into one group on
  the Epics list, and a family that is entirely done starts collapsed. The
  follow-up dialog names the epics that already follow this incident instead of
  reading identically the second time — which is how one incident quietly ended
  up with a `-FIX` and a `-FIX-2` nobody wanted. A second follow-up is still
  reachable, since one diagnosis can fork into work that ships separately; it
  just has to be asked for. Both dialogs offer `Choose recipe…`: `native-fix`
  stays the default, but the work a diagnosis opens ranges from a one-file perf
  fix to a redesign.

- **Active Runs in the sidebar.** `buildState` had always computed `activeRuns`
  and no component ever read it, so a run started from the Builder had no surface
  once its toast faded and the only way to advance it was the CLI. Each card now
  carries the step position, status, current agent, the slash command as a
  click-to-copy chip, the artifacts the step should produce (dimmed until they
  exist), missing upstream inputs, and the action the status actually allows.

- **`artifact_language` on the UI.** Honoured by the prompt composer for a while,
  but nothing wrote it — no control, no flag, only the key in `workspace.yaml` if
  you knew it existed. Unset means each phase infers a language from the brief on
  its own, which is how a Vietnamese intent ends up followed by an English spec
  in the same epic; the pipeline's premise is that phase N+1 reads phase N. "No
  preference" stays a real choice and deletes the key rather than writing an
  empty string, and the named languages are a convenience, not a whitelist.

- **A running agent is visible, and the buttons that mean it isn't are not
  offered.** `awaiting_work` covered two situations under one name: nobody has
  started this step, and Claude has been writing for four minutes. Work the
  extension dispatches itself is now recorded and cleared on whichever signal
  arrives first — the shell reporting the command finished, the terminal closing,
  or the run's own step moving on. It never claims the negative: a step run by
  pasting the slash command into your own Claude window is invisible to the
  editor and always will be, so the registry only ever adds a running state.

### Fixed

- **`strict_mode` never reached the webview.** The DTO was built field by field
  and this one was not copied, so every epic arrived `undefined` and rendered as
  proportional no matter what `state.json` said — and the toggle then sent
  `!undefined`, which is why clicking an epic that was already full depth looked
  like it did nothing. The field is now declared on the interface, so the next
  hand-built DTO that forgets it fails to compile instead of failing silently.

- **"Mark step done" was offered before the artifact existed.** `markStepDone`
  validates `produces` and throws, so the button was never a real choice — it was
  an error toast with a delay, and on a step nobody had run it read as an
  invitation to skip the work. The gate now distinguishes "the file is missing"
  from "this step declares no file", and the status line says which file.

- **New epics were seeded with blank templates.** `artifacts/` was filled from
  the template directory at create time, which defeated the gate outright —
  `canStartStep` and `markStepDone` check only that the path exists, so an
  unfilled template satisfied them from the moment the epic did. The copy was
  also keyed to the *source* pipeline, so a `native-fix` epic received a `spec.md`
  and an `incident.md` its recipe drops. `artifacts/` is now created empty and
  every file in it is something an agent wrote; the templates are still
  provisioned, and the pointer to them moves into the command bodies.

- **Approving a step did not advance the sidebar, on Windows.** The watchers built
  their patterns with `path.join`, which yields `.aidlc\runs\*.json`, where a
  backslash is a glob escape rather than a separator — so the runs watcher never
  fired once. The deeper fix is that mutating handlers now refresh directly:
  leaning on a filesystem watcher to learn about a transition your own button just
  caused is the wrong instrument even when the glob is right.

- **Recent Epics opened `state.json`, not the epic.** The storage format is not
  what the click asked for. It now reveals the epic's card, expands it and scrolls
  to it, with the deep link held until the webview says it is ready and handled by
  a component that is always mounted. The raw JSON is still one button away inside
  the expanded card.

- **The depth badge wrote `state.json` on a single click.** It reads as a status
  chip and was an undoable write that changed how every remaining phase composes
  its prompt. It now asks first, and the question names the steps the change can
  still reach and states what it is not — unlike Request update it rewrites no
  artifact and rewinds no step. A finished epic freezes the badge. Where a
  workspace's command bodies predate the setting and would ignore it silently, the
  warning offers to refresh them.

- **The badge said `Full depth` / `Proportional`,** which reads as a quality flag
  — as though `true` meant "done properly". It is the opposite way round, so the
  badge now names its axis: `Depth: full` / `Depth: proportional`. The key stays
  `strict_mode`; renaming it would be a migration for a wording problem.

- **The delete dialog now names what it deletes** — the artifact filenames and how
  many approved steps go with them, listed under the folder checkbox. "State,
  inputs, and every artifact" asks the user to remember what an epic they opened
  last week contains.

- **The slash command in the "run this next" message was invented.**
  `slash_commands` names are free text and only coincidentally match the agent
  they target. It is resolved from `workspace.yaml`, and when nothing targets the
  agent the message says so instead of guessing.

### Changed

- `epic_id_prefix` moved from `.aidlc/workspace.yaml` to gitignored
  `.aidlc/user.yaml`. The committed key is demoted to a fallback rather than
  dropped — workspaces already have it set, and removing its effect would silently
  renumber their next epic — but `aidlc validate` says it should move.

## 3.8.0

The step list of a running epic became editable in 3.7.0; its review gates
follow here, from the CLI and with the extension finally saying what a gate
change reaches when the step is already past it.

### Added

- **`aidlc epic step set <epic> <step>` — change a step's review gates while it runs.**
  `--human-review` / `--no-human-review` and `--auto-review <runner>` /
  `--no-auto-review`. Unlike `add`/`remove` this writes only the pipeline:
  the runner reads the gates off it when a step's work is submitted rather
  than copying them into the run, so there is no second store to keep in
  step. That is also why the extension leaves the gate toggles enabled on a
  pipeline whose step list it has locked.
  What it cannot do is reach backwards, and it now says so instead of looking
  like it did nothing: a step already parked at a gate is not released by
  turning that gate off, and one that has passed its gates takes the new
  setting on its next revision. The same note appears in the extension when a
  gate is toggled on a step a running epic has already gone past.

## 3.7.0

Three threads land together: a prompt that carries everything a phase needs
instead of paths to go and read it; a Start epic that right-sizes the workflow
to the task rather than running all six phases for a one-line fix; and an epic
whose step list can still be changed after it has started, without the run
losing track of what happened.

Every phase now receives its persona and the repository's own conventions *in
the prompt*, instead of as file paths it was told to go and read.

A step's system prompt was the agent's skills and nothing else. The persona
reached the model only because each skill body opens with "Load your full
persona from `.claude/agents/aidlc-native-originator.md`", and the project's
rules only because Claude Code loads `CLAUDE.md` on its own. Both assume
Claude's directory layout, which is why swapping in another CLI was a quality
question rather than a wiring one — and it cost Claude a tool round-trip for a
file AIDLC could already resolve.

Runners now declare what their harness supplies natively, and the prompt
composer inlines exactly the rest. Claude is not handed `CLAUDE.md` twice; a
runner that declares nothing is handed everything. A custom runner that
declares no capabilities keeps working and simply receives a fuller prompt.

### Added

- **`aidlc epic step add|remove <epic>` — reshape a running epic's pipeline.**
  The pipeline, the run state and the epic's `state.json` are updated together,
  so the history keeps describing the step it was always about: `stepIdx` is
  renumbered, the pointer follows the step it was on, and the indices recorded
  in step history are rewritten. Everything is validated before anything is
  written, and a failed write puts back what it already wrote.
  What it refuses is the part worth knowing: a step that is not `pending`
  (removing it would delete the record of work that happened — `aidlc step
  skip` is still the way past a step in flight), an insertion at or before a
  step that has started (it would never open), a step other steps `depends_on`,
  the last remaining step, a `--agent` or `--depends-on` the workspace does not
  define, a step with no `depends_on` in a DAG pipeline (nothing would ever
  open it), a pipeline shared with another epic, and a run that has already
  drifted from its pipeline.

- **A run now records *which* step each entry is about, not just where it sat.**
  `StepRecord` gained a `name`, so a step's identity in the run state is the
  same `name ?? agent` the pipeline, `depends_on` and the DAG resolver already
  use. `reconcileRunSteps` compares a run against its pipeline on that
  identity and says exactly what was added, removed or moved, and every
  transition (`markStepDone`, `approveStep`, `submitAutoReviewVerdict`)
  refuses to run on a drifted pair instead of resolving indices into a step
  list that no longer means what it did. Run state moves to schema 2; a
  version-1 file is migrated on read and picks up its step names the first
  time the run is touched, so nothing needs a migration pass.
- **`aidlc step skip <run> <step>` accepts a step name.** Indices and agent
  ids still work, but a persona that owns several steps used to resolve to the
  first of them silently — it now says so and lists the steps to choose from.

- **A running epic's step list can no longer be reshaped by accident.**
  `aidlc epic start` writes the epic's steps three times — the pipeline in
  `workspace.yaml`, `stepStates[]` in the epic's `state.json`, and `steps[]`
  in `.aidlc/runs/<id>.json` — and only the first records a step *name*. The
  other two, and the run pointer, are positions. The per-epic pipeline shows
  up in the Pipelines view like any other, so its Add / Delete / Reorder /
  drag controls were live, and using one moved the pipeline without moving
  the history: the runner only checks that an index is still inside the
  array, so a pipeline that got *shorter* kept running against the wrong
  steps with no error at all. Those controls are now hidden while an epic
  owns the workflow, with the reason and the `aidlc step skip` alternative
  on the card. The host refuses the same edits independently — a webview-only
  guard would not be one, given the failure is silent. Gates and
  `depends_on` stay editable, and the workflow editor still accepts a save
  that leaves the agent sequence unchanged.

- **`Preview (VS Code)` on an epic artifact.** The menu offered a source
  editor and an annotron preview, and the annotron one costs a terminal
  running `node …/annotron` plus a browser tab. That price buys diagram
  rendering, which is worth it for a spec full of Mermaid and nothing at all
  for one without. The new item renders the artifact in VS Code's own
  Markdown preview and stays in the editor; annotron remains for diagrams and
  is the same view the Feedback loop uses. Both are now labelled with where
  they open.

- **`artifact_language:` in workspace.yaml, so a pipeline stops changing
  language halfway through.** Nothing used to say what language artifacts are
  written in, which left each phase to infer it from the brief on its own — a
  Vietnamese intent could be followed by an English spec, and phase N+1 reads
  phase N. Declaring the language settles it once for the workspace: the
  headless composer inlines it (it has the config loaded), and the slash
  commands read it from `workspace.yaml` at run time so a command file written
  months ago cannot claim a language the workspace has since changed.

  The rule governs prose only. Headings, field labels and table columns stay
  in English on purpose: the maintain loop *generates* documents with the
  literal strings `## 1. Problem` … `## 7. Open questions`, and auto-review
  rules match headings, so a translated heading is a section the pipeline that
  asked for it can no longer find.

  Unset means what it always meant — no section composed, prompt unchanged.

- **Start epic: pick a recipe by hand.** The Workflow list offered one `Auto`
  row and the pipelines; every recipe was reachable only through the classifier,
  so choosing a known-good recipe meant wording the brief until the keywords
  landed on it. Recipes now list under their own group, each showing its steps,
  and the classifier’s current pick is badged ★ suggested among them rather
  than replacing the choice.
- **Start epic: capability inputs collapse, and start folded.** They are all
  optional, every one of them is a path or URL only the user can supply, and a
  workflow touching several of them pushed the footer out of view. The section
  folds from its header and reports `n filled` while closed, so folding never
  hides that values are set.
- **Start epic: recipes list most-steps-first.** Source order was authored by
  task type, which put the six-step full flow third and gave no way to see what
  a shorter row gives up. The list is a coverage ladder — dropping a step drops
  a guarantee — so it now reads from "every gate kept" down to "one phase
  only".
- Persona resolution across all three asset scopes (project › `.aidlc` ›
  global), with frontmatter and install markers stripped before inlining.
- Project instructions are resolved from whichever of `CLAUDE.md`,
  `.claude/CLAUDE.md`, `AGENTS.md` or `GEMINI.md` the repository already keeps —
  AIDLC never creates one.
- `aidlc doctor` gains a **Harness parity** section: the instruction file in
  force, and per agent whether its persona was found, from which scope, and
  whether it is inlined or loaded by the harness. Advisory findings print as
  `⚠` and do not fail the exit code.
- `aidlc run exec --dry-run` names which layers were inlined.
- **`runner: codex`** — a bundled runner for `codex exec`, the first non-Claude
  harness. It receives the same composed prompt every other harness does, so
  which provider runs a phase is a wiring choice. Two things do not carry across
  a provider boundary by themselves — a `model:` tier alias and a price — and
  both are declared in the new `providers:` block below.
- **`aidlc mcp status` / `aidlc mcp register`** — give another CLI the same
  `ast-graph` server Claude has. The extension registers Claude automatically
  because `--scope local` is per-project; Codex stores MCP servers per user, so
  registering it stays an explicit command. `register` copies the binary and db
  path out of Claude's existing registration rather than rediscovering them.
- `gemini` is accepted by the schema but has no runner yet, and says so when a
  step tries to resolve it — never a silent fallback to Claude.
- **A `providers:` block in `workspace.yaml`**, carrying the two per-provider
  facts AIDLC is not entitled to invent:

  ```yaml
  providers:
    codex:
      model_aliases: { sonnet: gpt-5-codex }
      rates: { "*": { input_per_mtok: 1.25, output_per_mtok: 10.0 } }
  ```

  `model_aliases` says which concrete model a tier means on that provider.
  `rates` prices the tokens a CLI reports for the providers that report tokens
  rather than dollars. Both are optional; without them an agent runs on the
  CLI's own default model with blind cost accounting, and `doctor` says so.

  AIDLC ships neither table pre-filled, on purpose. A published price goes stale
  silently and yields a *plausible* total rather than a loud failure, and the
  real figure depends on discounts we cannot see. A tier map would mean
  asserting that two vendors' models are interchangeable for your work — and
  guessing model ids for a CLI we cannot query, where a wrong `--model` fails
  the run outright.
- `aidlc doctor` gains a **Providers** section: each provider CLI's presence on
  `PATH` and `--version`, the concrete model every agent resolves to, and which
  providers have blind cost accounting.
- **Four recipes for the AI-Native workflow**, taking it from four to eight.
  The set was chosen against one axis — which of `spec`, `verify` and `review`
  the work actually needs — because the old set left a hole: `review` was
  reachable only through `native-full`, so a bug fix had to pay for a spec of
  behaviour it does not change.
  - `native-fix` (`intent → build-plan → implement → verify → review`) — the
    hole above. Bug fixes, refactors and tech debt: no spec, both gates.
  - `native-align` (`intent → spec`) — stop once acceptance criteria exist, so
    scope can be agreed before engineering is paid for.
  - `native-audit` (`review`) — judge a diff that already exists against policy.
  - `native-hotfix` (`build-plan → implement → review`) — the fast path, and
    the one to reach for reluctantly: it drops `intent`, leaving the engineer
    with only the epic description, and drops `verify` during an incident,
    which is when an independent check is worth most. Its `description` says
    so in the recipe picker.

### Fixed

- **The button that starts a step launched an unknown command.** "Run with
  Claude" sends the slash command named in `slash_commands`,
  which for a built-in workflow is namespaced — `/ai-native-full-intent`. The
  only writer for those files lived in the extension's preset-apply path, so a
  workspace set up with `aidlc preset apply` declared the name and had no file
  behind it: the step could not be started at all. Commands are now provisioned
  from the pipelines a workspace declares, on the way to launching Claude, so
  an affected workspace heals on the next click.

- **`aidlc preset apply` and the panel produced different workspaces.** The CLI
  merged `workspace.yaml` and stopped there; `.claude/commands/` and the
  artifact templates under `.aidlc/aidlc-templates/` were written only by the
  extension. Two front doors to the same preset, one of which left every epic
  with no commands to run and an empty `artifacts/`. Both now call the same
  provisioning code.

- **The phase dispatcher named one place a skill could live.** `/intent` and
  its siblings resolve the agent and skills from `workspace.yaml` at runtime,
  then told the agent to read `.claude/skills/<skill>.md` — but a preset-applied
  workspace declares a `path:` per skill, pointing at `~/.claude/skills/`. The
  dispatcher now resolves the declared path first and falls back to the project
  directory only when none is given.

- **Start epic pre-filled `docs/core` into every epic it created.** The
  `core-business` capability listed `docs/core` as both placeholder *and*
  default, so an untouched field still submitted a value — one that most repos
  have no such directory for. Capability inputs are captured at scaffold time
  and no command edits them afterwards, so the only way back out was hand-editing
  `inputs.json` and the run state. Nothing is pre-filled now; the placeholder
  still shows the shape expected.

- **"Your pipelines" grew a dead row for every epic ever started.** Starting
  an epic from a recipe writes the assembled pipeline into `workspace.yaml`
  under the epic's own id, and the picker listed anything not built in — so
  `EPIC-001` appeared beside the real workflows, looking like something you
  could start other work with. Per-epic pipelines are now recognised by their
  recorded source and left out of the picker, including its fallback selection.

- **An epic started from a recipe got an empty `artifacts/`.** Artifact
  templates are read from `.aidlc/aidlc-templates/<pipelineId>/`, but a
  recipe-assembled pipeline is named after its epic (`EPIC-001`), and no
  template directory will ever carry that name. Assembled pipelines now record
  the pipeline they drew their steps from, and the scaffold seeds from that.

- **The title and description typed into Start epic reached no agent.** They
  were written to `state.json`, which is machine state that no skill opens —
  while phase one's skill reads `docs/epics/<epic>/<epic>.md` by name, a file
  the scaffold never wrote. Every run therefore began from an empty brief and
  asked the user back for what they had already typed. The scaffold now writes
  that file.

- **Switch Claude Account no longer hands your account to the team by
  default.** Writing to “This workspace” lands in `.vscode/settings.json`,
  which many repos commit — and the damage is invisible on the machine that
  makes the choice: the teammate who pulls it gets a config dir that does not
  exist on theirs, so their Agents panel is empty with nothing to explain why.
  That row now checks git first (tracked beats ignored) and says so when the
  file is shared. A repository git cannot answer for raises no alarm.

- **`epic start --brief` classified every brief as `native-quick`.** The
  heuristic classifier's fallback chains listed only the `sdlc` preset's recipe
  ids (`bugfix`, `small-feature`, …). An `ai-native` workspace defines none of
  them, so every chain fell through to `recipes[0]` — the task type was
  computed correctly and then discarded. The chains now name each type's native
  equivalent after its sdlc one, so `sdlc` workspaces resolve exactly as before
  while `ai-native` briefs route to `native-fix`, `native-full` or
  `native-spike` on their merits. `--llm` was unaffected and remains the more
  accurate path.

### Changed

- `aidlc doctor` now *verifies* MCP registration against each CLI's own config
  file instead of noting that it does not check. It also reports the instruction
  file per runner, since a repo carrying both `CLAUDE.md` and `AGENTS.md` binds
  each harness to a different one.
- `ClaudeCliWrapper` is now `AgentCliWrapper`. The old name remains exported as
  a deprecated alias, so existing custom runners keep compiling.
- **A cost total now states how well it is known.** A step's cost is measured
  (the CLI reported dollars), estimated (tokens × your declared rate), or blind
  (neither). An estimate counts against `budget.max_usd` — the alternative is a
  provider with no ceiling at all — but never passes itself off as measured: the
  run report and the autopilot's budget line read `≥ ~$2.5000 (includes
  estimates from declared rates; 1 step reported no cost)`.
- The run report gains an **Engine** column naming the runner and resolved model
  per step, and the Builder badges any agent whose runner is not `default`, so a
  pipeline that mixes harnesses shows it without opening `workspace.yaml`.

## 3.6.3

Fixed the Agents / Skills counters in the sidebar. A preset installs each asset
twice by design — once as a `workspace.yaml` declaration, once as a `.md` file
under `~/.claude/` or `.claude/` — and the sidebar added the two lists instead
of merging them, so a project with 6 agents and 12 skills was advertised as 12
and 19. The Builder tab has always deduplicated by id, so the two surfaces
disagreed with each other.

### Fixed

- Sidebar `AGENTS` / `SKILLS` counts now count distinct ids across all three
  scopes (aidlc + project + global), matching the Builder tab's totals.

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
