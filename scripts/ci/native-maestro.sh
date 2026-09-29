#!/usr/bin/env bash
# Run apps/mobile/.maestro/smoke.yaml against an already-booted simulator
# (PLATFORM=ios) or emulator (PLATFORM=android) that has the app installed,
# once in light and once in dark appearance. Screenshots and JUnit reports
# land in $MAESTRO_OUT.
set -euo pipefail

: "${APP_ID:?set APP_ID}"
: "${PLATFORM:?set PLATFORM=ios|android}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FLOW="$ROOT/apps/mobile/.maestro/smoke.yaml"
OUT="${MAESTRO_OUT:-$ROOT/maestro-out}"
mkdir -p "$OUT"

appearance() {
  if [ "$PLATFORM" = ios ]; then
    xcrun simctl ui booted appearance "$1"
  else
    adb shell cmd uimode night "$([ "$1" = dark ] && echo yes || echo no)"
  fi
}

status=0
for mode in light dark; do
  appearance "$mode"
  echo "::group::maestro ($PLATFORM, $mode)"
  # takeScreenshot writes relative to the working directory.
  (cd "$OUT" && maestro test \
    --format junit --output "$OUT/$PLATFORM-$mode.xml" \
    -e APP_ID="$APP_ID" \
    -e EMAIL="${EMAIL:-}" \
    -e PASSWORD="${PASSWORD:-}" \
    -e SHOT_PREFIX="$PLATFORM-$mode" \
    "$FLOW") || status=1
  echo "::endgroup::"
done
exit "$status"
