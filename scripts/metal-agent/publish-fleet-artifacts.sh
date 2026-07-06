#!/usr/bin/env bash
# =============================================================================
# publish-fleet-artifacts.sh — build + upload the "fleet bundle" that
# auto-provisioned burst hosts fetch on first boot.
# =============================================================================
# The bundle is TINY (scripts + node-agent TypeScript source) — the big rootfs
# is built on-box from the OCIR image, so it never needs shipping. Contents:
#   scripts/metal-agent/host-bootstrap.sh
#   scripts/metal-agent/build-runtime-rootfs.sh
#   scripts/metal-agent/provision-burst-host.sh
#   apps/metal-agent/{src/*.ts,package.json,tsconfig.json}
#
# It's uploaded to the durable snapshot bucket under metal-fleet/<version>/ and a
# pre-authenticated (read-only, expiring) URL is created so cloud-init can curl
# it without S3 signing. Set that URL as METAL_FLEET_BUNDLE_URL on the API.
#
# The bundle carries NO secrets (all repo content). Secrets (register token, S3
# creds, OCIR config) are injected by the generated user_data at boot.
#
# Requires: OCI CLI (`oci`) configured, or pass PUBLISH_MODE=aws to use awscli
# against the S3-compat endpoint. Env:
#   S3_BUCKET (default shogo-workspaces-staging)
#   S3_PREFIX (default metal-fleet)
#   OCI_NAMESPACE (for oci mode; default idin4oltblww)
#   PAR_TTL_DAYS (default 365)
#   VERSION   (default: git short sha)
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
S3_BUCKET="${S3_BUCKET:-shogo-workspaces-staging}"
S3_PREFIX="${S3_PREFIX:-metal-fleet}"
OCI_NAMESPACE="${OCI_NAMESPACE:-idin4oltblww}"
PAR_TTL_DAYS="${PAR_TTL_DAYS:-365}"
VERSION="${VERSION:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
PUBLISH_MODE="${PUBLISH_MODE:-oci}"
log() { echo "[publish-fleet] $*"; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/scripts/metal-agent" "$STAGE/apps/metal-agent/src"

cp "$REPO_ROOT"/scripts/metal-agent/host-bootstrap.sh \
   "$REPO_ROOT"/scripts/metal-agent/build-runtime-rootfs.sh \
   "$REPO_ROOT"/scripts/metal-agent/provision-burst-host.sh \
   "$STAGE/scripts/metal-agent/"
cp "$REPO_ROOT"/apps/metal-agent/src/*.ts "$STAGE/apps/metal-agent/src/"
cp "$REPO_ROOT"/apps/metal-agent/package.json "$REPO_ROOT"/apps/metal-agent/tsconfig.json "$STAGE/apps/metal-agent/"

BUNDLE="$STAGE/metal-fleet-bundle.tgz"
tar -C "$STAGE" -czf "$BUNDLE" scripts apps
log "bundle built: $(du -h "$BUNDLE" | cut -f1) ($VERSION)"

OBJECT="$S3_PREFIX/$VERSION/metal-fleet-bundle.tgz"

if [ "$PUBLISH_MODE" = "oci" ]; then
  command -v oci >/dev/null || { log "ERROR: oci CLI not found (set PUBLISH_MODE=aws to use awscli)"; exit 2; }
  log "uploading oci://$S3_BUCKET/$OBJECT ..."
  oci os object put -bn "$S3_BUCKET" -ns "$OCI_NAMESPACE" --name "$OBJECT" --file "$BUNDLE" --force >/dev/null
  EXPIRES="$(date -u -v +"${PAR_TTL_DAYS}"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+${PAR_TTL_DAYS} days" +%Y-%m-%dT%H:%M:%SZ)"
  log "creating pre-authenticated request (expires $EXPIRES)..."
  PAR_PATH="$(oci os preauth-request create -bn "$S3_BUCKET" -ns "$OCI_NAMESPACE" \
    --name "metal-fleet-$VERSION" --access-type ObjectRead --object-name "$OBJECT" \
    --time-expires "$EXPIRES" --query 'data."access-uri"' --raw-output)"
  REGION_HOST="$(echo "${S3_ENDPOINT:-https://${OCI_NAMESPACE}.compat.objectstorage.us-ashburn-1.oraclecloud.com}" | sed -E 's#https?://[^.]+\.compat#https://objectstorage#')"
  PAR_URL="${REGION_HOST%/}${PAR_PATH}"
else
  command -v aws >/dev/null || { log "ERROR: aws CLI not found"; exit 2; }
  : "${S3_ENDPOINT:?set S3_ENDPOINT for aws mode}"
  log "uploading s3://$S3_BUCKET/$OBJECT via $S3_ENDPOINT ..."
  aws --endpoint-url "$S3_ENDPOINT" s3 cp "$BUNDLE" "s3://$S3_BUCKET/$OBJECT" >/dev/null
  PAR_URL="(aws mode: create a presigned URL or PAR out-of-band for $S3_BUCKET/$OBJECT)"
fi

echo
log "PUBLISHED $VERSION"
echo "  object:  $S3_BUCKET/$OBJECT"
echo "  set on the API:  METAL_FLEET_BUNDLE_URL=$PAR_URL"
echo "                   METAL_FLEET_RUNTIME_IMAGE=<the amd64 runtime image tag>"
