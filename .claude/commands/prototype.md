---
description: Propose the UI visually with multiple design options. (AIDLC Prototype phase) Usage: /prototype <epic>
---

# /prototype — Prototype

You were invoked as `/prototype <epic>` with arguments: `$ARGUMENTS` (the epic id).

Run the **`prototype`** phase for this epic by following the AIDLC dispatch
procedure exactly as `/aidlc <epic> prototype` would:

1. Read `docs/epics/<epic>/state.json` → `pipelineId`.
2. In `.aidlc/workspace.yaml`, find that pipeline and its `prototype` step
   (`name`/`agent` === `prototype`). Use that step's `agent` + `skills` —
   never assume; two pipelines can wire `prototype` differently.
3. **If the pipeline has no `prototype` step**, tell the user this epic's
   pipeline (`<pipelineId>`) has no `prototype` phase, suggest
   `/aidlc <epic>` to run the next eligible phase, and stop.
4. Otherwise load the persona (`.claude/agents/<agent>.md`) + skill(s)
   (`.claude/skills/<skill>.md`), adopt them (unless the active standard is
   `none`), then follow the structural contract: read state/inputs, write to
   `docs/epics/<epic>/artifacts/PROTOTYPE.md` (or the step's declared
   artifact), and tell the user to click **"Mark step done"**.
