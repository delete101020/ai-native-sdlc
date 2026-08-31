---
name: aidlc-native-implement
description: Build the feature against the approved plan.md on a feature branch, closing your own feedback loop as you go. Stage 3b of the AI-Native SDLC.
argument-hint: "<{{EPIC_PREFIX}}-XXXX>"
---

# Implement Epic $0

You are the **Engineer** agent.
Load your full persona from `.claude/agents/aidlc-native-engineer.md` before starting.

## Step 0: Git Behaviour

Read the step's `git` config from `.aidlc/runs/$RUN_ID.json` → `steps[implement].git`:

- `git.branch` — create a feature branch (default: true)
- `git.push` — push the branch to origin (default: true)
- `git.open_pr` — open a PR after pushing (default: true)

With no run state, default all three to true. Honour these flags throughout.

## Steps

1. Read `docs/epics/$0/artifacts/plan.md` — this is what you agreed to build.
   Read `spec.md` for the acceptance criteria the code must satisfy.
2. Read `CLAUDE.md`. Conventions, commands and known traps are binding.
3. **Stand up the feedback loop named in the plan before writing code.** You must be
   able to see the effect of your own changes.
4. Work through `Order` in the plan, one step at a time. Commit per step, with a
   message naming the step.
5. **Close the loop after every step**: run the tests, run the build, run the app,
   read the output. Fix and repeat until it actually passes.
6. Execute every proof listed in the plan and capture the real output.
7. Write `docs/epics/$0/artifacts/implement.md`.
8. Push and open the PR per Step 0, linking the epic and the spec.

## implement.md Contents

- **Branch / PR** — branch name, PR link.
- **What was built** — per plan step: what changed, in which files.
- **Proofs executed** — the command and its real output, per `$0-ACnn`.
- **Deviations from the plan** — anything you did differently, and why. If nothing,
  say so explicitly.
- **Discovered work** — what you found but deliberately did not do, and where it went
  (a plan amendment, a new intent, an issue).
- **Known gaps** — what a reviewer should look at hardest.

## Rules

- **Never claim a test passed without running it.** Paste the command and its output.
  An unverified success claim is worse than a reported failure.
- **Match the surrounding code** — comment density, naming, idiom. New code should
  read like the code around it.
- **Stay inside the plan.** Scope found mid-flight becomes a plan amendment or a new
  intent; it never lands silently in the diff.
- **Small, ordered commits.** The reviewer reads the sequence, not just the endpoint.
- If a plan step turns out to be wrong, stop and amend `plan.md` before continuing.

## Output

Write `docs/epics/$0/artifacts/implement.md`, with the branch pushed and the PR open
unless Step 0 says otherwise.
