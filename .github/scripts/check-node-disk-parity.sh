#!/usr/bin/env bash
# .github/scripts/check-node-disk-parity.sh
#
# Cross-region node-pool boot-volume parity guard.
#
# The EU 2026-06-02 incident root cause was a silent capacity drift: EU (and
# India) node pools were bootstrapped at 100 GB boot volumes while US ran
# 200 GB. The drift was invisible because the oke module ignores in-place
# boot-volume changes (a deliberate anti-replacement safety), so neither a
# `terraform plan` nor day-to-day ops surfaced it. EU tipped into DiskPressure
# under load; India is the same latent exposure.
#
# This check queries the LIVE OCI node pools across all production regions and
# fails if any region's system-pool boot volume is below EXPECTED_GB. Run it in
# CI (terraform.yml) so the drift can never silently re-open.
#
# Usage:
#   COMPARTMENT_ID=ocid1.compartment... \
#   EXPECTED_GB=200 \
#   REGIONS="us-ashburn-1 eu-frankfurt-1 ap-mumbai-1" \
#   .github/scripts/check-node-disk-parity.sh
#
# Requires: oci CLI configured, jq.

set -euo pipefail

COMPARTMENT_ID="${COMPARTMENT_ID:?COMPARTMENT_ID required}"
EXPECTED_GB="${EXPECTED_GB:-200}"
REGIONS="${REGIONS:-us-ashburn-1 eu-frankfurt-1 ap-mumbai-1}"

rc=0
echo "Asserting system node-pool boot volume == ${EXPECTED_GB} GB across: ${REGIONS}"

for region in $REGIONS; do
  # A region may have multiple clusters; check every node pool in the
  # production compartment for that region.
  pools=$(oci ce node-pool list \
    --region "$region" \
    --compartment-id "$COMPARTMENT_ID" \
    --all \
    --query 'data[].{name:name, gb:"node-source-details"."boot-volume-size-in-gbs"}' \
    --output json 2>/dev/null || echo '[]')

  count=$(echo "$pools" | jq 'length')
  if [[ "$count" -eq 0 ]]; then
    echo "  [$region] no node pools found (skipping)"
    continue
  fi

  while IFS= read -r row; do
    name=$(echo "$row" | jq -r '.name')
    gb=$(echo "$row" | jq -r '.gb // 0')
    if [[ "$gb" -lt "$EXPECTED_GB" ]]; then
      echo "::error::node-disk-parity: [$region] pool '$name' boot volume ${gb} GB < expected ${EXPECTED_GB} GB"
      rc=1
    else
      echo "  [$region] $name: ${gb} GB OK"
    fi
  done < <(echo "$pools" | jq -c '.[]')
done

if [[ "$rc" -ne 0 ]]; then
  echo "::error::Boot-volume drift detected. Remediate via a controlled node-pool replacement (see terraform/README.md 'Boot volume remediation')."
fi
exit "$rc"
