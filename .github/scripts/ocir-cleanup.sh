#!/usr/bin/env bash
# Prune old images from one OCIR registry (see .github/workflows/cleanup-ocir.yml).
#
# OCIR lists one row per (image, tag), and a delete removes the image with all
# its tags, so rows are grouped by image id first: any protected tag protects
# the whole image. An image is deleted only if ALL of these hold:
#   1. none of its tags contains "latest"
#   2. its digest is not in PROTECTED_DIGESTS (in use by a cluster or a metal
#      host, or one of the last production releases)
#   3. it is not one of the KEEP_COUNT newest unprotected images in its repo
#   4. it is older than KEEP_DAYS
#   5. it is not a platform manifest (or attestation) of an image index that
#      is kept: OCIR lists those as separate untagged images, and deleting
#      one breaks the multi-arch tag that points at the index.
#
# Required env: COMPARTMENT_ID REGISTRY_HOST OCIR_NAMESPACE OCIR_USERNAME
#               OCIR_TOKEN PROTECTED_DIGESTS
# Optional env: KEEP_COUNT (20) KEEP_DAYS (30) DRY_RUN (true) REPOS
set -uo pipefail

: "${COMPARTMENT_ID:?}" "${REGISTRY_HOST:?}" "${OCIR_NAMESPACE:?}" "${OCIR_USERNAME:?}" "${OCIR_TOKEN:?}" "${PROTECTED_DIGESTS:?}"
KEEP_COUNT="${KEEP_COUNT:-20}"
KEEP_DAYS="${KEEP_DAYS:-30}"
[ "${DRY_RUN:-}" = "false" ] || DRY_RUN=true
if [ ! -s "$PROTECTED_DIGESTS" ] && [ "$DRY_RUN" = "false" ]; then
  echo "::error::PROTECTED_DIGESTS ($PROTECTED_DIGESTS) is empty; refusing to delete without an in-use set"
  exit 1
fi
REPOS="${REPOS:-shogo/shogo-api shogo/shogo-web shogo/shogo-runtime shogo/shogo-docs shogo/shogo-runtime-base shogo/agent-runtime}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

MANIFEST_ACCEPT='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'

# Digests listed by an image index / manifest list; nothing for a plain
# manifest. Fails if the manifest can't be read.
index_children() {
  local repo=$1 digest=$2 token=$3 body
  body=$(curl -sf --retry 3 --max-time 30 \
    -H "Authorization: Bearer ${token}" -H "Accept: ${MANIFEST_ACCEPT}" \
    "https://${REGISTRY_HOST}/v2/${OCIR_NAMESPACE}/${repo}/manifests/${digest}") || return 1
  jq -r '.manifests[]?.digest' <<<"$body"
}

TOTAL_DELETED=0 TOTAL_RECENT=0 TOTAL_LATEST=0 TOTAL_INUSE=0 TOTAL_AGE=0 TOTAL_CHILD=0 FAILED_REPOS=""

