#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
# =============================================================================
# deploy-fleet.sh — push the CURRENT git tree's node-agent to a running metal
# host and restart it, with a health + registration gate. This is the piece the
# metal-agent-deploy.yml workflow runs per-host, and the same script an operator
# can run by hand for a one-off deploy.
# =============================================================================
# Unlike deploy-real-image.sh (which bakes a rootfs and runs an e2e), this does
# a fast, idempotent SERVICE deploy:
#   1. ship apps/metal-agent/{src,package.json,tsconfig.json} to /opt/metal-agent
#      (staged, then swapped, so a mid-copy failure never leaves a torn tree);
#   2. optionally patch METAL_IDLE_SUSPEND_MS in /etc/metal-agent.env;
#   3. optionally rebuild the runtime rootfs from a new RUNTIME_IMAGE (heavy —
#      invalidates existing snapshots, so it is opt-in);
#   4. install a `KillMode=process` drop-in, then `systemctl restart metal-agent`
#      as a GRACEFUL ROLLING restart;
#   5. gate on `systemctl is-active` + /vms, and assert live microVMs SURVIVED
#      the restart (assigned set before ≈ after).
#
# ROLLING DEPLOY (why VMs survive): the unit runs `KillMode=process`, so systemd
# signals only the agent — the firecracker children are reparented to init and
# keep running. On SIGTERM the agent releases just its warm pool; on restart the
# new instance re-adopts the live VMs from a durable on-disk registry (pid + API
# socket + guest health checks) and re-asserts their DNAT rules. Assigned
# projects therefore keep serving across the deploy and pick up the new code on
# their next suspend→resume. A VM whose guest is unhealthy is reaped and cold-
# resumes on next open. (REBUILD_ROOTFS is the exception: a new golden rootfs
# invalidates snapshots, so those projects cold-boot rather than resume.)
#
# Usage:
#   SSH_TARGET=root@72.46.85.83 bash scripts/metal-agent/deploy-fleet.sh
# Env:
#   SSH_TARGET (required)   user@host
#   SSH_KEY                 identity file (optional; else default agent/keys)
#   IDLE_SUSPEND_MS         if set, patch METAL_IDLE_SUSPEND_MS to this value
#   REBUILD_ROOTFS          "true" to rebuild runtime.ext4 (default false)
#   RUNTIME_IMAGE           image ref to bake when REBUILD_ROOTFS=true
#   DOCKER_CONFIG_B64       base64 OCIR docker config.json (rootfs rebuild auth)
#   HEALTH_TIMEOUT_S        seconds to wait for the agent to come back (default 90)
#   AGENT_PORT              agent HTTP port (default 9900)
# =============================================================================
set -euo pipefail

: "${SSH_TARGET:?set SSH_TARGET=user@host}"
SSH_KEY="${SSH_KEY:-}"
IDLE_SUSPEND_MS="${IDLE_SUSPEND_MS:-}"
REBUILD_ROOTFS="${REBUILD_ROOTFS:-false}"
RUNTIME_IMAGE="${RUNTIME_IMAGE:-}"
DOCKER_CONFIG_B64="${DOCKER_CONFIG_B64:-}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-90}"
AGENT_PORT="${AGENT_PORT:-9900}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AGENT_DIR="$REPO_ROOT/apps/metal-agent"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o BatchMode=yes)
[[ -n "$SSH_KEY" ]] && SSH_OPTS+=(-i "$SSH_KEY")
ssh_() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }

log() { echo "[deploy-fleet] $*"; }
fail() { echo "[deploy-fleet] ERROR: $*" >&2; exit 1; }

# Print the sorted projectIds of currently-assigned (live) microVMs, one per
# line. Parses the agent's /vms JSON with python3 (present on the runner).
assigned_ids() {
  ssh_ "curl -fsS -m 5 localhost:$AGENT_PORT/vms" 2>/dev/null \
    | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
for a in d.get("assigned",[]):
    pid=a.get("projectId")
    if pid: print(pid)' 2>/dev/null | sort -u || true
}

[[ -d "$AGENT_DIR/src" ]] || fail "no agent source at $AGENT_DIR/src"

