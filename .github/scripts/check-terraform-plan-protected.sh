#!/usr/bin/env bash
# =============================================================================
# Fails a terraform plan that would REPLACE or DELETE infrastructure that must
# never be replaced (SHO-515).
# =============================================================================
# Why: a single forced replacement of the published-apps PAR, the `*.shogo.one`
# wildcard record or the published-apps Worker route takes every published site
# offline; replacing a data bucket (workspaces, pg-backups, published-apps,
# published-data, project-buckets, studio web-assets) loses data. Those
# resources also carry `prevent_destroy = true`, so a replacement would fail the
# apply anyway — this check fails it at plan time, on the PR, where it is cheap
# to notice.
#
# Usage: check-terraform-plan-protected.sh <plan.json>
#   <plan.json> is the output of `terraform show -json <saved plan>`.
#
# Exits 0 when nothing protected is replaced; 1 otherwise (with one ::error::
# annotation per offending resource, which GitHub renders inline on the PR).
set -euo pipefail

plan_json="${1:?usage: check-terraform-plan-protected.sh <plan.json>}"

if [ ! -s "$plan_json" ]; then
  echo "::error::plan JSON is missing or empty ($plan_json); cannot verify protected resources."
  exit 1
fi

# Resource types whose replacement/removal is an outage or data loss.
protected_types='^(oci_objectstorage_bucket|oci_objectstorage_preauthrequest|oci_objectstorage_object_lifecycle_policy|cloudflare_record|cloudflare_worker_route|cloudflare_workers_route|cloudflare_custom_hostname_fallback_origin|cloudflare_zone_settings_override)$'

# `deposed` entries are cleanup of a superseded object instance, not a destroy
# of the live resource: the live instance was already replaced in an earlier
# apply. Ignore them so historical drift doesn't block every future plan.
violations="$(
  jq -r --arg re "$protected_types" '
    [ .resource_changes // []
      | .[]
      | select((.deposed // null) == null)
      | select(.change.actions | any(. == "replace" or . == "delete"))
      | select(.type | test($re))
      | "\(.address)  [\(.type)]  actions=\(.change.actions | join("+"))"
    ] | .[]
  ' "$plan_json"
)"

if [ -n "$violations" ]; then
  while IFS= read -r line; do
    echo "::error::plan would replace or destroy protected infrastructure: $line"
  done <<<"$violations"
  echo
  echo "Protected resources are listed in docs/runbooks/terraform.md."
  echo "If a replacement is genuinely intended, it needs a human decision (and the"
  echo "resource's prevent_destroy lifted in the same change) — do not merge this."
  exit 1
fi

echo "No protected replacement or destroy in $(basename "$plan_json")."
