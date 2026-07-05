#!/usr/bin/env bash
# =============================================================================
# build-runtime-image-amd64.sh — build the agent-runtime container image for
# linux/amd64, natively, on the bare-metal host (runs ON the host, in the
# synced repo root). Mirrors the 3-stage CI pipeline in .github/workflows/deploy.yml:
#
#     Dockerfile.base            -> shogo-runtime-base:local-amd64
#     docker/workspace-deps/...  -> shogo-workspace-deps:local-amd64
#     packages/agent-runtime/... -> shogo-runtime:local-amd64
#                                   (BASE_IMAGE + WORKSPACE_DEPS build-args)
#
# CI only builds linux/arm64 (the OCI A1 fleet). The Latitude pilot host is
# x86_64, so we produce a native amd64 image here — no QEMU, full host cores.
# Docker 29 ships BuildKit as the default builder, so plain `docker build`
# handles the `# syntax=...-labs` frontends and `--mount=type=cache`.
#
# Usage (on host, cwd = repo root):
#   bash scripts/metal-agent/build-runtime-image-amd64.sh
# Env:
#   TAG        image tag suffix (default local-amd64)
#   REPO       repo root (default cwd)
# =============================================================================
set -euo pipefail

TAG="${TAG:-local-amd64}"
REPO="${REPO:-$(pwd)}"
cd "$REPO"

export DOCKER_BUILDKIT=1
BASE="shogo-runtime-base:${TAG}"
DEPS="shogo-workspace-deps:${TAG}"
RUNTIME="shogo-runtime:${TAG}"

log() { echo "[build-amd64] $*"; }
step() { echo; echo "=============================================================="; echo "[build-amd64] $*"; echo "=============================================================="; }

command -v docker >/dev/null || { echo "docker not installed"; exit 4; }
docker info >/dev/null 2>&1 || { systemctl start docker 2>/dev/null || service docker start || true; sleep 2; }

# Docker 29 delegates `docker build` to the buildx component, and the runtime
# Dockerfiles require BuildKit-only features (--mount=type=cache, COPY --parents,
# `# syntax` frontends). Ensure buildx is present.
if ! docker buildx version >/dev/null 2>&1; then
  log "buildx missing — installing..."
  export DEBIAN_FRONTEND=noninteractive
  if apt-get install -y -qq docker-buildx >/dev/null 2>&1 || apt-get install -y -qq docker-buildx-plugin >/dev/null 2>&1; then
    log "installed buildx via apt"
  else
    log "apt buildx unavailable — fetching release binary"
    BX_VER="v0.19.3"
    ARCH="$(dpkg --print-architecture)" # amd64
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -fsSL "https://github.com/docker/buildx/releases/download/${BX_VER}/buildx-${BX_VER}.linux-${ARCH}" \
      -o /usr/local/lib/docker/cli-plugins/docker-buildx
    chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx
  fi
  docker buildx version
fi
# Keep the default "docker" driver: it supports the BuildKit features these
# Dockerfiles need (--mount=type=cache, `# syntax` labs frontend for
# COPY --parents) AND loads built images into the local store so the runtime
# build can reference the base/workspace-deps images by local tag (FROM ...),
# with no registry round-trip.

step "1/3 base image ($BASE)"
time docker build \
  --platform linux/amd64 \
  -f packages/agent-runtime/Dockerfile.base \
  -t "$BASE" .

step "2/3 workspace-deps image ($DEPS)"
time docker build \
  --platform linux/amd64 \
  -f docker/workspace-deps/Dockerfile \
  -t "$DEPS" .

step "3/3 runtime image ($RUNTIME)"
time docker build \
  --platform linux/amd64 \
  --build-arg "BASE_IMAGE=$BASE" \
  --build-arg "WORKSPACE_DEPS=$DEPS" \
  -f packages/agent-runtime/Dockerfile \
  -t "$RUNTIME" .

step "done"
docker image inspect "$RUNTIME" --format 'runtime image: {{.RepoTags}} arch={{.Architecture}} size={{.Size}}'
log "convert to rootfs with:"
log "  RUNTIME_IMAGE=$RUNTIME PULL=false OUT=/opt/fc-spike/img/runtime.ext4 bash scripts/metal-agent/build-runtime-rootfs.sh"
