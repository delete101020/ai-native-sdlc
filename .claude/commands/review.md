---
description: Review the diff against policy before it ships. (AIDLC Review phase) Usage: /review <epic>
---

# /review — Review

You were invoked as `/review <epic>` with arguments: `$ARGUMENTS` (the epic id).

Run the **`review`** phase for this epic by following the AIDLC dispatch
procedure exactly as `/aidlc <epic> review` would:

1. Read `docs/epics/<epic>/state.json` → `pipelineId`.
2. In `.aidlc/workspace.yaml`, find that pipeline and its `review` step
   (`name`/`agent` === `review`). Use that step's `agent` + `skills` —
   never assume; two pipelines can wire `review` differently.
3. **If the pipeline has no `review` step**, tell the user this epic's
   pipeline (`<pipelineId>`) has no `review` phase, suggest
   `/aidlc <epic>` to run the next eligible phase, and stop.
4. Otherwise load the persona (`.claude/agents/<agent>.md`) + skill(s)
   (`.claude/skills/<skill>.md`), adopt them (unless the active standard is
   `none`), then follow the structural contract: read state/inputs, write to
   `docs/epics/<epic>/artifacts/review.md` (or the step's declared
   artifact), and tell the user to click **"Mark step done"**.
