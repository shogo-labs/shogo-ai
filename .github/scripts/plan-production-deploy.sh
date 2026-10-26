#!/usr/bin/env bash
# .github/scripts/plan-production-deploy.sh
#
# Read-only plan of what a production deploy of $SHA would do to ONE region
# (deploy.yml `dry_run`). Changes nothing: it inspects registries, reads the
# cluster, runs the real manifests through `kubectl apply --dry-run=server`,
# and reads the platform DB's migration table.
#
# Blockers (anything that would make the real deploy fail) are reported as
# errors and fail the script at the end, after every check has run.
#
# Env:
#   SHA, ENVIRONMENT (overlay dir), NS_SYSTEM            (required)
#   REGION_REGISTRY  this region's <region>.ocir.io/<ns> (required)
#   US_REGISTRY      the primary registry staging builds into (required)
#   REGISTRY_USERNAME, REGISTRY_PASSWORD                  (required)
#   APP_VERSION, GA4_MEASUREMENT_ID, FB_PIXEL_ID          (manifest render)
#   CP_URL, METAL_REGISTER_TOKEN, INSECURE_TLS            (metal fleet read)
#   FLEET_OUT        where to write the metal fleet JSON  (optional)

set -euo pipefail

: "${SHA:?SHA required}"
: "${ENVIRONMENT:?ENVIRONMENT required}"
: "${NS_SYSTEM:?NS_SYSTEM required}"
: "${REGION_REGISTRY:?REGION_REGISTRY required}"
: "${US_REGISTRY:?US_REGISTRY required}"
: "${REGISTRY_USERNAME:?REGISTRY_USERNAME required}"
: "${REGISTRY_PASSWORD:?REGISTRY_PASSWORD required}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
SRC_TAG="staging-${SHA}"
DST_TAG="production-${SHA}"

BLOCKERS=()
block() { echo "::error::$1"; BLOCKERS+=("$1"); }

digest_of() {
  local ref=$1
  case "$ref" in
    *@sha256:*) echo "${ref##*@}"; return ;;
  esac
  docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}' 2>/dev/null | jq -r '.digest // empty' || true
}
short() { [ -n "$1" ] && echo "${1#sha256:}" | cut -c1-12 || echo "—"; }
bullets() { while IFS= read -r line; do printf -- "- \`%s\`\n" "$line"; done; }

for reg in "$US_REGISTRY" "$REGION_REGISTRY"; do
  echo "$REGISTRY_PASSWORD" | docker login "${reg%%/*}" -u "$REGISTRY_USERNAME" --password-stdin >/dev/null
done

echo "## ${ENVIRONMENT}: plan for ${SHA:0:12}" >> "$SUMMARY"

# --- Images: staging source, existing production tag, and what runs now ------
CUR_RUNTIME_TAG=$(kubectl get configmap shogo-runtime-version -n "$NS_SYSTEM" \
  -o jsonpath='{.data.image_tag}' 2>/dev/null || echo "")
ksvc_image() { kubectl get ksvc "$1" -n "$NS_SYSTEM" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo ""; }

RUNTIME_CHANGED=true
{
  echo ""
  echo "| Service | Running now | Release (\`${SRC_TAG:0:20}…\`) | Changes |"
  echo "|---|---|---|---|"
} >> "$SUMMARY"
for pair in studio:shogo-web api:shogo-api docs:shogo-docs runtime:shogo-runtime; do
  svc="${pair%%:*}"; repo="${pair#*:}"
  src=$(digest_of "${US_REGISTRY}/shogo/${repo}:${SRC_TAG}")
  [ -n "$src" ] || block "${repo}:${SRC_TAG} does not exist in ${US_REGISTRY%%/*}; deploy this commit to staging first"

  dst=$(digest_of "${REGION_REGISTRY}/shogo/${repo}:${DST_TAG}")
  if [ -n "$dst" ] && [ -n "$src" ] && [ "$dst" != "$src" ]; then
    echo "::warning::${repo}:${DST_TAG} already exists in ${REGION_REGISTRY%%/*} with a different digest; the deploy re-promotes it"
  fi

  if [ "$svc" = "runtime" ]; then
    cur_ref="${CUR_RUNTIME_TAG:+${REGION_REGISTRY}/shogo/shogo-runtime:${CUR_RUNTIME_TAG}}"
  else
    cur_ref=$(ksvc_image "$svc")
  fi
  cur=""
  [ -n "$cur_ref" ] && cur=$(digest_of "$cur_ref")

  if [ -z "$src" ]; then
    change="**blocked**"
  elif [ "$cur" = "$src" ]; then
    change="no (same digest)"
    [ "$svc" = "runtime" ] && RUNTIME_CHANGED=false
  else
    change="yes"
    [ "$svc" = "runtime" ] && change="yes (prepull + warm-pool roll)"
  fi
  echo "| \`${svc}\` | \`${cur_ref##*/}\` (\`$(short "$cur")\`) | \`$(short "$src")\` | ${change} |" >> "$SUMMARY"
done

# --- Manifests: server-side dry run of exactly what the deploy applies ---------
if [ "$RUNTIME_CHANGED" = "true" ] || [ -z "$CUR_RUNTIME_TAG" ]; then
  RUNTIME_IMAGE="${REGION_REGISTRY}/shogo/shogo-runtime:${DST_TAG}"
