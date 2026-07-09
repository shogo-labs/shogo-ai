#!/usr/bin/env bash
# =============================================================================
# destroy-all-projects.sh — tear down every project on THIS metal host.
# =============================================================================
# Runs ON a bare-metal Firecracker host and calls the node-agent's local control
# API (localhost) to /destroy every project it currently holds — both the live
# (assigned) VMs and the suspended snapshots.
#
# What /destroy removes: the local VM + local snapshot artifacts + the durable
# SNAPSHOT copy in object storage (meta/vmstate/mem/rootfs diff under
# {projectId}/snapshot/). It does NOT touch the project's source archive, so the
# next open cold-boots the project fresh from S3 project source.
#
# Use this to force the whole host onto freshly-rolled guest code after a golden
# rootfs rebuild: adopted VMs keep running the OLD in-memory code until they're
# destroyed, and suspended snapshots are tied to the old rootfs. Destroying them
# guarantees the next open cold-boots on the new rootfs.
#
# Usage (on host):
#   bash destroy-all-projects.sh                 # destroy all
#   DRY_RUN=1 bash destroy-all-projects.sh       # list what WOULD be destroyed
#   METAL_AGENT_PORT=9900 bash destroy-all-projects.sh
# =============================================================================
set -euo pipefail

PORT="${METAL_AGENT_PORT:-9900}"
BASE="http://localhost:${PORT}"
DRY_RUN="${DRY_RUN:-0}"

log() { echo "[destroy-all] $*"; }

VMS_JSON="$(curl -fsS -m 10 "${BASE}/vms")" || { echo "::error:: node-agent not reachable at ${BASE}/vms"; exit 1; }

# Enumerate every project the host tracks: assigned (live) + suspended (cached).
IDS="$(printf '%s' "$VMS_JSON" | python3 -c '
import sys, json
d = json.load(sys.stdin)
ids = []
for a in d.get("assigned", []) or []:
    if a.get("projectId"): ids.append(a["projectId"])
for s in d.get("suspended", []) or []:
    if s.get("projectId"): ids.append(s["projectId"])
# De-dupe, preserve order.
seen = set()
for i in ids:
    if i not in seen:
        seen.add(i); print(i)
')"

COUNT="$(printf '%s' "$IDS" | grep -c . || true)"
log "host=$(hostname) projects to destroy: ${COUNT}"

if [[ "$COUNT" -eq 0 ]]; then
  log "nothing to destroy"
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN=1 — would destroy:"
  printf '%s\n' "$IDS" | sed 's/^/  /'
  exit 0
fi

fail=0
while IFS= read -r id; do
  [[ -n "$id" ]] || continue
  code="$(curl -s -m 45 -o /tmp/destroy_resp.json -w '%{http_code}' \
    -X POST "${BASE}/destroy" \
    -H 'content-type: application/json' \
    -d "{\"projectId\":\"${id}\"}" || echo 000)"
  if [[ "$code" == "200" ]]; then
    log "  ${id} -> OK $(cat /tmp/destroy_resp.json 2>/dev/null)"
  else
    log "  ${id} -> HTTP ${code} (continuing)"
    fail=$((fail + 1))
  fi
done <<< "$IDS"

log "done: ${COUNT} attempted, ${fail} failed"
[[ "$fail" -eq 0 ]]
