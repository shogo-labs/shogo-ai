#!/usr/bin/env bash
set -euo pipefail

if [ -z "${FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64:-}" ]; then
  echo "::error::Missing FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64 GitHub secret. Add the Firebase client google-services.json for ai.shogo.mobile, base64-encoded."
  exit 1
fi

firebase_config="apps/mobile/google-services.json"
firebase_config_tmp=$(mktemp "${firebase_config}.XXXXXX")
trap 'rm -f "$firebase_config_tmp"' EXIT
printf '%s' "$FIREBASE_ANDROID_GOOGLE_SERVICES_JSON_BASE64" | base64 --decode > "$firebase_config_tmp"
if ! jq -e '(.project_info.project_id == "shogo-android-push") and ([.client[]? | select(.client_info.android_client_info.package_name == "ai.shogo.mobile")] | length > 0)' "$firebase_config_tmp" >/dev/null; then
  echo "::error::Firebase google-services.json must belong to shogo-android-push and contain Android package ai.shogo.mobile."
  exit 1
fi

mv "$firebase_config_tmp" "$firebase_config"
echo "Firebase Android client config is ready"
