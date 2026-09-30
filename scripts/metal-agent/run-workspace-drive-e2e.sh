#!/usr/bin/env bash
# =============================================================================
# run-workspace-drive-e2e.sh — per-VM workspace drive e2e on a metal host.
# =============================================================================
# Bakes the runtime image into a rootfs with THIS checkout's fc-init (the one
# that mounts the workspace drive), in an isolated work dir so the host's live
# pool and golden image are untouched, then runs
# apps/metal-agent/src/e2e-workspace-drive.ts against it in dm mode with the fs
# durable store. See that file for what it proves.
#
# Usage:
#   SSH_TARGET=root@<host> bash scripts/metal-agent/run-workspace-drive-e2e.sh
# Env:
#   SSH_TARGET (required)  user@host
#   SSH_KEY                identity file
#   LIVE_WORK              the host's live metal work dir, for firecracker + kernel (default /opt/fc-spike)
#   E2E_WORK               isolated work dir for this run (default /opt/fc-wsdrive-e2e)
#   REBUILD                1 = rebake the rootfs even if one exists (default 1)
#   DRIVE_MIB              workspace drive size (default 20480)
#   MEM_MIB                microVM memory (default 4096)
# =============================================================================
set -euo pipefail

: "${SSH_TARGET:?set SSH_TARGET=user@host}"
SSH_KEY="${SSH_KEY:-}"
LIVE_WORK="${LIVE_WORK:-/opt/fc-spike}"
E2E_WORK="${E2E_WORK:-/opt/fc-wsdrive-e2e}"
REBUILD="${REBUILD:-1}"
DRIVE_MIB="${DRIVE_MIB:-20480}"
MEM_MIB="${MEM_MIB:-4096}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-benchmarks}"
STAGE=/root/metal-agent-wsdrive-e2e

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[[ -n "$SSH_KEY" ]] && SSH_OPTS+=(-i "$SSH_KEY")
ssh_() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }
scp_() { scp -q "${SSH_OPTS[@]}" "$@"; }

echo "== Preflight =="
ssh_ "test -e /dev/kvm && test -x $LIVE_WORK/bin/firecracker && test -f $LIVE_WORK/img/vmlinux && command -v bun >/dev/null" \
  || { echo "! host lacks kvm / firecracker / kernel under $LIVE_WORK / bun"; exit 3; }

echo "== Stage node-agent source + rootfs builder =="
ssh_ "rm -rf $STAGE && mkdir -p $STAGE/src $STAGE/scripts"
COPYFILE_DISABLE=1 tar -C "$REPO_ROOT/apps/metal-agent" -czf - src package.json tsconfig.json | ssh_ "tar -C $STAGE -xzf -"
scp_ "$REPO_ROOT/scripts/metal-agent/build-runtime-rootfs.sh" "$SSH_TARGET:$STAGE/scripts/"

if [[ "$REBUILD" == "1" ]] || ! ssh_ "test -f $E2E_WORK/img/runtime.ext4"; then
  echo "== Bake rootfs with this checkout's fc-init =="
  ssh_ "mkdir -p $E2E_WORK/img && set -a && . /etc/metal-agent.env && set +a && \
    OUT=$E2E_WORK/img/runtime.ext4 WORKDIR=$E2E_WORK/build bash $STAGE/scripts/build-runtime-rootfs.sh"
fi

echo "== Run e2e (drive ${DRIVE_MIB} MiB, dm CoW, fs durable store) =="
rc=0
ssh_ "rm -rf $E2E_WORK/durable $E2E_WORK/run $E2E_WORK/snapshots $E2E_WORK/cow && cd $STAGE && \
  METAL_WORK=$E2E_WORK METAL_FC_BIN=$LIVE_WORK/bin/firecracker METAL_KERNEL=$LIVE_WORK/img/vmlinux \
  METAL_ROOTFS=$E2E_WORK/img/runtime.ext4 METAL_GUEST_INIT=/usr/local/bin/fc-init \
  METAL_ROOTFS_COW=dm METAL_WORKSPACE_DRIVE_MIB=$DRIVE_MIB METAL_MEM_MIB=$MEM_MIB \
  METAL_SNAP_STORE=fs METAL_SNAP_STORE_DIR=$E2E_WORK/durable METAL_SNAP_SLIM=1 \
  bun run src/e2e-workspace-drive.ts" || rc=$?

echo "== Copy results =="
mkdir -p "$OUT_DIR"
latest="$(ssh_ "ls -1t $E2E_WORK/e2e-workspace-drive-results-*.json 2>/dev/null | head -1" || true)"
if [[ -n "$latest" ]]; then
  scp_ "$SSH_TARGET:$latest" "$OUT_DIR/metal-$(basename "$latest")"
  echo "wrote $OUT_DIR/metal-$(basename "$latest")"
fi
[[ $rc -eq 0 ]] || { echo "! workspace drive e2e failed (exit $rc)"; exit "$rc"; }
echo "== Done =="
