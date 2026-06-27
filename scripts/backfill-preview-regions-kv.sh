#!/usr/bin/env bash
# scripts/backfill-preview-regions-kv.sh
#
# One-time migration helper for the preview-router cutover (Option 1).
#
# The `preview--*.shogo.ai` router Worker resolves each preview to its hosting
# region by reading `projectId -> region` from the PREVIEW_REGIONS Workers KV
# namespace. Newly-created previews get their KV entry written by the API
# (apps/api/src/lib/cloudflare-preview-region-kv.ts), but previews that already
# exist at cutover time have NO entry yet. Until this backfill runs, the Worker
# falls back to the US anchor for those — which silently breaks live EU/India
# previews.
#
# Run this ONCE, right after `terraform apply` creates the KV namespace and
# BEFORE (or immediately as) the Worker route goes live, to seed the region of
# every currently-live preview across all three clusters.
#
# It is idempotent (KV PUT is last-writer-wins) and safe to re-run.
#
# Requires: kubectl (with contexts for all 3 regions), curl, jq, awk.
#
# Usage:
#   CF_API_TOKEN=<kv-capable-token> \
#   CF_ACCOUNT_ID=<account-id> \
#   CF_PREVIEW_REGIONS_KV_NAMESPACE_ID=<namespace-id> \
#   scripts/backfill-preview-regions-kv.sh [--dry-run]
#
# The kube context for each region is configurable via env (defaults match the
# current cluster set); region codes map us|eu|in.

set -uo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${CF_PREVIEW_REGIONS_KV_NAMESPACE_ID:?set CF_PREVIEW_REGIONS_KV_NAMESPACE_ID}"
CF_TOKEN="${CF_API_TOKEN:-${CF_CUSTOM_HOSTNAMES_TOKEN:-}}"
: "${CF_TOKEN:?set CF_API_TOKEN (or CF_CUSTOM_HOSTNAMES_TOKEN) to a token with Workers KV Storage:Edit}"

# region_code => kube context. Override via env to match your kubeconfig.
US_CONTEXT="${US_CONTEXT:-context-cp7l2tcj76q}"
EU_CONTEXT="${EU_CONTEXT:-context-cbbetkypxva}"
IN_CONTEXT="${IN_CONTEXT:-context-c4w44igvdfa}"

CF_API="https://api.cloudflare.com/client/v4"
KV_BASE="$CF_API/accounts/$CF_ACCOUNT_ID/storage/kv/namespaces/$CF_PREVIEW_REGIONS_KV_NAMESPACE_ID/values"

put_kv() { # $1=projectId $2=region
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  [dry-run] PUT $1 -> $2"
    return 0
  fi
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$KV_BASE/$1" \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: text/plain" \
    --data "$2")
  if [[ "$code" == "200" ]]; then echo "  ok    $1 -> $2"; else echo "  FAIL  $1 -> $2 (HTTP $code)"; return 1; fi
}

backfill_region() { # $1=region_code $2=context
  local region="$1" ctx="$2" n=0
  echo "=== region=$region context=$ctx ==="
  # DomainMapping names are `preview--{projectId}.shogo.ai`; strip prefix+suffix
  # to recover the bare projectId the Worker keys on.
  while read -r host; do
    [[ -z "$host" ]] && continue
    local pid="${host#preview--}"; pid="${pid%%.*}"
    [[ -z "$pid" ]] && continue
    put_kv "$pid" "$region" && n=$((n + 1))
  done < <(kubectl --context="$ctx" get domainmappings.serving.knative.dev -A --no-headers 2>/dev/null \
            | awk '{print $2}' | grep '^preview--')
  echo "  seeded: $n"
}

echo "Backfilling PREVIEW_REGIONS KV (namespace $CF_PREVIEW_REGIONS_KV_NAMESPACE_ID)"
[[ "$DRY_RUN" == "1" ]] && echo "(dry run — no writes)"
echo
backfill_region us "$US_CONTEXT"
backfill_region eu "$EU_CONTEXT"
backfill_region in "$IN_CONTEXT"
echo
echo "Done."
