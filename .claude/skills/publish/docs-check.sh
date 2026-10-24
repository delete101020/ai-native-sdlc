#!/usr/bin/env bash
# Listing-page check for /publish step 4. Run after the CHANGELOG section is
# written, before the release commit:
#
#   .claude/skills/publish/docs-check.sh <old-version> <new-version>
#
# Fails (exit 1) when
#   - the CHANGELOG has no `## <new-version>` section, or
#   - a `code` term in that section appears in none of the listing pages, or
#   - there are feat commits since v<old> and a listing page was not touched
#     (neither committed since the tag nor modified in the working tree).
# A miss that is fine on purpose (an internal key, a file path) is listed in
# DOCS_CHECK_IGNORE, space-separated, e.g. DOCS_CHECK_IGNORE="state.json foo".
set -euo pipefail

old="${1:?old version}"; new="${2:?new version}"
cd "$(git rev-parse --show-toplevel)"

changelog=packages/extension/CHANGELOG.md
pages=(packages/extension/README.md packages/cli/README.md packages/cli/AUTOMATION.md README.md)
fail=0

section=$(awk -v h="## $new" '$0==h{f=1;next} /^## /{f=0} f' "$changelog")
if [ -z "$section" ]; then
  echo "✘ $changelog has no '## $new' section"; exit 1
fi

# 1. Every `term` the CHANGELOG section names should be findable on a page.
missing=()
while IFS= read -r term; do
  [ -z "$term" ] && continue
  case " ${DOCS_CHECK_IGNORE:-} " in *" $term "*) continue ;; esac
  # Paths and globs are not features; skip them.
  case "$term" in */*|*.md|*.json|*.yaml|*.mjs|*.ts) continue ;; esac
  if [[ "$term" == aidlc\ * ]]; then
    # A command line: each word and flag must be on a page; placeholders
    # (<epic>, '<json>', …) and `a|b` alternatives are split or dropped.
    for tok in $(printf '%s' "$term" | tr '|' ' '); do
      case "$tok" in \<*|\'*|\"*|\[*|…) continue ;; esac
      tok="${tok%%=*}"
      if ! rg -qF -- "$tok" "${pages[@]}"; then missing+=("$term  (no '$tok')"); break; fi
    done
  elif ! rg -qF -- "$term" "${pages[@]}"; then
    missing+=("$term")
  fi
done < <(printf '%s\n' "$section" | rg -o '`([^`]+)`' -r '$1' | sort -u)

if [ ${#missing[@]} -gt 0 ]; then
  fail=1
  echo "✘ named in CHANGELOG $new but on no listing page:"
  printf '    %s\n' "${missing[@]}"
fi

# 2. With new features, every listing page that owns them should have moved.
feats=$(git log --format=%s "v$old..HEAD" | rg -c '^feat' || true)
if [ "${feats:-0}" -gt 0 ]; then
  for p in packages/extension/README.md packages/cli/README.md README.md; do
    if git diff --quiet "v$old" -- "$p"; then
      fail=1
      echo "✘ $feats feat commit(s) since v$old, but $p is unchanged"
    fi
  done
fi

if [ $fail -eq 0 ]; then echo "✔ listing pages cover CHANGELOG $new"; fi
exit $fail
