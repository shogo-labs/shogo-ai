#!/usr/bin/env bash
# =============================================================================
# audit-runtime-digests.sh
# =============================================================================
# Audits whether every runtime image digest currently referenced by the
# Knative warm-pool / project ksvc in the active kubectl context still exists
# in OCIR. Detects the failure mode that caused the staging incident on
# 2026-05-04 (cleanup-ocir.yml pruned digests that running revisions were
# pinned to → ImagePullBackOff "manifest unknown" on every pod restart).
#
# Run this BEFORE the next scheduled cleanup runs (Sundays 04:00 UTC) — and
# any time you suspect drift between OCIR contents and live revisions.
#
# Usage:
#   ./scripts/audit-runtime-digests.sh                          # current context
#   KUBECONTEXT=oke-staging ./scripts/audit-runtime-digests.sh  # specific context
#   ./scripts/audit-runtime-digests.sh --all                    # all 4 contexts
#
# Required env (per OKE region):
#   OCI_CLI_USER, OCI_CLI_TENANCY, OCI_CLI_FINGERPRINT,
#   OCI_CLI_KEY_FILE (or OCI_CLI_KEY_CONTENT), OCI_CLI_REGION
#
# Or just `oci setup config` previously.
# =============================================================================

set -uo pipefail

ALL=false
if [ "${1:-}" = "--all" ]; then
  ALL=true
fi

REPOS=(
  "shogo/shogo-runtime"
  "shogo/shogo-api"
  "shogo/shogo-web"
  "shogo/shogo-docs"
)

audit_context() {
  local ctx="$1"
  echo ""
  echo "============================================"
  echo "Context: $ctx"
  echo "============================================"

  if ! kubectl --context="$ctx" get nodes >/dev/null 2>&1; then
    echo "  ! Cannot reach cluster (skipping)"
    return 1
  fi

  # Collect all in-use digests from cluster
  local IN_USE
  IN_USE=$(mktemp)
  trap 'rm -f "$IN_USE"' RETURN

  {
    kubectl --context="$ctx" get ksvc,configurations,revisions -A -o json 2>/dev/null \
      | jq -r '.items[].spec.template.spec.containers[]?.image // empty,
               .items[].spec.containers[]?.image // empty'
    kubectl --context="$ctx" get deployments,statefulsets,daemonsets,replicasets,jobs,cronjobs -A -o json 2>/dev/null \
      | jq -r '.items[].spec.template.spec.containers[]?.image // empty,
               .items[].spec.jobTemplate.spec.template.spec.containers[]?.image // empty'
    kubectl --context="$ctx" get pods -A -o json 2>/dev/null \
      | jq -r '.items[].status.containerStatuses[]?.imageID // empty'
  } | grep -E "ocir.io/.*shogo/(shogo-runtime|shogo-api|shogo-web|shogo-docs)" \
    | sort -u > "$IN_USE"

  local TOTAL
  TOTAL=$(wc -l < "$IN_USE" | tr -d ' ')
  echo "  Found $TOTAL distinct image references in cluster"

  if [ "$TOTAL" -eq 0 ]; then
    return 0
  fi

  # Check each digest against OCIR
  local missing=0
  local checked=0
  while IFS= read -r ref; do
    # Only audit digest-pinned references; tag-only refs are out of scope
    local digest
    digest=$(echo "$ref" | grep -oE 'sha256:[a-f0-9]{64}' || true)
    if [ -z "$digest" ]; then
      continue
    fi
    local repo
    repo=$(echo "$ref" | sed -E 's|^[^/]+/[^/]+/||; s|@sha256:.*$||; s|:.*$||')
    checked=$((checked + 1))

    # Look up by digest using image-summary
    if oci artifacts container image list \
        --compartment-id "${OCI_CLI_TENANCY:-${OCI_TENANCY_OCID:-}}" \
        --repository-name "$repo" \
        --version "$digest" \
        --query 'data.items | length(@)' \
        --raw-output 2>/dev/null | grep -q '^[1-9]'; then
      :  # exists
    else
      # Fall back: list all and grep
      if oci artifacts container image list \
          --compartment-id "${OCI_CLI_TENANCY:-${OCI_TENANCY_OCID:-}}" \
          --repository-name "$repo" \
          --all \
          --query "data.items[?contains(\"display-name\", '$digest')] | length(@)" \
          --raw-output 2>/dev/null | grep -q '^[1-9]'; then
        :
      else
        missing=$((missing + 1))
        echo "  MISSING: $ref"
      fi
    fi
  done < "$IN_USE"

  echo "  Checked $checked digest-pinned references; $missing missing from OCIR"
  if [ "$missing" -gt 0 ]; then
    echo "  ! Risk: $missing pod(s) will fail to pull on restart."
    echo "  ! Either re-push the affected images, or delete the broken revisions"
    echo "    so the warm-pool controller can replace them on a current digest."
    return 2
  fi
}

CONTEXTS=()
if [ "$ALL" = "true" ]; then
  CONTEXTS=(oke-staging oke-production-us oke-production-eu oke-production-india)
elif [ -n "${KUBECONTEXT:-}" ]; then
  CONTEXTS=("$KUBECONTEXT")
else
  CONTEXTS=("$(kubectl config current-context)")
fi

EXIT=0
for ctx in "${CONTEXTS[@]}"; do
  audit_context "$ctx" || EXIT=$?
done

exit "$EXIT"