else
  RUNTIME_IMAGE="${REGION_REGISTRY}/shogo/shogo-runtime:${CUR_RUNTIME_TAG}"
fi
RENDERED=$(mktemp)
if ! RUNTIME_IMAGE="$RUNTIME_IMAGE" .github/scripts/render-overlay.sh "$ENVIRONMENT" > "$RENDERED"; then
  block "k8s/overlays/${ENVIRONMENT} does not render"
elif out=$(kubectl apply --dry-run=server -f "$RENDERED" 2>&1); then
  echo "" >> "$SUMMARY"
  echo "Manifests: \`kubectl apply --dry-run=server\` accepted $(grep -c '(server dry run)' <<<"$out") objects." >> "$SUMMARY"
else
  block "kubectl apply --dry-run=server rejected the ${ENVIRONMENT} manifests"
  grep -v '(server dry run)' <<<"$out" | tail -20 | cut -c1-600 >&2
  { echo ""; echo '```'; grep -v '(server dry run)' <<<"$out" | tail -40 | cut -c1-600; echo '```'; } >> "$SUMMARY"
fi

# Image fields are reset to :production-latest by the overlay and re-pinned
# right after by apply-release-images.sh, so they are noise in the diff.
diff_rc=0
diff_out=$(kubectl diff -f "$RENDERED" 2>&1) || diff_rc=$?
if [ "$diff_rc" -gt 1 ]; then
  echo "::warning::kubectl diff failed (rc=$diff_rc)"
fi
diff_out=$(grep -vE '^[-+][[:space:]]+((- )?image|generation): ' <<<"$diff_out" || true)
{
  echo ""
  echo "<details><summary>Manifest diff against the live cluster (image lines omitted)</summary>"
  echo ""
  echo '```diff'
  head -400 <<<"${diff_out:-no changes}"
  echo '```'
  echo "</details>"
} >> "$SUMMARY"

# --- Node disk headroom (the same pre-rollout gate the deploy runs) -----------
if ! .github/scripts/check-node-disk-headroom.sh 80; then
  block "node disk headroom gate would fail in ${ENVIRONMENT}"
fi

# --- Migrations: what `prisma migrate deploy` on api start would apply --------
PRIMARY=$(kubectl get pods -n "$NS_SYSTEM" \
  -l "cnpg.io/cluster=platform-pg,cnpg.io/instanceRole=primary" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -z "$PRIMARY" ]; then
  block "no platform-pg primary pod in ${NS_SYSTEM}"
else
  psql_q() {
    kubectl exec -i -n "$NS_SYSTEM" "$PRIMARY" -c postgres -- \
      psql -U postgres -d shogo -At -v ON_ERROR_STOP=1 -c "$1"
  }
  APPLIED=$(psql_q "select distinct migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by 1")
  FAILED=$(psql_q "select distinct migration_name from _prisma_migrations where finished_at is null and rolled_back_at is null order by 1")
  REPO_MIGRATIONS=$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d -exec basename {} \;)
  sorted() { LC_ALL=C sort -u <<<"$1" | sed '/^$/d'; }
  PENDING=$(LC_ALL=C comm -23 <(sorted "$REPO_MIGRATIONS") <(sorted "$APPLIED"))
  AHEAD=$(LC_ALL=C comm -13 <(sorted "$REPO_MIGRATIONS") <(sorted "$APPLIED"))
  [ -z "$FAILED" ] || block "unfinished migration(s) in ${ENVIRONMENT}; prisma migrate deploy will refuse to run: $(tr '\n' ' ' <<<"$FAILED")"
  {
    echo ""
    echo "Migrations: $(grep -c . <<<"$PENDING" || true) pending (applied by the api on start)."
    if [ -n "$PENDING" ]; then echo ""; bullets <<<"$PENDING"; fi
    if [ -n "$AHEAD" ]; then
      echo ""
      echo "Applied in the database but not in this commit's \`prisma/migrations\` (a newer release, or a renamed/removed migration; prisma ignores them):"
      bullets <<<"$AHEAD"
    fi
  } >> "$SUMMARY"
fi

# --- Metal fleet revisions, for the release-wide rootfs gate -----------------
if [ -n "${FLEET_OUT:-}" ] && [ -n "${CP_URL:-}" ]; then
  bash scripts/ci/metal-rootfs-gate.sh fetch "$ENVIRONMENT" "$CP_URL" > "$FLEET_OUT"
fi

if [ ${#BLOCKERS[@]} -gt 0 ]; then
  { echo ""; echo "**${#BLOCKERS[@]} blocker(s):**"; printf -- '- %s\n' "${BLOCKERS[@]}"; } >> "$SUMMARY"
  [ "$SUMMARY" = /dev/stdout ] || sed -n '/^## /,$p' "$SUMMARY" | grep -v '^```diff' | head -60
  exit 1
fi
echo "" >> "$SUMMARY"
echo "No blockers in ${ENVIRONMENT}." >> "$SUMMARY"
[ "$SUMMARY" = /dev/stdout ] || sed -n '/^## /,$p' "$SUMMARY" | head -60
