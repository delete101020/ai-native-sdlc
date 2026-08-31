---
name: aidlc-native-spec
description: Collapse requirements and design into a single spec.md — testable requirements, acceptance criteria, and explicitly flagged concerns. Stage 2 of the AI-Native SDLC.
argument-hint: "<{{EPIC_PREFIX}}-XXXX>"
---

# Spec for Epic $0

You are the **Product Owner** agent.
Load your full persona from `.claude/agents/aidlc-native-product-owner.md` before starting.

## Step 0: Load the Constraints

Before writing a single requirement, read and keep in context:

1. `CLAUDE.md` — conventions, commands, architecture, known traps.
2. Every project skill that bounds this work — security standards, API design
   rules, brand and writing rules.
3. The active workspace SDLC standard / profile — which sections are mandatory.
4. Existing product docs covering the area, so the spec does not contradict what
   already ships.

List what you loaded in the spec's `Constraints applied` section. A reviewer must be
able to tell what you were bound by.

## Steps

1. Read `docs/epics/$0/artifacts/intent.md`. It is the contract for *why*; the spec
   is the contract for *what*.
2. Use the structural tools (ast-graph `symbol`, `routes`, `blast-radius`) to learn
   what already exists in the affected area before specifying new behavior.
3. Write the spec at `docs/epics/$0/artifacts/spec.md`.
4. Drive every `[CONCERN]` to resolution or explicit deferral before you call it done.

## Spec Contents

### Overview
One paragraph: what this is, and which line of intent.md it serves.

### Constraints applied
The skills, standards and docs you loaded in Step 0.

### User scenarios
Primary flow as given/when/then, plus edge and error paths — dependency down,
permission denied, empty state, boundary inputs, interruption and recovery.

### Functional requirements
Ids `$0-FR01`, `$0-FR02`, … One testable behavior each. Each names the intent line
it traces to.

### Non-functional requirements
Ids `$0-NFR01`, … Performance, reliability, security and privacy, accessibility,
compatibility, observability. Quantified.

### Acceptance criteria
Ids `$0-AC01`, … Given/when/then, one behavior each, error states included.

### Out of scope
What this explicitly does not do.

## Flagging Concerns

Where the intent conflicts with a constraint, with itself, or with something that
already ships, write:

```
> **[CONCERN]** <what conflicts, and with what> — *needs: <who or what decides>*
```

Do not guess and move on. Do not silently narrow scope. Resolve each one inline with
the recorded decision, or defer it explicitly with a named owner.

## Rules

- **No implementation detail** — no libraries, tables, endpoints, file layouts.
- Every requirement is testable and carries a stable id.
- Every requirement traces up to a line in intent.md.
- Quantify: "< 200 ms p95", never "fast".
- `Out of scope` is mandatory. An unbounded spec is not a spec.

## Output

Write `docs/epics/$0/artifacts/spec.md` with no unresolved `[CONCERN]` blocks.
