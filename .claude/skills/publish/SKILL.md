---
name: publish
description: Release AIDLC Native from this machine — bump extension + CLI versions, write the CHANGELOG section, commit, tag and push, build the .vsix from the tag, publish to Open VSX and npm, and hand the .vsix over for the manual Marketplace upload. Invoke via /publish [patch|minor|major] — default patch.
---

# /publish — release AIDLC Native from this machine

Releases are made locally. Nothing here needs Azure DevOps: the Marketplace
takes the `.vsix` through its web upload, Open VSX takes a token created on
open-vsx.org, and npm uses this machine's `npm login`. No CI job runs on a
release tag — there is no release workflow, on purpose.

| Channel | How it gets there | Listing |
|---|---|---|
| VS Code Marketplace | **The user** uploads the `.vsix` at marketplace.visualstudio.com/manage | https://marketplace.visualstudio.com/items?itemName=delete101020.aidlc-native |
| Open VSX (Antigravity, Cursor, VSCodium) | `ovsx publish` with `$OVSX_PAT` | https://open-vsx.org/extension/delete101020/aidlc-native |
| npm | `pnpm publish`, run by **the user** (2FA prompt) | https://www.npmjs.com/package/@delete101020/aidlc |

Every step is mandatory; stop and report if any step fails — do NOT continue
past a failure.

## 0. Parse args

- `patch`, `minor` or `major`. Default: `patch`. Reject anything else.

## 1. Preflight

Run these and stop on any failure:

- Branch is `main`, tree clean (`git status --porcelain` empty). If dirty, list
  the files and stop — do not stash or commit them.
- `git fetch origin` — `main` must not be behind `origin/main` (ahead is fine;
  step 6 pushes it).
- `packages/extension/package.json` and `packages/cli/package.json` have the
  same `version`, and the last tag (`git describe --tags --abbrev=0`) is
  `v<that version>`. The repo-root `package.json` has no version.
- `printenv OVSX_PAT | head -c 4` is non-empty. If not, stop with:
  > `OVSX_PAT` not set. Create a token at https://open-vsx.org/user-settings/tokens
  > (sign in with GitHub, sign the Publisher Agreement first), then set it in
  > this shell and retry. First release only: `npx ovsx create-namespace delete101020 -p <token>`.
- `npm whoami` prints `delete101020`. If not, stop and ask the user to run
  `! npm login`.

## 2. Compute the new version

Semver bump from the arg. State `old → new` in one line.

## 3. Build and test

```
pnpm install --frozen-lockfile
pnpm -r compile
pnpm -r test
```

All green, or stop.

## 4. Release commit and tag

Edit, by hand:

- `packages/extension/package.json` and `packages/cli/package.json` → `version`.
- `packages/extension/CHANGELOG.md` → a new `## <new-version>` section at the
  top: a short paragraph on what changed for the user, then `### Added` /
  `### Changed` / `### Fixed` as needed, written from `git log v<old>..HEAD`
  (drop merge and release commits). Breaking changes get their own
  `### Breaking` heading with what the user has to do. The Marketplace shows
  this file on the listing's Changelog tab.
- `README.md` → the version in the source-build example
  (`aidlc-native-<version>.vsix`, `aidlc --version  # <version>`).

```
git add packages/extension/package.json packages/cli/package.json packages/extension/CHANGELOG.md README.md
git commit -m "chore(release): v<new-version>"
git tag v<new-version>          # lightweight, like every earlier tag
```

Do NOT amend. Do NOT use `--no-verify`.

## 5. Build the artifacts from the tag

The tree is clean and `HEAD` is the tag, so what gets published is exactly the
tagged commit:

```
test "$(git rev-parse HEAD)" = "$(git rev-parse v<new-version>^{commit})"
pnpm package:extension          # → packages/extension/aidlc-native-<new-version>.vsix
```

Check the `.vsix` exists, and that
`unzip -p packages/extension/aidlc-native-<new-version>.vsix extension/package.json`
shows `"version": "<new-version>"` and `"displayName": "AIDLC Native"`.

## 6. Confirm, then push

Publishing is public, and a published version number can never be reused on
any of the three registries. Show the user the version, the CHANGELOG section,
the commit and the `.vsix` path, and **ask before going further**. Then:

```
git push origin main v<new-version>
```

## 7. Open VSX

```
npx --yes ovsx@0.10 publish packages/extension/aidlc-native-<new-version>.vsix -p "$OVSX_PAT" --skip-duplicate
```

## 8. npm — the user runs it

The account's 2FA is a passkey, which npm can only ask for through a browser
(`--auth-type=web`), and only from a real terminal: the `!` prefix has no TTY,
so there npm fails with `EOTP` instead of offering the link. Build the tarball
here, and hand the user only the publish.

Check the version is not already there (`npm view @delete101020/aidlc@<new-version> version`
must fail), then:

```
cd packages/cli && pnpm bundle && pnpm pack --pack-destination "$TEMP"
```

`pnpm pack`, not `npm pack`: it rewrites `workspace:*` in `package.json`. Give
the user the tarball path and ask them to run, in a VS Code or PowerShell
terminal:

```powershell
npm publish "$env:TEMPdelete101020-aidlc-<new-version>.tgz" --access public --auth-type=web
```

npm prints `Authenticate your account at: …`; Enter opens it, the passkey
confirms, and the publish finishes. Confirm with
`npm view @delete101020/aidlc version` — a brand-new version can take a few
minutes to become readable. Delete the tarball only after that.

## 9. Marketplace — the user uploads it

Give the user the absolute path of the `.vsix` and these steps:

- https://marketplace.visualstudio.com/manage/publishers/delete101020
- First release: **+ New extension → Visual Studio Code**, drop the `.vsix`.
- Later releases: **⋯** next to AIDLC Native → **Update**, drop the `.vsix`.
- The Marketplace scans it for a few minutes before it goes live.

When they report back, confirm it is live:

```
curl -s -X POST 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' \
  -H 'Content-Type: application/json' -H 'Accept: application/json;api-version=7.1-preview.1' \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"delete101020.aidlc-native"}]}],"flags":1}'
```

The first entry under `versions` should be `<new-version>`. If it is still
older, say it may still be verifying rather than calling it a failure.

## 10. Final report

- New version, commit SHA, tag
- Each channel: published / skipped (already there) / waiting on the user, with
  its listing link
- Remind: VS Code picks up the update on its own (or **Extensions → Check for
  Updates**); `npm update -g @delete101020/aidlc` for the CLI

## Safety rules

- Publish only from a clean tree whose `HEAD` is the release tag (step 5) —
  never from a working tree with uncommitted changes.
- Never push or publish without the user's go-ahead in step 6.
- Never print a token, and never write one to a file in the repo.
- If a publish fails after the push, **do not delete or move the tag**. Fix the
  cause and re-run only the step that failed; each one skips a version that is
  already there.
- Never `git push --force`, `git reset --hard`, or delete a tag without explicit
  instruction.
- Never commit the `.vsix` (gitignored — `*.vsix`).
