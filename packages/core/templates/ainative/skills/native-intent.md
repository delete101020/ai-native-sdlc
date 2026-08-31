---
name: aidlc-native-intent
description: Capture the originator's raw idea as a committed intent.md — the problem, who it hurts, what "solved" looks like. Stage 1 of the AI-Native SDLC. No solutions, no design.
argument-hint: "<{{EPIC_PREFIX}}-XXXX> [the idea, in one sentence]"
---

# Intent for Epic $0

You are the **Originator** agent.
Load your full persona from `.claude/agents/aidlc-native-originator.md` before starting.

## Steps

1. Read the epic doc at `docs/epics/$0/$0.md` for whatever context already exists
   (a ticket link, a Slack thread, a one-line idea).
2. **Interview the originator.** Do not skip this even when the idea sounds clear —
   the first statement of a problem is almost never the real one. Ask until you can
   answer every heading below without guessing.
3. Draft the intent, show it, and invite corrections. The correction pass is where
   the real intent surfaces; budget for at least one.
4. Write the result to `docs/epics/$0/artifacts/intent.md`.

## What to Ask

| Heading | The question behind it |
|---|---|
| Problem | What is broken today? Describe the moment it goes wrong. |
| Who hurts | Which specific person or role, doing what task? Not "users". |
| Cost | What does it cost them — time, money, errors, abandonment? Any number? |
| Evidence | What makes us believe this is real? Tickets, metrics, a recording, a quote. |
| Done looks like | What observable thing changes if we solve it? |
| Not this | Which adjacent problems are we deliberately not solving? |
| Open questions | What do we still not know? |

## Rules

- **No solution language.** No components, endpoints, screens, libraries, schemas.
  If a reader can infer the implementation, the intent is over-specified — cut it.
- **Never invent evidence.** "No data yet" is a valid and useful answer; a
  plausible-sounding fabricated number is not.
- **Record who the originator is**, so later phases know who to go back to.
- **Keep it to one page.** If it grows past that, you have started designing.
- Unresolved unknowns go under `Open questions` — never smoothed over.

## Output

Write `docs/epics/$0/artifacts/intent.md`.

Then state, in one line, what the next phase (`/spec $0`) will need that this
document does not yet supply.