log "target=$SSH_TARGET rebuildRootfs=$REBUILD_ROOTFS idleSuspendMs=${IDLE_SUSPEND_MS:-<unchanged>}"

# --- 0. Preflight: reachable, agent installed, bun present -------------------
log "preflight..."
ssh_ 'test -d /opt/metal-agent && test -x /usr/local/bin/bun && systemctl cat metal-agent >/dev/null' \
  || fail "host not bootstrapped (need /opt/metal-agent, bun, metal-agent.service). Run host-bootstrap.sh first."

# Record the version we're deploying so it's visible on the host + in logs.
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "deploying git sha=$GIT_SHA"

# --- 1. Ship agent source (staged, then atomic swap) ------------------------
log "shipping node-agent source ($(ls "$AGENT_DIR/src"/*.ts | wc -l | tr -d ' ') files)..."
tar -czf - -C "$AGENT_DIR" src package.json tsconfig.json \
  | ssh_ "set -e
      rm -rf /opt/metal-agent.stage && mkdir -p /opt/metal-agent.stage
      tar -xzf - -C /opt/metal-agent.stage
      echo '$GIT_SHA' > /opt/metal-agent.stage/DEPLOYED_SHA
      # Atomic-ish swap: replace src wholesale (drops removed files), refresh manifests.
      rm -rf /opt/metal-agent/src
      cp -a /opt/metal-agent.stage/src /opt/metal-agent/src
      cp -a /opt/metal-agent.stage/package.json /opt/metal-agent/package.json
      cp -a /opt/metal-agent.stage/tsconfig.json /opt/metal-agent/tsconfig.json
      cp -a /opt/metal-agent.stage/DEPLOYED_SHA /opt/metal-agent/DEPLOYED_SHA
      rm -rf /opt/metal-agent.stage
      if [ -f /opt/metal-agent/package.json ]; then
        (cd /opt/metal-agent && /usr/local/bin/bun install --production >/dev/null 2>&1 || true)
      fi"

# --- 2. Optional: patch the idle-suspend window in the env file --------------
if [[ -n "$IDLE_SUSPEND_MS" ]]; then
  [[ "$IDLE_SUSPEND_MS" =~ ^[0-9]+$ ]] || fail "IDLE_SUSPEND_MS must be an integer (ms)"
  log "patching METAL_IDLE_SUSPEND_MS=$IDLE_SUSPEND_MS in /etc/metal-agent.env..."
  ssh_ "set -e
      f=/etc/metal-agent.env
      cp -a \"\$f\" \"\$f.bak.\$(date -u +%Y%m%dT%H%M%SZ)\"
      if grep -q '^METAL_IDLE_SUSPEND_MS=' \"\$f\"; then
        sed -i 's/^METAL_IDLE_SUSPEND_MS=.*/METAL_IDLE_SUSPEND_MS=$IDLE_SUSPEND_MS/' \"\$f\"
      else
        echo 'METAL_IDLE_SUSPEND_MS=$IDLE_SUSPEND_MS' >> \"\$f\"
      fi
      grep '^METAL_IDLE_SUSPEND_MS=' \"\$f\""
fi

# --- 3. Optional: rebuild the runtime rootfs from a new image ----------------
if [[ "$REBUILD_ROOTFS" == "true" ]]; then
  [[ -n "$RUNTIME_IMAGE" ]] || fail "REBUILD_ROOTFS=true requires RUNTIME_IMAGE"
  log "rebuilding runtime.ext4 from $RUNTIME_IMAGE (this invalidates existing snapshots)..."
  if [[ -n "$DOCKER_CONFIG_B64" ]]; then
    echo "$DOCKER_CONFIG_B64" | ssh_ "set -e; install -d /root/.docker-ocir; base64 -d > /root/.docker-ocir/config.json"
  fi
  tar -czf - -C "$REPO_ROOT/scripts/metal-agent" build-runtime-rootfs.sh \
    | ssh_ "set -e; tar -xzf - -C /root"
  ssh_ "set -e
      WORK=\$(grep -E '^METAL_WORK=' /etc/metal-agent.env | cut -d= -f2)
      WORK=\${WORK:-/opt/fc-spike}
      RUNTIME_IMAGE='$RUNTIME_IMAGE' DOCKER_CONFIG=/root/.docker-ocir OUT=\$WORK/img/runtime.ext4 \
        bash /root/build-runtime-rootfs.sh"
