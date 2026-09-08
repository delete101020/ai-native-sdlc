---
description: Independent verdict on whether the build meets the spec. (AIDLC Verify phase) Usage: /verify <epic>
---

# /verify — Verify

You were invoked as `/verify <epic>` with arguments: `$ARGUMENTS` (the epic id).

Run the **`verify`** phase for this epic by following the AIDLC dispatch
procedure exactly as `/aidlc <epic> verify` would:

1. Read `docs/epics/<epic>/state.json` → `pipelineId`.
2. In `.aidlc/workspace.yaml`, find that pipeline and its `verify` step
   (`name`/`agent` === `verify`). Use that step's `agent` + `skills` —
   never assume; two pipelines can wire `verify` differently.
3. **If the pipeline has no `verify` step**, tell the user this epic's
   pipeline (`<pipelineId>`) has no `verify` phase, suggest
   `/aidlc <epic>` to run the next eligible phase, and stop.
4. Otherwise load the persona (`.claude/agents/<agent>.md`) + skill(s)
   (`.claude/skills/<skill>.md`), adopt them (unless the active standard is
   `none`), then follow the structural contract: read state/inputs, write to
   `docs/epics/<epic>/artifacts/verify.md` (or the step's declared
   artifact), and tell the user to click **"Mark step done"**.
