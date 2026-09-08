#!/usr/bin/env bash
# Decide whether a main-branch push should run the iOS/Android pipeline.
#
# Unified `v*` / `android-v*` / `ios-v*` tags must always run (path filters on
# `on.push` would skip a tag whose commit did not touch apps/mobile — which is
# how store builds drifted off the desktop/cloud version).
#
# Usage: mobile-workflow-should-run.sh android.yml
set -euo pipefail

WORKFLOW_FILE="${1:?workflow filename (android.yml or ios.yml)}"

write_out() {
  local skipped="$1"
  echo "skipped=$skipped"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "skipped=$skipped" >> "$GITHUB_OUTPUT"
  fi
}

if [[ "${GITHUB_REF:-}" == refs/tags/* || "${GITHUB_EVENT_NAME:-}" == workflow_dispatch ]]; then
  write_out false
  exit 0
fi

BEFORE="${GITHUB_EVENT_BEFORE:-}"
SHA="${GITHUB_SHA:-HEAD}"

if [[ -z "$BEFORE" || "$BEFORE" == 0000000000000000000000000000000000000000 ]]; then
  write_out false
  exit 0
fi

if ! git cat-file -e "${BEFORE}^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=50 origin "$BEFORE" 2>/dev/null || {
    echo "Could not fetch $BEFORE — running the workflow to be safe"
    write_out false
    exit 0
  }
fi

CHANGED="$(git diff --name-only "$BEFORE" "$SHA")"

should_run_path() {
  local file="$1"
  case "$file" in
    apps/mobile/*|packages/domain-stores/*|packages/shared-app/*|packages/shared-ui/*|packages/ui-kit/*|packages/sdk/*|scripts/ci/*)
      return 0
      ;;
    ".github/workflows/${WORKFLOW_FILE}")
      return 0
      ;;
  esac
  return 1
}

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if should_run_path "$file"; then
    write_out false
    exit 0
  fi
done <<< "$CHANGED"

echo "No mobile/store paths changed between $BEFORE and $SHA — skipping"
write_out true
