#!/usr/bin/env bash
# Marketing version for iOS / Android store builds.
#
# Source of truth is the git tag — same contract as desktop-release-macos.yml
# and desktop-release-windows.yml (`VERSION="${GITHUB_REF#refs/tags/v}"`).
# apps/mobile/app.json is a placeholder and must not drift production.
#
#   refs/tags/v1.13.34           → 1.13.34   (unified release)
#   refs/tags/android-v1.13.34   → 1.13.34   (Android-only)
#   refs/tags/ios-v1.13.34       → 1.13.34   (iOS-only)
#   production workflow_dispatch → nearest v* tag
#   staging / main               → apps/mobile/app.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_JSON="$ROOT/apps/mobile/app.json"
FALLBACK="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).expo.version" "$APP_JSON")"

REF="${GITHUB_REF:-}"
ENV="${MOBILE_RELEASE_ENV:-}"

VERSION=""
SOURCE=""

if [[ "$REF" == refs/tags/v[0-9]* ]]; then
  VERSION="${REF#refs/tags/v}"
  SOURCE="unified tag"
elif [[ "$REF" == refs/tags/android-v* ]]; then
  VERSION="${REF#refs/tags/android-v}"
  SOURCE="android-v tag"
elif [[ "$REF" == refs/tags/ios-v* ]]; then
  VERSION="${REF#refs/tags/ios-v}"
  SOURCE="ios-v tag"
elif [[ "$ENV" == production ]]; then
  # `git tag` works on a shallow clone with `fetch-tags: true`; `git describe`
  # would need ancestry from HEAD to the tag.
  TAG="$(git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
  if [[ -n "$TAG" ]]; then
    VERSION="${TAG#v}"
    SOURCE="latest v* tag (production dispatch)"
  fi
fi

if [[ -z "$VERSION" ]]; then
  VERSION="$FALLBACK"
  SOURCE="apps/mobile/app.json"
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::Invalid mobile marketing version '$VERSION' from $SOURCE (ref=$REF)"
  exit 1
fi

echo "Resolved app version: $VERSION ($SOURCE, ref=${REF:-none})"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "version=$VERSION" >> "$GITHUB_OUTPUT"
fi
