#!/usr/bin/env bash
# Fail a deploy when a configured object-storage bucket does not exist (SHO-514).
#
#   verify-storage-health.sh <LABEL> <body-file>
#
# `<body-file>` is the `/api/health?storage=refresh` body. The API reports
# `storage.missing` as ENV VAR NAMES (never bucket names) for the buckets that
# return 404, and deliberately does NOT fold that into the 200/503 status: a
# short OCI blip must not drain every API pod out of the load balancer. So the
# gate lives here, in the deploy, where a missing bucket should be red.
#
# Why it is a script and not two inline `jq` pipelines: staging would catch it
# first, and US/EU carry the same gate — three copies of one rule is how the
# copies drift apart.
#
# Exit codes: 0 verified (or nothing to verify), 1 missing bucket or no body.

set -uo pipefail

LABEL="${1:?usage: verify-storage-health.sh <LABEL> <body-file>}"
BODY_FILE="${2:?usage: verify-storage-health.sh <LABEL> <body-file>}"

if [ ! -s "$BODY_FILE" ]; then
  echo "::error::${LABEL} /api/health returned no body; object storage cannot be verified"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq is not installed; cannot verify ${LABEL} object storage"
  exit 1
fi

# A body that is not JSON at all (an HTML error page from the ingress, say) must
# not read as "storage is fine".
if ! jq -e . "$BODY_FILE" >/dev/null 2>&1; then
  echo "::error::${LABEL} /api/health did not return JSON; object storage cannot be verified"
  exit 1
fi

MISSING="$(jq -r '.storage.missing // [] | join(", ")' "$BODY_FILE")"
if [ -n "$MISSING" ]; then
  echo "::error::${LABEL} object storage is missing: ${MISSING}. Apply the terraform for this environment (terraform.yml), then re-run this deploy."
  exit 1
fi

if [ "$(jq -r '.storage.ok // false' "$BODY_FILE")" = "true" ]; then
  echo "${LABEL} object storage verified"
  exit 0
fi

# No verdict at all: the release predates the probe. Warn rather than fail — the
# rollback of a bad release must not be blocked by a field it never had.
echo "::warning::${LABEL} /api/health carries no storage verdict; bucket existence was not verified on this release"
exit 0
