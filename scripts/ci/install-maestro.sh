#!/usr/bin/env bash
# Install a pinned Maestro CLI release, verified against its published
# checksums, and put it on $GITHUB_PATH.
set -euo pipefail

: "${MAESTRO_VERSION:?set MAESTRO_VERSION (release tag, e.g. cli-2.10.0)}"
DEST="${RUNNER_TEMP:-/tmp}/maestro-cli"
BASE="https://github.com/mobile-dev-inc/maestro/releases/download/$MAESTRO_VERSION"

mkdir -p "$DEST"
cd "$DEST"
curl -fsSL -o maestro.zip "$BASE/maestro.zip"
curl -fsSL -o checksums_sha256.txt "$BASE/checksums_sha256.txt"
want=$(awk '$2 ~ /(^|\/)maestro\.zip$/ {print $1}' checksums_sha256.txt)
[ -n "$want" ] || { echo "::error::maestro.zip missing from checksums_sha256.txt"; exit 1; }
if command -v sha256sum >/dev/null; then got=$(sha256sum maestro.zip | cut -d' ' -f1); else got=$(shasum -a 256 maestro.zip | cut -d' ' -f1); fi
[ "$got" = "$want" ] || { echo "::error::maestro.zip checksum mismatch ($got != $want)"; exit 1; }
unzip -qo maestro.zip
"$DEST/maestro/bin/maestro" --version
if [ -n "${GITHUB_PATH:-}" ]; then echo "$DEST/maestro/bin" >> "$GITHUB_PATH"; fi
