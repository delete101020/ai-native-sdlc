---
name: aidlc-native-build-plan
description: Plan mode as the default starting point — produce plan.md naming the files, the order, the risks and the proofs before any code is written. Stage 3a of the AI-Native SDLC.
argument-hint: "<{{EPIC_PREFIX}}-XXXX>"
---

# Build Plan for Epic $0

You are the **Engineer** agent.
Load your full persona from `.claude/agents/aidlc-native-engineer.md` before starting.

**Do not write production code in this phase.** The output is a plan that is cheap
to argue with. Code comes in `/implement $0`.

## Steps

1. Read `docs/epics/$0/artifacts/spec.md` — every requirement and acceptance
   criterion, with ids. If `spec.md` does not exist (quick recipe), read
   `intent.md` and say so in the plan.
2. Read `CLAUDE.md` for conventions, commands and known traps.
3. **Learn the code structurally before proposing changes.** Use ast-graph:
   `symbol` for where things are defined and who calls them, `blast-radius` for what
   breaks if you change them, `routes` for existing endpoints. Read function bodies
   only where the graph says it matters.
4. **Interview.** Where the spec is silent, ask — never invent a requirement to make
   the plan tidy.
5. Write `docs/epics/$0/artifacts/plan.md`, then stop for review.

## Plan Contents

### Approach
Two or three paragraphs: the shape of the change and why this shape over the
alternative you rejected. Name the alternative.

### Files
A table, not prose. Real paths.

| Path | Change | Why |
|---|---|---|

### Order
Numbered steps in dependency order, each one independently reviewable. Say what is
true after each step that was not true before it.

### Risks

| Risk | Likelihood | What we do about it |
|---|---|---|

Include at minimum: what could break for existing callers (cite `blast-radius`),
what is hard to reverse, and what we are least sure about.

### Proofs
How each acceptance criterion will be shown to hold — the command to run, the test
to write, the screen to look at. Map `$0-ACnn` → proof. A plan without proofs is a
wish.

### Feedback loop
State the loop you will use while implementing: unit tests, a running instance,
a screenshot, a scratch database. If none exists, building it is step 1 of `Order`.

## Rules

- **Name real files.** "The auth module" is not a plan; `src/auth/session.ts` is.
- Every acceptance criterion in the spec appears in `Proofs`, or the plan states
  why it is out of scope for this change.
- Prefer the smallest change that satisfies the spec. Note what you deliberately
  left alone.
- If the spec turns out to be wrong or incomplete, stop and say so — do not patch
  around it in the plan.

## Output

Write `docs/epics/$0/artifacts/plan.md`.
