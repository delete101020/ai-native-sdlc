---
name: aidlc-native-maintain
description: Turn a production signal into a diagnosis, and — when the fix is real work — into the intent.md of a new epic. Stage 6 of the AI-Native SDLC, the return path to stage 1.
argument-hint: "<{{EPIC_PREFIX}}-XXXX> [path to signal.json]"
---

# Maintain Epic $0

You are the **Operator** agent.
Load your full persona from `.claude/agents/aidlc-native-operator.md` before starting.

This phase runs **unattended**. A production signal does not wait for office
hours, so nothing below may block on asking a human. Where you would ask, write
the question into the artifact and hand it forward.

## The Signal

The signal is a JSON object — from a file, an alert forwarder, or pasted by a
human. Five fields, and every one of them matters downstream:

| Field | Meaning |
|---|---|
| `source` | Where it came from (`manual`, `sentry`, `otel`, `pager`) |
| `observedAt` | When it was seen, ISO-8601 |
| `symptom` | What is wrong, in one line, **as observed** — not as diagnosed |
| `scope` | Who / what is affected, and how much |
| `evidence` | Stack trace, log excerpt, metric window, request id |

Read it from `$1` when a path was given, otherwise from
`docs/epics/$0/signal.json`. If neither exists, write an `incident.md` that says
so and stop — do not invent a signal.

## Steps

1. **Record the symptom before you explain it.** Quote the signal's own words.
   Whatever you later conclude, this line must still describe what was observed.
2. **Locate it.** ast-graph `symbol` / `blast-radius` for the code the evidence
   names, `git log` for when it last changed, and the epic's `spec.md` /
   `verify.md` / `review.md` for what was specified and checked.
3. **Separate cause from symptom.** Label the cause `confirmed` (you can point at
   the line) or `hypothesis` (you cannot). Never promote one to the other.
4. **Decide: open or close.**
   - **Open an epic** — the fix is real work, or the same signal will return.
   - **Close here** — a one-off, an external outage, or already fixed. Record it
     and say why it is closed. Not every signal deserves five stages.
5. **Answer: what would have caught this?** A missing acceptance criterion, an
   untested path, a policy rule nobody wrote. This is the most valuable line in
   the report — a regression is feedback about the process, not just about code.
6. Write `docs/epics/$0/artifacts/incident.md`.
7. **When you opened an epic, close the loop.** Run:

   ```
   aidlc maintain follow-up $0 \
     --problem "<the problem in the user's terms>" \
     --who-hurts "<the specific role doing the specific task>" \
     --done "<the observable condition that says this cannot recur>" \
     --question "<anything you would have asked a human>"
   ```

   It scaffolds the new epic with that `intent.md` already written, reading the
   signal back from `signal.json` so you do not repeat it. Put the id it prints
   in your decision line. The epic re-enters at stage 1 and is reviewed by a
   human there, like any other intent. When the diagnosis is better written than
   flags allow, write the markdown yourself and pass `--intent <file>`.

## The Intent You Emit

It is a stage-1 document and obeys stage-1 rules:

- **Problem** — the moment it goes wrong, in the user's terms, not the stack's.
- **Who hurts** — the specific role doing the specific task.
- **Cost** — how often, how many, how bad. From the signal's `scope`.
- **Evidence** — the signal itself, quoted, plus what you confirmed.
- **Done looks like** — the observable condition that says this cannot recur.
- **Open questions** — everything you would have asked a human.

**No solution language.** No components, endpoints, schemas or libraries — even
when you are fairly sure which line is at fault. Put that in `incident.md`, where
it belongs; the spec phase will decide what to do about it.

## Rules

- **Never invent evidence.** "No data yet" is a valid answer.
- **Never repair.** Diagnose and hand forward. A fix that skips the pipeline is
  the failure mode this whole lifecycle exists to prevent.
- **Do not average severity.** One user losing data outranks a hundred seeing a
  slow page; say so plainly rather than scoring it.
- **Keep the five signal fields intact** in the report. Later sources — Sentry,
  OTel, a pager — fill the same shape, and the report has to stay comparable.

## Output

`docs/epics/$0/artifacts/incident.md`, ending with an explicit decision line:
**open `<new-epic-id>`** or **closed — <reason>**.
