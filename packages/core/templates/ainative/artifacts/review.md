# Review Report — [Title]

**Epic ID:** `$EPIC_ID`
**Reviewer:** Reviewer (policy)
**Status:** Draft
**Created:** `$DATE`
**Reviewed against:** `CLAUDE.md`, loaded skills, workspace SDLC standard

---

## 1. Verdict

> *One line. Any `blocker` row below makes the verdict a hold.*

**Overall:** ship / hold

## 2. Scope reviewed

| | |
|---|---|
| Base | `<branch or sha>` |
| Head | `<branch or sha>` |
| Files changed | |
| Read in full | yes / file-by-file |

## 3. Policy checklist

> *The rules actually read before the diff, and whether the diff honors each.*

| Source | Rule | Honored |
|---|---|---|
| `CLAUDE.md` § … |  | yes / no / n-a |

## 4. Findings

| # | Severity | Location | Finding | Policy |
|---|---|---|---|---|
| 1 | blocker / should-fix / note | `file.ts:42` |  | `CLAUDE.md` § … / `opinion` |

> *Every row cites the policy line it breaks, or is labelled `opinion`.*

## 5. Always-in-scope checks

| Check | Result |
|---|---|
| Secrets in code / fixtures / logs | clean / finding #… |
| Data handling (PII, retention, boundaries) | clean / finding #… |
| Silent failure (swallowed errors, ignored codes) | clean / finding #… |
| Newly reachable surface (API, route, permission) | clean / finding #… |

## 6. Not re-checked

> *Already covered by `verify.md` — cited, not redone.*

## 7. Shortest path to ship

> *Only when the verdict is hold: the minimum set of changes that would flip it.*

1.

## 8. Policy amendments

> *Rules broken repeatedly, or findings with no written rule to cite. Propose the
> wording — a rule everyone breaks is a broken rule. Feeds stage 6.*

| Proposed rule | Where it belongs | Why |
|---|---|---|
|  |  |  |
