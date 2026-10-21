#!/usr/bin/env bash
# Decide whether a change touches "app code" — anything a running app could
# behave differently under, and so anything that should re-run the local-mode
# E2E matrix.
#
# Deny-list, not allow-list: only paths that provably cannot change runtime
# behaviour count as non-app, so a brand new app or package directory is
# covered without editing this file. An empty or unknown diff fails open.
#
# Reads changed paths on stdin (one per line — `git diff --name-only base head`)
# and writes `app=true|false` both to stdout and, under Actions, to
# $GITHUB_OUTPUT.
#
# Usage: git diff --name-only "$BASE_SHA" "$HEAD_SHA" | scripts/ci/app-code-changed.sh
set -euo pipefail

app=false
seen=false
while IFS= read -r path; do
  if [[ -z "$path" ]]; then
    continue
  fi
  seen=true
  case "$path" in
    # Prose, plans, hooks, benchmarks, docs: no runtime effect.
    docs/*|apps/docs/*|plans/*|.githooks/*|scripts/bench/*) continue ;;
    *.md|LICENSE|LICENSE.*|.gitignore) continue ;;
    # Workflows are not app code — except CI itself, whose change must prove
    # the suite still runs. Every other file the E2E jobs execute lives
    # outside .github (e2e/local/**, the playwright configs), so it is app
    # code by default below.
    .github/workflows/ci.yml) app=true; break ;;
    .github/*) continue ;;
  esac
  app=true
  break
done

if [[ "$seen" == "false" ]]; then
  # Nothing to classify (no diff, or a base we could not resolve): assume app.
  app=true
fi

echo "app=${app}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "app=${app}" >> "$GITHUB_OUTPUT"
fi
