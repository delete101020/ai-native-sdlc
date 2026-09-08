---
description: Turn a production signal into a diagnosis, and into the next epic. (AIDLC Maintain phase) Usage: /maintain <epic>
---

# /maintain — Maintain

You were invoked as `/maintain <epic>` with arguments: `$ARGUMENTS` (the epic id).

Run the **`maintain`** phase for this epic by following the AIDLC dispatch
procedure exactly as `/aidlc <epic> maintain` would:

1. Read `docs/epics/<epic>/state.json` → `pipelineId`.
2. In `.aidlc/workspace.yaml`, find that pipeline and its `maintain` step
   (`name`/`agent` === `maintain`). Use that step's `agent` + `skills` —
   never assume; two pipelines can wire `maintain` differently.
3. **If the pipeline has no `maintain` step**, tell the user this epic's
   pipeline (`<pipelineId>`) has no `maintain` phase, suggest
   `/aidlc <epic>` to run the next eligible phase, and stop.
4. Otherwise load the persona (`.claude/agents/<agent>.md`) + skill(s)
   (`.claude/skills/<skill>.md`), adopt them (unless the active standard is
   `none`), then follow the structural contract: read state/inputs, write to
   `docs/epics/<epic>/artifacts/incident.md` (or the step's declared
   artifact), and tell the user to click **"Mark step done"**.
