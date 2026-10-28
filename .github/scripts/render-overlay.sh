#!/usr/bin/env bash
# .github/scripts/render-overlay.sh <environment>
#
# Render k8s/overlays/<environment> with its deploy-time placeholders filled
# in, and print the manifests on stdout (nothing at all on failure).
#
# kustomize drops the quotes around `value: "X_PLACEHOLDER"`, so every value is
# written back quoted. Unquoted, a numeric value (the Facebook Pixel ID) reaches
# the API server as a number, and Knative rejects a non-string env value.
#
# Env: RUNTIME_IMAGE (required), APP_VERSION, GA4_MEASUREMENT_ID, FB_PIXEL_ID

set -euo pipefail

ENVIRONMENT="${1:?usage: $0 <environment>}"
: "${RUNTIME_IMAGE:?RUNTIME_IMAGE required}"

for name in RUNTIME_IMAGE APP_VERSION GA4_MEASUREMENT_ID FB_PIXEL_ID; do
  value="${!name:-}"
  if [[ ! "$value" =~ ^[A-Za-z0-9_.:/@+-]*$ ]]; then
    echo "::error::$name contains characters that can't be rendered into a manifest" >&2
    exit 1
  fi
done

placeholder() { printf 's#(value: )"?%s"?$#\\1"%s"#' "$1" "$2"; }

RENDERED=$(kubectl kustomize "k8s/overlays/${ENVIRONMENT}/" | sed -E \
  -e "$(placeholder RUNTIME_IMAGE_PLACEHOLDER "$RUNTIME_IMAGE")" \
  -e "$(placeholder SHOGO_APP_VERSION_PLACEHOLDER "${APP_VERSION:-}")" \
  -e "$(placeholder APP_VERSION_PLACEHOLDER "${APP_VERSION:-}")" \
  -e "$(placeholder GA4_MEASUREMENT_ID_PLACEHOLDER "${GA4_MEASUREMENT_ID:-}")" \
  -e "$(placeholder FB_PIXEL_ID_PLACEHOLDER "${FB_PIXEL_ID:-}")")

if left=$(grep -n '_PLACEHOLDER' <<<"$RENDERED"); then
  echo "::error::Unrendered placeholder(s) in k8s/overlays/${ENVIRONMENT}:" >&2
  echo "$left" >&2
  exit 1
fi

printf '%s\n' "$RENDERED"
