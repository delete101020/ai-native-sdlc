---
name: publish
description: Release AIDLC Native — bump extension + CLI versions, write the CHANGELOG section, commit, tag and push; the tag push makes CI publish to the VS Code Marketplace, Open VSX, npm and a GitHub Release. Invoke via /publish [patch|minor|major] — default patch.
---

# /publish — release AIDLC Native

Publishing itself happens in CI (`.github/workflows/release.yml`), triggered by
pushing a `vX.Y.Z` tag. This skill prepares that tag the way every release in
this repo has been made, and then watches it land. **No registry token is ever
used from this machine** — they live in the repo's `release` environment
secrets (`VSCE_PAT`, `OVSX_PAT`, `NPM_TOKEN`).

| Channel | Listing |
|---|---|
| VS Code Marketplace | https://marketplace.visualstudio.com/items?itemName=delete101020.aidlc |
| Open VSX (Antigravity, Cursor, VSCodium) | https://open-vsx.org/extension/delete101020/aidlc |
| npm | https://www.npmjs.com/package/@delete101020/aidlc |
| GitHub Release (.vsix attached) | https://github.com/delete101020/ai-native-sdlc/releases |

Every step is mandatory; stop and report if any step fails — do NOT continue
past a failure.

## 0. Parse args

- `patch`, `minor` or `major`. Default: `patch`. Reject anything else.

## 1. Preflight

- Branch must be `main`, tree clean (`git status --porcelain` empty). If dirty,
  list the files and stop — do not stash or commit them.
- `git fetch origin && git status -sb` — `main` must not be behind `origin/main`.
- Current version from `packages/extension/package.json`; it must equal
  `packages/cli/package.json`'s. The repo-root `package.json` has no version.
- The last tag (`git describe --tags --abbrev=0`) must be `v<current version>`.

## 2. Compute the new version

Semver bump from the arg. State `old → new` in one line.

## 3. Build and test

```
pnpm install --frozen-lockfile
pnpm -r compile
pnpm -r test
pnpm package:extension          # sanity: the .vsix builds (CI builds its own)
```

All green, or stop. The CI job repeats all of this; catching it here saves a
broken tag.

## 4. Release commit

Edit, by hand:

- `packages/extension/package.json` and `packages/cli/package.json` → `version`.
  The release workflow refuses a tag that does not match both.
- `packages/extension/CHANGELOG.md` → a new `## <new-version>` section at the
  top: a short paragraph on what changed for the user, then `### Added` /
  `### Changed` / `### Fixed` as needed, written from `git log v<old>..HEAD`
  (drop merge and release commits). The GitHub Release body is cut from this
  section, up to the next `## ` heading.
- `README.md` → the version in the source-build example
  (`aidlc-<version>.vsix`, `aidlc --version  # <version>`).

```
git add packages/extension/package.json packages/cli/package.json packages/extension/CHANGELOG.md README.md
git commit -m "chore(release): v<new-version>"
git tag v<new-version>          # lightweight, like every earlier tag
```

Do NOT amend. Do NOT use `--no-verify`.

## 5. Confirm, then push

Pushing the tag publishes to three public registries, and a published version
number can never be reused. Show the user the version, the CHANGELOG section,
and the commit, and **ask before pushing**. Then:

```
git push origin main v<new-version>
```

## 6. Watch the release

The `Release` workflow runs on the tag. Report its URL
(`https://github.com/delete101020/ai-native-sdlc/actions/workflows/release.yml`)
and, if `gh` is available, `gh run watch` it.

If a publish step fails, **do not delete or move the tag**. Every publish step
skips what is already there (`--skip-duplicate`, and an `npm view` check), so the
fix is to correct the cause (usually an expired token in the `release`
environment) and re-run the failed job from the Actions page.

## 7. Final report

- New version, commit SHA, tag
- Workflow run URL and result
- The four listing links above
- Remind: VS Code picks up the update on its own (or **Extensions → Check for
  Updates**); `npm update -g @delete101020/aidlc` for the CLI

## Safety rules

- Never publish from this machine (`vsce publish`, `ovsx publish`,
  `npm publish`, `pnpm publish`). CI is the only publisher, so every release is
  a tagged, tested commit.
- Never push without the user's go-ahead in step 5.
- Never `git push --force`, `git reset --hard`, or delete or move a tag without
  explicit instruction.
- Never commit the `.vsix` (gitignored — `*.vsix`).
