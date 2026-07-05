#!/usr/bin/env bash
# =============================================================================
# build-and-run-amd64.sh — end-to-end: sync the repo to the bare-metal host,
# build the agent-runtime image natively for amd64, convert it to a Firecracker
# ext4 rootfs, and run the real-image e2e (boot -> snapshot -> restore).
#
# This is the "build the amd64 image on the host now" path chosen for the
# pilot: the production runtime image is arm64-only and Latitude is x86-only,
# so we bake a native amd64 image on the host to validate the real runtime on
# the microVM substrate today. Multi-arch CI is the durable follow-up.
#
# Usage:
#   SSH_TARGET=root@<host> bash scripts/metal-agent/build-and-run-amd64.sh
# Env:
#   SSH_TARGET (required)  user@host
#   SSH_KEY                identity file
#   WORK                   host artifact dir (default /opt/fc-spike)
#   REMOTE_SRC             host repo dir (default /root/shogo-src)
#   MEM_MIB                microVM memory (default 2048)
#   ITERS                  restore iterations (default 10)
#   SKIP_SYNC              set to 1 to skip rsync (reuse host copy)
#   SKIP_BUILD             set to 1 to skip image build (reuse local image)
# =============================================================================
set -euo pipefail

: "${SSH_TARGET:?set SSH_TARGET=user@host}"
SSH_KEY="${SSH_KEY:-}"
WORK="${WORK:-/opt/fc-spike}"
REMOTE_SRC="${REMOTE_SRC:-/root/shogo-src}"
MEM_MIB="${MEM_MIB:-2048}"
ITERS="${ITERS:-10}"
TAG="${TAG:-local-amd64}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-benchmarks}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[[ -n "$SSH_KEY" ]] && SSH_OPTS+=(-i "$SSH_KEY")
ssh_() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }
scp_() { scp "${SSH_OPTS[@]}" "$@"; }
RSH="ssh ${SSH_OPTS[*]}"

echo "== Preflight host (kvm + kernel) =="
ssh_ "test -e /dev/kvm && test -f $WORK/img/vmlinux" \
  || { echo "! host missing /dev/kvm or $WORK/img/vmlinux — run the FC spike first."; exit 3; }

if [[ "${SKIP_SYNC:-0}" != "1" ]]; then
  echo "== Sync repo -> $SSH_TARGET:$REMOTE_SRC =="
  ssh_ "mkdir -p $REMOTE_SRC"
  # The runtime image build needs packages/**, apps/api, templates, scripts,
  # prisma, patches, and EVERY apps/*/package.json (bun install walks the whole
  # workspace graph). It does NOT need the heavy app sources — apps/desktop
  # alone is ~4.2GB of Electron binaries. Keep only their manifests via
  # include-before-exclude carve-outs so the sync (and the docker build context)
  # stay small.
  rsync -az --delete --rsh="$RSH" \
    --include 'apps/desktop/package.json' --exclude 'apps/desktop/**' \
    --include 'apps/mobile/package.json'  --exclude 'apps/mobile/**' \
    --include 'apps/docs/package.json'    --exclude 'apps/docs/**' \
    --include 'apps/shogo-ide/package.json' --exclude 'apps/shogo-ide/**' \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '**/node_modules' \
    --exclude 'benchmarks' \
    --exclude 'prod-investigation' \
    --exclude '**/*.ext4' \
    --exclude '*.db' \
    --exclude 'workspaces' \
    --exclude 'load-tests' \
    --exclude '*.shogo-project' \
    --exclude '**/.terraform' \
    --exclude '**/.terraform.lock.hcl' \
    --exclude '**/.next' \
    --exclude '**/.turbo' \
    --exclude '**/dist-electron' \
    "$REPO_ROOT/" "$SSH_TARGET:$REMOTE_SRC/"
  echo "   synced"
fi

echo "== Ship build scripts =="
ssh_ "mkdir -p $REMOTE_SRC/scripts/metal-agent"
scp_ "$REPO_ROOT/scripts/metal-agent/build-runtime-image-amd64.sh" \
     "$REPO_ROOT/scripts/metal-agent/build-runtime-rootfs.sh" \
     "$SSH_TARGET:$REMOTE_SRC/scripts/metal-agent/"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "== Build amd64 runtime image on host (base -> deps -> runtime) =="
  ssh_ "cd $REMOTE_SRC && TAG=$TAG bash scripts/metal-agent/build-runtime-image-amd64.sh"
fi

echo "== Convert local image -> ext4 rootfs =="
ssh_ "cd $REMOTE_SRC && RUNTIME_IMAGE=shogo-runtime:$TAG PULL=false OUT=$WORK/img/runtime.ext4 WORKDIR=$WORK/build bash scripts/metal-agent/build-runtime-rootfs.sh"

echo "== Stage node-agent + run real-image e2e =="
ssh_ "rm -rf ~/metal-agent && mkdir -p ~/metal-agent/src"
scp_ "$REPO_ROOT"/apps/metal-agent/src/*.ts "$SSH_TARGET:~/metal-agent/src/"
scp_ "$REPO_ROOT"/apps/metal-agent/package.json "$REPO_ROOT"/apps/metal-agent/tsconfig.json "$SSH_TARGET:~/metal-agent/"
ssh_ 'test -x ~/.bun/bin/bun || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1; ~/.bun/bin/bun --version'
ssh_ "cd ~/metal-agent && METAL_WORK=$WORK METAL_ROOTFS=$WORK/img/runtime.ext4 METAL_GUEST_INIT=/usr/local/bin/fc-init METAL_MEM_MIB=$MEM_MIB METAL_VCPUS=2 E2E_ITERS=$ITERS ~/.bun/bin/bun run src/e2e-real.ts"

echo "== Copy results =="
mkdir -p "$OUT_DIR"
latest="$(ssh_ "ls -1t $WORK/e2e-real-results-*.json 2>/dev/null | head -1" || true)"
if [[ -n "$latest" ]]; then
  scp_ "$SSH_TARGET:$latest" "$OUT_DIR/metal-amd64-$(basename "$latest")"
  echo "wrote $OUT_DIR/metal-amd64-$(basename "$latest")"
fi
echo "== Done =="