fi

# --- 4. Ensure the unit restarts GRACEFULLY (KillMode=process drop-in) -------
# A drop-in guarantees graceful behaviour regardless of the base unit version
# baked at bootstrap time: systemd signals only the agent, so firecracker
# children survive and the new instance re-adopts them.
log "ensuring KillMode=process drop-in..."
ssh_ "set -e
    install -d /etc/systemd/system/metal-agent.service.d
    cat > /etc/systemd/system/metal-agent.service.d/10-rolling.conf <<'DROPIN'
[Service]
KillMode=process
TimeoutStopSec=30
DROPIN"

# Snapshot the live (assigned) microVMs BEFORE the restart so we can prove they
# survive it. Skipped when rebuilding the rootfs (that intentionally cold-boots).
BEFORE_IDS=""
if [[ "$REBUILD_ROOTFS" != "true" ]]; then
  BEFORE_IDS="$(assigned_ids)"
fi
before_n=$(printf '%s' "$BEFORE_IDS" | grep -c . || true)
log "assigned microVMs before restart: ${before_n}"

# --- 4b. Restart + health/registration gate ---------------------------------
log "rolling-restart metal-agent (live VMs kept alive)..."
ssh_ 'systemctl daemon-reload; systemctl restart metal-agent'

log "waiting up to ${HEALTH_TIMEOUT_S}s for the agent to serve /vms..."
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
ok=false
while [[ $(date +%s) -lt $deadline ]]; do
  if ssh_ "systemctl is-active --quiet metal-agent && curl -fsS -m 5 localhost:$AGENT_PORT/vms >/dev/null 2>&1"; then
    ok=true; break
  fi
  sleep 3
done
$ok || { ssh_ 'journalctl -u metal-agent --no-pager | tail -40' || true; fail "metal-agent did not become healthy in ${HEALTH_TIMEOUT_S}s"; }

# --- 4c. Assert the live microVMs were re-adopted (survived the deploy) ------
if [[ "$REBUILD_ROOTFS" != "true" && "$before_n" -gt 0 ]]; then
  # Adoption health-checks each guest; give it a moment to settle post-restart.
  sleep 3
  AFTER_IDS="$(assigned_ids)"
  survived=$(comm -12 <(printf '%s\n' "$BEFORE_IDS" | sort -u) <(printf '%s\n' "$AFTER_IDS" | sort -u) | grep -c . || true)
  lost=$(comm -23 <(printf '%s\n' "$BEFORE_IDS" | sort -u) <(printf '%s\n' "$AFTER_IDS" | sort -u) | grep -c . || true)
  log "rolling-restart adoption: ${survived}/${before_n} live microVM(s) survived (lost=${lost})"
  if [[ "$lost" -gt 0 ]]; then
    log "WARNING: ${lost} microVM(s) were not re-adopted (guest unhealthy, or suspended during the window); they cold-resume on next open:"
    comm -23 <(printf '%s\n' "$BEFORE_IDS" | sort -u) <(printf '%s\n' "$AFTER_IDS" | sort -u) | sed 's/^/    - /'
  fi
fi

# --- 5. Report deployed state -----------------------------------------------
log "deployed. host state:"
ssh_ "set -e
    echo -n '  deployed sha: '; cat /opt/metal-agent/DEPLOYED_SHA 2>/dev/null || echo unknown
    echo -n '  active:       '; systemctl is-active metal-agent
    echo -n '  killmode:     '; systemctl show -p KillMode --value metal-agent
    echo -n '  idleSuspendMs:'; curl -fsS -m 5 localhost:$AGENT_PORT/vms | sed -E 's/.*\"idleSuspendMs\":([0-9]+).*/ \1/'
    echo -n '  pool avail:   '; curl -fsS -m 5 localhost:$AGENT_PORT/vms | sed -E 's/.*\"available\":([0-9]+).*/\1/'
    echo -n '  assigned:     '; curl -fsS -m 5 localhost:$AGENT_PORT/vms | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get(\"assigned\",[])))' 2>/dev/null || echo '?'"
log "OK: $SSH_TARGET now running sha=$GIT_SHA"
