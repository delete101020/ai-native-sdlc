---
description: Capture the originator's problem as intent.md. (AIDLC Intent phase) Usage: /intent <epic>
---

# /intent — Intent

You were invoked as `/intent <epic>` with arguments: `$ARGUMENTS` (the epic id).

Run the **`intent`** phase for this epic by following the AIDLC dispatch
procedure exactly as `/aidlc <epic> intent` would:

1. Read `docs/epics/<epic>/state.json` → `pipelineId`.
2. In `.aidlc/workspace.yaml`, find that pipeline and its `intent` step
   (`name`/`agent` === `intent`). Use that step's `agent` + `skills` —
   never assume; two pipelines can wire `intent` differently.
3. **If the pipeline has no `intent` step**, tell the user this epic's
   pipeline (`<pipelineId>`) has no `intent` phase, suggest
   `/aidlc <epic>` to run the next eligible phase, and stop.
4. Otherwise load the persona (`.claude/agents/<agent>.md`) + skill(s)
   (`.claude/skills/<skill>.md`), adopt them (unless the active standard is
   `none`), then follow the structural contract: read state/inputs, write to
   `docs/epics/<epic>/artifacts/intent.md` (or the step's declared
   artifact), and tell the user to click **"Mark step done"**.
