---
description: Plan the implementation before writing code. (AIDLC Build Plan phase) Usage: /build-plan <epic>
---

# /build-plan — Build Plan

You were invoked as `/build-plan <epic>` with arguments: `$ARGUMENTS` (the epic id).

Run the **`build-plan`** phase for this epic by following the AIDLC dispatch
procedure exactly as `/aidlc <epic> build-plan` would:

1. Read `docs/epics/<epic>/state.json` → `pipelineId`.
2. In `.aidlc/workspace.yaml`, find that pipeline and its `build-plan` step
   (`name`/`agent` === `build-plan`). Use that step's `agent` + `skills` —
   never assume; two pipelines can wire `build-plan` differently.
3. **If the pipeline has no `build-plan` step**, tell the user this epic's
   pipeline (`<pipelineId>`) has no `build-plan` phase, suggest
   `/aidlc <epic>` to run the next eligible phase, and stop.
4. Otherwise load the persona (`.claude/agents/<agent>.md`) + skill(s)
   (`.claude/skills/<skill>.md`), adopt them (unless the active standard is
   `none`), then follow the structural contract: read state/inputs, write to
   `docs/epics/<epic>/artifacts/plan.md` (or the step's declared
   artifact), and tell the user to click **"Mark step done"**.
