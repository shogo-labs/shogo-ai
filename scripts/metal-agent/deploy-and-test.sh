#!/usr/bin/env bash
# =============================================================================
# deploy-and-test.sh — deploy the Firecracker node-agent to a bare-metal host
# and run the real microVM substrate e2e (boot -> assign -> snapshot -> restore).
# =============================================================================
# Prereqs on the host: the Phase 1 spike artifacts under $WORK (firecracker +
# vmlinux + rootfs.ext4), produced by scripts/firecracker-spike/host-install.sh.
# This script installs bun + go if missing, builds the guest pool-agent, injects
# it into the golden rootfs, then runs apps/metal-agent/src/e2e.ts.
#
# Usage:
#   SSH_TARGET=root@<host> bash scripts/metal-agent/deploy-and-test.sh
# Env:
#   SSH_TARGET (required)  user@host
#   SSH_KEY                identity file
#   WORK                   host artifact dir (default /opt/fc-spike)
#   MEM_MIB                microVM memory (default 1024)
#   ITERS                  restore iterations (default 10)
# =============================================================================
set -euo pipefail

: "${SSH_TARGET:?set SSH_TARGET=user@host}"
SSH_KEY="${SSH_KEY:-}"
WORK="${WORK:-/opt/fc-spike}"
MEM_MIB="${MEM_MIB:-1024}"
ITERS="${ITERS:-10}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-benchmarks}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[[ -n "$SSH_KEY" ]] && SSH_OPTS+=(-i "$SSH_KEY")
ssh_() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }
scp_() { scp "${SSH_OPTS[@]}" "$@"; }

echo "== Preflight =="
ssh_ "test -e /dev/kvm && test -x $WORK/bin/firecracker && test -f $WORK/img/vmlinux && test -f $WORK/img/rootfs.ext4" \
  || { echo "! Host missing FC artifacts under $WORK — run scripts/firecracker-spike/run-spike-ssh.sh first."; exit 3; }

echo "== Stage node-agent source =="
ssh_ "rm -rf ~/metal-agent && mkdir -p ~/metal-agent/src ~/metal-agent/guest"
scp_ "$REPO_ROOT"/apps/metal-agent/src/*.ts "$SSH_TARGET:~/metal-agent/src/"
scp_ "$REPO_ROOT"/apps/metal-agent/guest/*.go "$SSH_TARGET:~/metal-agent/guest/"
scp_ "$REPO_ROOT"/apps/metal-agent/package.json "$REPO_ROOT"/apps/metal-agent/tsconfig.json "$SSH_TARGET:~/metal-agent/"

echo "== Install toolchains (bun + go) if missing =="
ssh_ 'command -v go >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq golang-go >/dev/null; }; go version'
ssh_ 'test -x ~/.bun/bin/bun || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1; ~/.bun/bin/bun --version'

echo "== Build guest pool-agent (static) =="
ssh_ "cd ~/metal-agent/guest && (test -f go.mod || go mod init poolagent >/dev/null 2>&1) && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w' -o $WORK/img/pool-agent ./pool-agent.go && ls -l $WORK/img/pool-agent"

echo "== Inject pool-agent + init into golden rootfs =="
ssh_ "bash -s" <<EOF
set -e
MNT=$WORK/run/rootfs-inject
mkdir -p "\$MNT"
umount "\$MNT" 2>/dev/null || true
mount -o loop $WORK/img/rootfs.ext4 "\$MNT"
mkdir -p "\$MNT/usr/local/bin"
install -m0755 $WORK/img/pool-agent "\$MNT/usr/local/bin/pool-agent"
cat > "\$MNT/usr/local/bin/pool-init.sh" <<'INIT'
#!/bin/sh
# Minimal init: mount essentials, then become the pool-agent (PID 1).
# eth0 is already configured by the kernel ip= cmdline (before init runs),
# so we deliberately never touch networking here.
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sys /sys 2>/dev/null || true
mount -t tmpfs tmpfs /tmp 2>/dev/null || true
exec /usr/local/bin/pool-agent
INIT
chmod 755 "\$MNT/usr/local/bin/pool-init.sh"
sync
umount "\$MNT"
echo "injected pool-agent + pool-init.sh into rootfs"
EOF

echo "== Run e2e =="
ssh_ "cd ~/metal-agent && METAL_WORK=$WORK METAL_GUEST_INIT=/usr/local/bin/pool-init.sh METAL_POOL_SIZE=1 METAL_MEM_MIB=$MEM_MIB E2E_ITERS=$ITERS ~/.bun/bin/bun run src/e2e.ts"

echo "== Copy results =="
mkdir -p "$OUT_DIR"
latest="$(ssh_ "ls -1t $WORK/e2e-results-*.json 2>/dev/null | head -1" || true)"
if [[ -n "$latest" ]]; then
  scp_ "$SSH_TARGET:$latest" "$OUT_DIR/metal-$(basename "$latest")"
  echo "wrote $OUT_DIR/metal-$(basename "$latest")"
else
  echo "! no e2e-results json found on host"
fi
echo "== Done =="
