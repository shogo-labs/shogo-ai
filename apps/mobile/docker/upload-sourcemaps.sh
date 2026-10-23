#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Sentry source map upload for the web image build (apps/mobile/Dockerfile).
#
# Runs from /app/apps/mobile, where `expo export --source-maps` left ./dist.
# The image FAILS CLOSED: shipping a minified bundle whose maps never reached
# Sentry silently breaks symbolication for the whole release, so a failure is
# loud. A single transient answer is not a reason to strand a release though:
# a Sentry 502 on the one unrehearsed attempt killed Build web for v2.3.8
# (run 39573508746), which left that commit with no web image and no staging
# e2e, so its production tag could never pass the gate. Inject + upload are
# therefore retried, and only a third failure fails the build.
set -eu

ATTEMPTS=3

if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
  if [ "${REQUIRE_SENTRY_UPLOAD:-false}" = "true" ] || [ "${EXPO_PUBLIC_APP_ENV#production}" != "${EXPO_PUBLIC_APP_ENV:-}" ]; then
    echo "ERROR: SENTRY_AUTH_TOKEN is empty on a deploy build (REQUIRE_SENTRY_UPLOAD=${REQUIRE_SENTRY_UPLOAD:-}, EXPO_PUBLIC_APP_ENV=${EXPO_PUBLIC_APP_ENV:-})." >&2
    echo "Refusing to ship a web bundle whose source maps never reach Sentry — production_web issues would be unsymbolicated and .map files would leak publicly. Configure SENTRY_AUTH_TOKEN (project:releases scope) for this deploy environment." >&2
    exit 1
  fi
  echo "SENTRY_AUTH_TOKEN not set — skipping Sentry source map upload (non-production build)"
  exit 0
fi

RELEASE="${EXPO_PUBLIC_BUILD_HASH:-dev}"
ORG="${SENTRY_ORG:-shogo-ai}"
PROJECT="${SENTRY_PROJECT:-javascript-react}"

attempt=1
while : ; do
  if sentry-cli sourcemaps inject --release "$RELEASE" ./dist &&
     sentry-cli sourcemaps upload --org "$ORG" --project "$PROJECT" --release "$RELEASE" ./dist; then
    # .map files stay in the image until the upload succeeded, so a retry still
    # has something to send.
    find ./dist -name '*.map' -delete
    echo "Uploaded source maps for release $RELEASE to $ORG/$PROJECT"
    exit 0
  fi

  echo "Sentry source map upload attempt $attempt/$ATTEMPTS failed for release $RELEASE; keeping ./dist/*.map for the next attempt." >&2
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "ERROR: SENTRY_AUTH_TOKEN is set but the Sentry source map upload failed $ATTEMPTS times for release $RELEASE (last attempt $attempt; same settings as the successful path)." >&2
    echo "Refusing to ship a web bundle whose source maps never reach Sentry — production_web issues would be unsymbolicated and .map files would leak publicly. Configure SENTRY_AUTH_TOKEN (project:releases scope) for this deploy environment." >&2
    exit 1
  fi

  case "$attempt" in
    1) sleep 2 ;;
    *) sleep 8 ;;
  esac
  attempt=$((attempt + 1))
done
