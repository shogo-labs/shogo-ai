#!/usr/bin/env bash
# scripts/runtime-image-layer-delta.sh
#
# Measures how much of the runtime image is a stable, slow-changing base vs.
# how much actually changes from one build to the next. This is the decisive
# input for the "bake the runtime base into the OKE node image" proposal (#2):
# a baked node image only helps if the layers shared across builds are large
# and the per-deploy delta is small.
#
# Layer sizes reported here are the COMPRESSED bytes from the image manifest —
# i.e. what a node actually downloads from OCIR during the prepull gate.
#
# Requires: docker (with `docker buildx imagetools inspect`), jq. You must be
# logged in to the registry (docker login <registry>) with pull access.
#
# Usage:
#   scripts/runtime-image-layer-delta.sh <repo> <digest_or_tag> <digest_or_tag> [more...]
#
# Example:
#   scripts/runtime-image-layer-delta.sh \
#     us-ashburn-1.ocir.io/idin4oltblww/shogo/shogo-runtime \
#     sha256:acbad461... sha256:698363a9... sha256:b72da790...

set -uo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <repo> <ref> <ref> [more...]" >&2
  exit 2
fi

REPO="$1"; shift
REFS=("$@")
N="${#REFS[@]}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mb() { awk '{s+=$2} END{printf "%.0f", s/1048576}' "$1"; }

echo "repo: $REPO"
echo "builds: $N"
echo

i=0
for ref in "${REFS[@]}"; do
  i=$((i + 1))
  # A ref may be a bare digest, a sha256:... digest, or a tag.
  case "$ref" in
    sha256:*) target="$REPO@$ref" ;;
    *:*)      target="$REPO:$ref" ;;          # tag with explicit name not supported; treat as tag
    *)        target="$REPO@sha256:$ref" ;;    # bare hex → digest
  esac
  if ! docker buildx imagetools inspect --raw "$target" 2>/dev/null \
       | jq -r '.layers[] | "\(.digest) \(.size)"' > "$WORK/img$i.layers"; then
    echo "ERROR: failed to inspect $target (auth? wrong ref?)" >&2
    exit 1
  fi
  if [[ ! -s "$WORK/img$i.layers" ]]; then
    echo "ERROR: no layers for $target (is it a multi-arch index? this tool expects a single manifest)" >&2
    exit 1
  fi
  echo "img$i  ${ref:0:19}  layers=$(wc -l < "$WORK/img$i.layers" | tr -d ' ')  compressed=$(mb "$WORK/img$i.layers") MB"
done

# Layers present in EVERY build = the stable base a node image could bake in.
cat "$WORK"/img*.layers | sort | uniq -c \
  | awk -v n="$N" '$1==n {print $2, $3}' | sort -u > "$WORK/shared.layers"

echo
echo "=== stable base (layers present in all $N builds → bake-able) ==="
echo "shared layers: $(wc -l < "$WORK/shared.layers" | tr -d ' ')   compressed: $(mb "$WORK/shared.layers") MB"

echo
echo "=== per-build delta (compressed bytes still pulled with a baked base) ==="
sort -u "$WORK/shared.layers" > "$WORK/shared.sorted"
for i in $(seq 1 "$N"); do
  comm -23 <(sort -u "$WORK/img$i.layers") "$WORK/shared.sorted" > "$WORK/var$i.layers"
  echo "img$i delta: $(mb "$WORK/var$i.layers") MB  ($(wc -l < "$WORK/var$i.layers" | tr -d ' ') layers)"
done

echo
echo "=== img1 top 10 layers (S=shared/base, V=variable/per-deploy) ==="
sort -k2 -n -r "$WORK/img1.layers" | head -10 | while read -r dg sz; do
  if grep -q "$dg" "$WORK/shared.sorted"; then flag=S; else flag=V; fi
  printf "  [%s] %7.1f MB  %s\n" "$flag" "$(awk "BEGIN{print $sz/1048576}")" "${dg:7:19}"
done
