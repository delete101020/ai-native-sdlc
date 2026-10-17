#!/usr/bin/env python3
"""AIDLC approval gate — a PreToolUse hook that blocks out-of-policy actions.

Stage 5 of the AI-Native SDLC ("Deploy") puts the gate in the tooling rather
than in a checklist a reviewer might skim past. A skill can be ignored by an
agent that has convinced itself; a hook cannot.

Register it in `.claude/settings.json` (gitignored, so each clone opts in):

    {
      "hooks": {
        "PreToolUse": [
          {
            "matcher": "Bash|Write|Edit",
            "hooks": [
              { "type": "command",
                "command": ".claude/hooks/aidlc-approval-gate.py" }
            ]
          }
        ]
      }
    }

Contract: reads the hook payload as JSON on stdin, exits 0 to allow and 2 to
block (stderr is fed back to the agent as the reason). Anything unexpected —
malformed JSON, a rule that cannot be evaluated — allows when a person is at
the keyboard: a gate that fails closed on its own bugs blocks real work, and
someone is there to see what the agent does instead. Under autopilot
(`AIDLC_AUTOPILOT=1`, set by `aidlc run exec` for a pipeline with
`autopilot: true`) nobody is, so the same failure blocks. An unknown tool is
not a failure — it allows either way.
"""

import json
import os
import re
import sys

PROTECTED_BRANCHES = ("main", "master")

# Paths whose contents are owned by the pipeline, not by an agent editing files.
# Run state advances through "Mark step done" so the runner stays the single
# writer; hand-editing it desynchronizes the DAG from what actually ran.
PIPELINE_OWNED = re.compile(r"docs/epics/[^/]+/state\.json$")

# Files that should never enter a commit, whatever the policy file says.
SECRET_LIKE = re.compile(
    r"(^|/)(\.env(\.[\w-]+)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.keystore)$"
)


def block(reason: str) -> None:
    print(f"AIDLC approval gate: {reason}", file=sys.stderr)
    sys.exit(2)


def check_bash(command: str) -> None:
    # Normalize whitespace so `git   push  --force` reads the same as the tidy form.
    cmd = " ".join(command.split())

    is_push = re.search(r"\bgit\b.*\bpush\b", cmd) is not None
    # `--force`/`--force-with-lease`, or a short-flag bundle containing `f`
    # (`-f`, `-uf`). The short form must be a standalone single-dash token so
    # long options that merely contain an `f` (`--follow-tags`) do not match.
    forced = re.search(r"(--force(-with-lease)?\b|(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*(?=\s|$))", cmd) is not None
    if is_push and forced:
        for branch in PROTECTED_BRANCHES:
            if re.search(rf"\b{branch}\b", cmd):
                block(
                    f"force-push to `{branch}` is blocked. Protected branches are "
                    "fast-forward only; push the feature branch and open a PR."
                )

    for m in re.finditer(r"\bgit\b\s+add\s+([^\|&;]+)", cmd):
        for arg in m.group(1).split():
            if arg.startswith("-"):
                continue
            if SECRET_LIKE.search(arg):
                block(
                    f"`git add {arg}` is blocked: the path looks like a credential "
                    "file. Secrets belong in the environment, never in a commit."
                )


def check_write(path: str) -> None:
    if PIPELINE_OWNED.search(path.replace("\\", "/")):
        block(
            f"`{path}` is owned by the AIDLC runner. Advance the pipeline with "
            '"Mark step done" instead of editing run state by hand.'
        )


def unattended() -> bool:
    return os.environ.get("AIDLC_AUTOPILOT") == "1"


def cannot_check(what: str) -> None:
    """Allow when someone is watching, block when nobody is."""
    if unattended():
        block(
            f"{what}, and this is an unattended autopilot run, so the gate blocks "
            "rather than let an action through unchecked."
        )
    sys.exit(0)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        cannot_check("the hook payload is not valid JSON")

    if not isinstance(payload, dict):
        cannot_check("the hook payload is not a JSON object")
    tool = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        cannot_check(f"the input of `{tool}` is not a JSON object")

    if tool == "Bash":
        check_bash(str(tool_input.get("command") or ""))
    elif tool in ("Write", "Edit", "NotebookEdit"):
        check_write(str(tool_input.get("file_path") or ""))

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # a bug in a rule, not a decision
        cannot_check(f"the gate failed ({type(exc).__name__}: {exc})")
