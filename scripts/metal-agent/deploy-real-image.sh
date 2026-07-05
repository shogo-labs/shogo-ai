#!/usr/bin/env bash
# =============================================================================
# deploy-real-image.sh — bake the REAL agent-runtime OCIR image into a
# Firecracker ext4 rootfs on the bare-metal host and run the real-image e2e
# (cold boot -> snapshot -> restore -> live-RAM continuity).
# =============================================================================
# This replaces the pool-agent Go stub with the production runtime image. It:
#   1. Resolves RUNTIME_IMAGE from the staging API deployment (or takes it via
#      env) and extracts the OCIR pull secret from the cluster.
#   2. Ships the pull creds + build-runtime-rootfs.sh to the host and builds
#      $WORK/img/runtime.ext4.
#   3. Stages apps/metal-agent and runs src/e2e-real.ts against that rootfs.
#
# Usage:
#   SSH_TARGET=root@<host> bash scripts/metal-agent/deploy-real-image.sh
# Env:
#   SSH_TARGET (required)   user@host
#   SSH_KEY                 identity file
#   KUBECONTEXT             kube context (default oke-staging)
#   IMAGE_NS                ns to read the ocir pull secret from (default shogo-staging-workspaces)
#   API_NS                  ns to read RUNTIME_IMAGE from (default shogo-staging-system)
#   RUNTIME_IMAGE           override the image ref (skips cluster lookup)
#   WORK                    host artifact dir (default /opt/fc-spike)
#   MEM_MIB                 microVM memory (default 2048)
#   ITERS                   restore iterations (default 10)
# =============================================================================
set -euo pipefail

: "${SSH_TARGET:?set SSH_TARGET=user@host}"
SSH_KEY="${SSH_KEY:-}"
KUBECONTEXT="${KUBECONTEXT:-oke-staging}"
IMAGE_NS="${IMAGE_NS:-shogo-staging-workspaces}"
API_NS="${API_NS:-shogo-staging-system}"
WORK="${WORK:-/opt/fc-spike}"
MEM_MIB="${MEM_MIB:-2048}"
ITERS="${ITERS:-10}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-benchmarks}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[[ -n "$SSH_KEY" ]] && SSH_OPTS+=(-i "$SSH_KEY")
ssh_() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }
scp_() { scp "${SSH_OPTS[@]}" "$@"; }

echo "== Resolve runtime image =="
# The x86 metal host needs an amd64 image. The staging RUNTIME_IMAGE tag is
# arm64-only (OKE fleet); the multi-arch tag published by
# .github/workflows/runtime-multiarch.yml resolves to amd64 on this host. Prefer
# it by default (derive its ref from the api deployment's registry), and fall
# back to the raw staging tag only if explicitly requested via RUNTIME_IMAGE.
if [[ -z "${RUNTIME_IMAGE:-}" ]]; then
  API_RUNTIME_IMAGE="$(kubectl --context "$KUBECONTEXT" -n "$API_NS" get deploy -o json \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(next(e["value"] for i in d["items"] for c in i["spec"]["template"]["spec"]["containers"] for e in c.get("env",[]) if e.get("name")=="RUNTIME_IMAGE"))')"
  # e.g. us-ashburn-1.ocir.io/<ns>/shogo/shogo-runtime:staging-<sha>
  REG_REPO="${API_RUNTIME_IMAGE%%:*}"                # strip :tag
  ENV_PREFIX="${API_RUNTIME_IMAGE##*:}"; ENV_PREFIX="${ENV_PREFIX%%-*}"  # staging|production
  RUNTIME_IMAGE="${REG_REPO}:${ENV_PREFIX}-multiarch-latest"
  echo "   (auto) preferring multi-arch tag; set RUNTIME_IMAGE=$API_RUNTIME_IMAGE to force the arm64 staging tag"
fi
[[ -n "$RUNTIME_IMAGE" ]] || { echo "! could not resolve RUNTIME_IMAGE"; exit 3; }
echo "   RUNTIME_IMAGE=$RUNTIME_IMAGE"

echo "== Extract OCIR pull secret ($IMAGE_NS/ocir-pull-secret) =="
TMPCFG="$(mktemp -d)"
trap 'rm -rf "$TMPCFG"' EXIT
kubectl --context "$KUBECONTEXT" -n "$IMAGE_NS" get secret ocir-pull-secret \
  -o jsonpath='{.data.\.dockerconfigjson}' \
  | python3 -c 'import sys,base64;sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))' > "$TMPCFG/config.json"
[[ -s "$TMPCFG/config.json" ]] || { echo "! empty docker config from secret"; exit 3; }
echo "   wrote docker config ($(wc -c < "$TMPCFG/config.json") bytes)"

echo "== Preflight host (kvm + kernel) =="
ssh_ "test -e /dev/kvm && test -f $WORK/img/vmlinux" \
  || { echo "! host missing /dev/kvm or $WORK/img/vmlinux — run the FC spike first."; exit 3; }

echo "== Ship pull creds + build script =="
ssh_ "mkdir -p ~/.docker-ocir $WORK/img"
scp_ "$TMPCFG/config.json" "$SSH_TARGET:~/.docker-ocir/config.json"
scp_ "$REPO_ROOT/scripts/metal-agent/build-runtime-rootfs.sh" "$SSH_TARGET:~/build-runtime-rootfs.sh"

echo "== Build runtime.ext4 on host (pull + export + mkfs) =="
ssh_ "RUNTIME_IMAGE='$RUNTIME_IMAGE' DOCKER_CONFIG=\$HOME/.docker-ocir OUT=$WORK/img/runtime.ext4 bash ~/build-runtime-rootfs.sh"

echo "== Stage node-agent source =="
ssh_ "rm -rf ~/metal-agent && mkdir -p ~/metal-agent/src"
scp_ "$REPO_ROOT"/apps/metal-agent/src/*.ts "$SSH_TARGET:~/metal-agent/src/"
scp_ "$REPO_ROOT"/apps/metal-agent/package.json "$REPO_ROOT"/apps/metal-agent/tsconfig.json "$SSH_TARGET:~/metal-agent/"
ssh_ 'test -x ~/.bun/bin/bun || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1; ~/.bun/bin/bun --version'

echo "== Run real-image e2e =="
ssh_ "cd ~/metal-agent && METAL_WORK=$WORK METAL_ROOTFS=$WORK/img/runtime.ext4 METAL_GUEST_INIT=/usr/local/bin/fc-init METAL_MEM_MIB=$MEM_MIB METAL_VCPUS=2 E2E_ITERS=$ITERS ~/.bun/bin/bun run src/e2e-real.ts"

echo "== Copy results =="
mkdir -p "$OUT_DIR"
latest="$(ssh_ "ls -1t $WORK/e2e-real-results-*.json 2>/dev/null | head -1" || true)"
if [[ -n "$latest" ]]; then
  scp_ "$SSH_TARGET:$latest" "$OUT_DIR/metal-$(basename "$latest")"
  echo "wrote $OUT_DIR/metal-$(basename "$latest")"
else
  echo "! no e2e-real-results json found on host"
fi
echo "== Done =="