for REPO in $REPOS; do
  echo ""
  echo "============================================"
  echo "Repository: $REPO"
  echo "============================================"

  if ! oci artifacts container image list \
      --compartment-id "$COMPARTMENT_ID" --compartment-id-in-subtree true \
      --repository-name "$REPO" --all --output json > "$WORK/rows.json" 2> "$WORK/err"; then
    echo "::warning::Listing $REPO failed; skipping: $(head -c 500 "$WORK/err")"
    FAILED_REPOS="$FAILED_REPOS $REPO"
    continue
  fi
  if [ ! -s "$WORK/rows.json" ] || [ "$(jq '.data.items | length' "$WORK/rows.json")" = "0" ]; then
    echo "  No images (repository may not exist in this region). Skipping."
    continue
  fi

  # One line per image, newest first: id digest age_days latest(0/1) tags
  jq -r --argjson now "$(date +%s)" '
    .data.items
    | group_by(.id)
    | map({
        id: .[0].id,
        digest: .[0].digest,
        created: (.[0]."time-created" | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601),
        tags: (map(.version // empty) | unique)
      })
    | sort_by(-.created)
    | .[]
    | [.id, .digest, ((($now - .created) / 86400) | floor),
       (if any(.tags[]; test("latest")) then 1 else 0 end),
       (if (.tags | length) > 0 then (.tags | join(",")) else "<untagged>" end)]
    | @tsv' "$WORK/rows.json" > "$WORK/images.tsv"

  echo "  Images: $(wc -l < "$WORK/images.tsv" | tr -d ' ')"

  : > "$WORK/kept-parents.tsv"
  : > "$WORK/candidates.tsv"
  KEPT=0 P_LATEST=0 P_INUSE=0 P_AGE=0
  while IFS=$'\t' read -r id digest age latest tags; do
    reason=""
    if [ "$latest" = "1" ]; then
      reason="latest-tag"; P_LATEST=$((P_LATEST + 1))
    elif grep -qxF "$digest" "$PROTECTED_DIGESTS"; then
      reason="in-use"; P_INUSE=$((P_INUSE + 1))
    elif [ "$KEPT" -lt "$KEEP_COUNT" ]; then
      KEPT=$((KEPT + 1)); reason="recent $KEPT/$KEEP_COUNT"
    elif [ "$age" -lt "$KEEP_DAYS" ]; then
      reason="age<${KEEP_DAYS}d"; P_AGE=$((P_AGE + 1))
    fi
    if [ -n "$reason" ]; then
      echo "  KEEP[$reason]: $tags ${digest:7:12} (${age}d)"
      # A child is pushed just before its index, so only kept images near or
      # past the age cutoff can have children that are delete candidates.
      if [ "$reason" != "age<${KEEP_DAYS}d" ] || [ "$age" -ge $((KEEP_DAYS - 2)) ]; then
        printf '%s\t%s\n' "$digest" "$tags" >> "$WORK/kept-parents.tsv"
      fi
    else
      printf '%s\t%s\t%s\t%s\n' "$id" "$digest" "$age" "$tags" >> "$WORK/candidates.tsv"
    fi
  done < "$WORK/images.tsv"

  : > "$WORK/children.txt"
  if [ -s "$WORK/candidates.tsv" ]; then
    TOKEN=$(curl -sf --retry 3 -u "${OCIR_NAMESPACE}/${OCIR_USERNAME}:${OCIR_TOKEN}" \
      "https://${REGISTRY_HOST}/20180419/docker/token?scope=repository:${OCIR_NAMESPACE}/${REPO}:pull" | jq -r '.token // empty')
    if [ -z "$TOKEN" ]; then
      echo "::warning::No registry token for $REPO; can't check index children, so deleting nothing in it"
      FAILED_REPOS="$FAILED_REPOS $REPO"
      continue
    fi
    ok=true
    while IFS=$'\t' read -r digest tags; do
      if ! index_children "$REPO" "$digest" "$TOKEN" >> "$WORK/children.txt"; then
        echo "::warning::Can't read manifest $tags ($digest) in $REPO; deleting nothing in it"
        ok=false
        break
      fi
    done < "$WORK/kept-parents.tsv"
    if [ "$ok" != "true" ]; then
      FAILED_REPOS="$FAILED_REPOS $REPO"
      continue
    fi
  fi

  DELETED=0 P_CHILD=0
  while IFS=$'\t' read -r id digest age tags; do
    if grep -qxF "$digest" "$WORK/children.txt"; then
      echo "  KEEP[index-child]: $tags ${digest:7:12} (${age}d)"
      P_CHILD=$((P_CHILD + 1))
      continue
    fi
    if [ "$DRY_RUN" = "true" ]; then
      echo "  DRY-RUN DELETE: $tags ${digest:7:12} (${age}d)"
    else
      echo "  DELETE: $tags ${digest:7:12} (${age}d)"
      oci artifacts container image delete --image-id "$id" --force >/dev/null 2>&1 \
        || echo "::warning::Failed to delete $REPO $tags ($digest)"
    fi
    DELETED=$((DELETED + 1))
  done < "$WORK/candidates.tsv"

  echo "  --- recent=$KEPT deleted=$DELETED protected: latest=$P_LATEST in-use=$P_INUSE age=$P_AGE index-child=$P_CHILD"
  TOTAL_RECENT=$((TOTAL_RECENT + KEPT)); TOTAL_DELETED=$((TOTAL_DELETED + DELETED))
  TOTAL_LATEST=$((TOTAL_LATEST + P_LATEST)); TOTAL_INUSE=$((TOTAL_INUSE + P_INUSE))
  TOTAL_AGE=$((TOTAL_AGE + P_AGE)); TOTAL_CHILD=$((TOTAL_CHILD + P_CHILD))
done

MODE=$([ "$DRY_RUN" = "true" ] && echo "dry run, nothing deleted" || echo "enforced")
echo ""
echo "============================================"
echo "Summary for ${REGISTRY_HOST} (${MODE})"
echo "  KEEP_COUNT=$KEEP_COUNT KEEP_DAYS=$KEEP_DAYS"
echo "  Kept (recent): $TOTAL_RECENT  Protected: latest=$TOTAL_LATEST in-use=$TOTAL_INUSE age=$TOTAL_AGE index-child=$TOTAL_CHILD"
echo "  $([ "$DRY_RUN" = "true" ] && echo "Would delete" || echo "Deleted"): $TOTAL_DELETED"
[ -n "$FAILED_REPOS" ] && echo "  Skipped (errors):$FAILED_REPOS"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Cleanup ${REGISTRY_HOST} (${MODE})"
    echo ""
    echo "| Metric | Count |"
    echo "|---|---|"
    echo "| Kept (recent) | $TOTAL_RECENT |"
    echo "| Protected (latest tag) | $TOTAL_LATEST |"
    echo "| Protected (in use / release / metal) | $TOTAL_INUSE |"
    echo "| Protected (age) | $TOTAL_AGE |"
    echo "| Protected (child of a kept index) | $TOTAL_CHILD |"
    echo "| $([ "$DRY_RUN" = "true" ] && echo "Would delete" || echo "Deleted") | $TOTAL_DELETED |"
    echo ""
    echo "- KEEP_COUNT=\`$KEEP_COUNT\`, KEEP_DAYS=\`$KEEP_DAYS\`"
    [ -n "$FAILED_REPOS" ] && echo "- :warning: Skipped after errors:$FAILED_REPOS"
  } >> "$GITHUB_STEP_SUMMARY"
fi

[ -z "$FAILED_REPOS" ]
