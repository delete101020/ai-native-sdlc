---
name: install-local
description: Build this fork and install it locally — package the VSIX, install it into VS Code, and link the CLI onto PATH. No Marketplace, no Open VSX, no npm. Invoke via /install-local [extension|cli|both] — default both.
---

# /install-local — install this build on this machine

This fork is not published anywhere (see W4 in `AI_NATIVE_SDLC_ALIGNMENT.md`).
Both artifacts are built from the working tree and installed locally. Use this
instead of `/publish`, which releases the **upstream** extension under
`hueanmy`'s Marketplace and Open VSX accounts and does not apply here.

Every step is mandatory; stop and report if any step fails — do NOT continue
past a failure.

## 0. Parse args

- Argument may be `extension`, `cli`, or `both`. Default: `both`.
- Reject anything else with a short error.

## 1. Preflight

- `git status --porcelain` — a dirty tree is **allowed** (this is a local
  install, not a release), but list the dirty files in the final report so the
  user knows exactly what they installed.
- Record the commit: `git rev-parse --short HEAD` and the branch.
- Read `version` from `packages/extension/package.json`. The repo-root
  `package.json` has no version — it is the monorepo manifest.
- `node --version` must be ≥ 20. If `node` is missing from PATH, the user's
  version is under nvm: `export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"`.
- For `extension`: `code --version` must succeed. If the `code` command is not
  installed, stop and tell the user to run **Shell Command: Install 'code'
  command in PATH** from the VS Code command palette.

## 2. Build

```
pnpm install
pnpm -r compile
```

Compile must be clean. A type error here means the install would ship broken
code — stop.

## 3. Test

```
pnpm -r test
```

Only `@aidlc/core` and the extension have test scripts. All must pass. Report
the counts in the final block; do not install over a red test run without the
user explicitly saying so.

## 4. Extension (skip if arg is `cli`)

```
pnpm package:extension
```

This produces `packages/extension/aidlc-<version>.vsix`. Then:

```
code --install-extension packages/extension/aidlc-<version>.vsix --force
```

`--force` is what makes a re-install over the same version work; without it
`code` refuses when the version has not changed.

Verify it landed:

```
code --list-extensions --show-versions | grep -i aidlc
```

Expect `delete101020.aidlc@<version>`. **If `hueanmy.aidlc` also appears**, say
so plainly and recommend disabling one — both contribute the same `aidlc.*`
command ids, and VS Code will bind each command to whichever activated first.
Do not uninstall the other one without being asked.

Tell the user to reload the window (**Developer: Reload Window**); an installed
`.vsix` does not take effect in already-open windows.

## 5. CLI (skip if arg is `extension`)

```
cd packages/cli && pnpm bundle && npm link
```

`pnpm bundle` writes `dist/bundle.js` and copies templates, tools, the vendored
annotron and the extension's assets beside it — a plain `tsc` build is **not**
enough, the bin entry points at the bundle.

Verify:

```
aidlc --version        # must match packages/cli/package.json
which aidlc
```

If `aidlc --version` prints a different number than the package, an older global
install is shadowing the link — report the `which` path rather than guessing.

## 6. Smoke test

Run one command that exercises the AI-Native workflow end to end, in a
throwaway directory (never in the user's project):

```
mkdir -p /tmp/aidlc-smoke && cd /tmp/aidlc-smoke
aidlc init && aidlc preset apply ai-native && aidlc validate
```

`validate` must report agents / skills / pipelines with no errors. Clean up the
directory afterwards.

## 7. Final report

One concise block:
- Version, branch, commit SHA, and whether the tree was dirty (list the files)
- Extension: installed id@version, plus the reload reminder
- CLI: `aidlc --version` output and the `which aidlc` path
- Test counts
- Anything skipped and why

## Safety rules

- Never publish. No `vsce publish`, no `ovsx publish`, no `npm publish` — this
  fork has no registry presence, and running `/publish` here would target the
  upstream author's accounts.
- Never commit the `.vsix` (it is gitignored — `*.vsix`).
- Never uninstall an existing extension without being asked; report the clash
  and let the user decide.
- Never run the smoke test inside the user's repo — `aidlc init` writes
  `.aidlc/` and would collide with a real workspace.
