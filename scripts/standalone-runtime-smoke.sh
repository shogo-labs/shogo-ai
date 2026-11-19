#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Standalone runtime smoke test (SHO-418).
#
# Boots the published image the way a partner should: read-only root
# filesystem, every writable path mounted, SHOGO_STANDALONE=1, no Shogo API.
# Then it proves the runtime is actually usable — /health answers, the files
# API round-trips, and nothing crashed on a read-only root.
#
# Usage:
#   scripts/standalone-runtime-smoke.sh [image]
#
#   image   defaults to ghcr.io/shogo-labs/shogo-runtime:latest
#
# Requires: docker. Exits non-zero on the first failure.

set -euo pipefail

IMAGE="${1:-ghcr.io/shogo-labs/shogo-runtime:latest}"
NAME="shogo-standalone-smoke-$$"
PORT="${SMOKE_PORT:-18080}"
SECRET="smoke-$(date +%s)"
WORKDIR="$(mktemp -d)"
CONTAINER=""

cleanup() {
  if [ -n "$CONTAINER" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  if [ -n "$CONTAINER" ]; then
    echo "--- container logs ---" >&2
    docker logs "$CONTAINER" 2>&1 | tail -40 >&2
  fi
  exit 1
}

echo "==> pulling $IMAGE"
docker pull "$IMAGE" >/dev/null 2>&1 || true
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "image $IMAGE is not available locally and could not be pulled"

echo "==> starting with a read-only root filesystem"
CONTAINER="$(docker run -d --name "$NAME" \
  --read-only \
  -p "127.0.0.1:${PORT}:8080" \
  --tmpfs /tmp:rw,size=512m \
  --tmpfs /app/.schemas:rw,size=64m \
  --tmpfs /app/.claude:rw,size=64m \
  --tmpfs /app/.npm:rw,size=256m \
  --tmpfs /app/.bun:rw,size=256m \
  --tmpfs /app/.config:rw,size=64m \
  --tmpfs /app/.cache:rw,size=256m \
  --tmpfs /app/.local:rw,size=64m \
  -v "${WORKDIR}:/app/workspace" \
  -e SHOGO_STANDALONE=1 \
  -e RUNTIME_AUTH_SECRET="$SECRET" \
  -e AGENT_MODEL=local:qwen3-coder \
  -e OPENAI_BASE_URL=http://127.0.0.1:9/v1 \
  -e OPENAI_API_KEY=not-needed \
  "$IMAGE")"

echo "==> waiting for /health"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
    fail "container exited before /health answered"
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || fail "/health never answered"
echo "    /health ok"

echo "==> /agent/* must refuse an unauthenticated request"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/agent/status")"
[ "$STATUS" = "401" ] || fail "expected 401 without a token, got $STATUS"
echo "    401 without a token"

echo "==> files API round-trip"
TEXT='héllo — 世界'
EXPECTED_BYTES="$(printf '%s' "$TEXT" | wc -c | tr -d ' ')"
curl -fsS -X PUT \
  -H "Authorization: Bearer $SECRET" \
  -H 'content-type: application/json' \
  --data "$(printf '{"content":"%s"}' "$TEXT")" \
  "http://127.0.0.1:${PORT}/agent/workspace/files/smoke/unicode.txt" >/dev/null \
  || fail "PUT failed"

BODY="$(curl -fsS -H "Authorization: Bearer $SECRET" \
  "http://127.0.0.1:${PORT}/agent/workspace/files/smoke/unicode.txt")" \
  || fail "GET failed"

echo "$BODY" | grep -q '"encoding":"utf-8"' || fail "expected a utf-8 read, got: $BODY"
echo "$BODY" | grep -q "\"bytes\":${EXPECTED_BYTES}" \
  || fail "expected bytes=${EXPECTED_BYTES} (a byte count, not a character count), got: $BODY"
echo "    text round-trip ok (${EXPECTED_BYTES} bytes)"

echo "==> the file landed on the mounted workspace"
[ -f "${WORKDIR}/smoke/unicode.txt" ] || fail "the file is not on the mounted volume"
echo "    workspace volume ok"

echo "==> no crash on a read-only root"
[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = "true" ] || fail "container is not running"
if docker logs "$CONTAINER" 2>&1 | grep -qE 'EROFS|Read-only file system'; then
  fail "the runtime tried to write outside its writable mounts"
fi
echo "    no EROFS"

echo
echo "PASS: $IMAGE runs standalone with a read-only root filesystem"
