# Incident — [Title]

**Epic ID:** `$EPIC_ID`
**Operator:** Operator (stage 6)
**Status:** Draft
**Created:** `$DATE`

---

## 1. Signal

> *The five fields, as received. Quoted, not paraphrased — later sources fill the
> same shape and these reports have to stay comparable.*

| Field | Value |
|---|---|
| `source` | manual / sentry / otel / pager |
| `observedAt` |  |
| `symptom` |  |
| `scope` |  |
| `evidence` |  |

## 2. What happened

> *The observed behaviour, before any explanation. This line must stay true no
> matter what the cause turns out to be.*

## 3. Why it happened

**Confidence:** confirmed / hypothesis

> *`confirmed` means you can point at the line. Anything else is a hypothesis and
> stays labelled as one.*

| | |
|---|---|
| Code | `file.ts:42` |
| Introduced by | `<sha>` / unknown |
| Specified in | `spec.md` § … / not specified |

## 4. Blast radius

| Dimension | Value |
|---|---|
| Users affected |  |
| Frequency |  |
| Data at risk | none / … |
| Workaround | yes / no |

## 5. What would have caught this

> *The missing acceptance criterion, untested path, or unwritten policy rule. A
> regression is feedback about the process, not only about the code. This feeds
> stage 5's policy amendments and the next spec.*

| Where it should have been caught | What was missing |
|---|---|
|  |  |

## 6. Decision

**open `<new-epic-id>`** / **closed — <reason>**

> *Not every signal deserves five stages. A one-off, an external outage, or an
> already-fixed regression is recorded and closed here.*

## 7. Follow-up intent

> *Only when the decision is `open`. This is the seed of the new epic's
> `intent.md`, and it obeys stage-1 rules — no components, endpoints, schemas or
> libraries, however sure you are which line is at fault.*

| Heading | Content |
|---|---|
| Problem |  |
| Who hurts |  |
| Cost |  |
| Evidence |  |
| Done looks like |  |
| Open questions |  |

---

*Diagnose and hand forward. The fix goes through the same pipeline as any other
change — that is what makes it a loop rather than a patch.*
