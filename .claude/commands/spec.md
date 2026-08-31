---
description: Collapse requirements and design into spec.md. (AIDLC Spec phase) Usage: /spec <epic>
---

# /spec — Spec

You were invoked as `/spec <epic>` with arguments: `$ARGUMENTS` (the epic id).

Run the **`spec`** phase for this epic by following the AIDLC dispatch
procedure exactly as `/aidlc <epic> spec` would:

1. Read `docs/epics/<epic>/state.json` → `pipelineId`.
2. In `.aidlc/workspace.yaml`, find that pipeline and its `spec` step
   (`name`/`agent` === `spec`). Use that step's `agent` + `skills` —
   never assume; two pipelines can wire `spec` differently.
3. **If the pipeline has no `spec` step**, tell the user this epic's
   pipeline (`<pipelineId>`) has no `spec` phase, suggest
   `/aidlc <epic>` to run the next eligible phase, and stop.
4. Otherwise load the persona (`.claude/agents/<agent>.md`) + skill(s)
   (`.claude/skills/<skill>.md`), adopt them (unless the active standard is
   `none`), then follow the structural contract: read state/inputs, write to
   `docs/epics/<epic>/artifacts/spec.md` (or the step's declared
   artifact), and tell the user to click **"Mark step done"**.
