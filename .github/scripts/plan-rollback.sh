#!/usr/bin/env bash
# Read-only plan for rollback-production.yml (dry_run): what a rollback of one
# region to TARGET_SHA would change, without changing anything.
#
# Env:
#   NS_SYSTEM, TARGET_SHA, RUNTIME_IMAGE, API_IMAGE, WEB_IMAGE   (required)
#   DOCS_IMAGE   empty = docs would be left alone
#   COPY_NEEDED  space-separated repos the real run would copy from the
#                primary registry first
# Exits 1 if the rollback would fail or leave the api unable to start.
set -uo pipefail

: "${NS_SYSTEM:?}" "${TARGET_SHA:?}" "${RUNTIME_IMAGE:?}" "${API_IMAGE:?}" "${WEB_IMAGE:?}"
BLOCKERS=()
block() { BLOCKERS+=("$1"); echo "::error::$1"; }
OUT=$(mktemp)

# Digest a ref resolves to: the pinned digest if it has one, else the registry's.
digest_of() {
  case "$1" in
    *@sha256:*) echo "${1##*@}" ;;
    "") echo "" ;;
    *) docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null | jq -r '.digest // empty' ;;
  esac
}
ksvc_image() {
  kubectl get ksvc "$1" -n "$NS_SYSTEM" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true
}

{
  echo "| Service | Current | Target | Change |"
  echo "|---|---|---|---|"
} >> "$OUT"
row() {
  local name=$1 cur=$2 target=$3 cur_d target_d change
  cur_d=$(digest_of "$cur")
  if [ -z "$target" ]; then
    printf '| %s | `%s` | (no image in release) | keep |\n' "$name" "${cur##*/}" >> "$OUT"
    return
  fi
  if [ -n "$COPY_NEEDED_FOR" ]; then
    target_d=$(digest_of "${PRIMARY_REGISTRY:-}/shogo/${COPY_NEEDED_FOR}:${target##*:}")
  else
    target_d=$(digest_of "$target")
  fi
  if [ -z "$target_d" ]; then
    block "${name}: target ${target} does not resolve"
    change="unresolved"
  elif [ "$cur_d" = "$target_d" ]; then
    change="none"
  else
    change="**roll**"
  fi
  printf '| %s | `%s` (%s) | `%s` (%s) | %s |\n' "$name" "${cur##*/}" "${cur_d:7:12}" "${target##*/}" "${target_d:7:12}" "$change" >> "$OUT"
}
copy_repo_for() { case " ${COPY_NEEDED:-} " in *" $1 "*) echo "$1" ;; *) echo "" ;; esac; }

COPY_NEEDED_FOR=$(copy_repo_for shogo-api) row api "$(ksvc_image api)" "$API_IMAGE"
COPY_NEEDED_FOR=$(copy_repo_for shogo-web) row studio "$(ksvc_image studio)" "$WEB_IMAGE"
COPY_NEEDED_FOR=$(copy_repo_for shogo-docs) row docs "$(ksvc_image docs)" "${DOCS_IMAGE:-}"
CUR_RUNTIME=$(kubectl get configmap shogo-runtime-version -n "$NS_SYSTEM" -o jsonpath='{.data.image}' 2>/dev/null || true)
COPY_NEEDED_FOR=$(copy_repo_for shogo-runtime) row runtime "$CUR_RUNTIME" "$RUNTIME_IMAGE"
if [ -n "${COPY_NEEDED:-}" ]; then
  echo "" >> "$OUT"
  echo "Would first copy from the primary registry: \`${COPY_NEEDED}\`" >> "$OUT"
fi

# The older api runs `prisma migrate deploy` on start against today's schema.
PRIMARY=$(kubectl get pods -n "$NS_SYSTEM" \
  -l "cnpg.io/cluster=platform-pg,cnpg.io/instanceRole=primary" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -z "$PRIMARY" ]; then
  block "no platform-pg primary pod in ${NS_SYSTEM}"
elif ! git cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null && ! git fetch -q --depth=1 origin "$TARGET_SHA"; then
  block "can't fetch ${TARGET_SHA} to read its migrations"
else
  psql_q() {
    kubectl exec -i -n "$NS_SYSTEM" "$PRIMARY" -c postgres -- \
      psql -U postgres -d shogo -At -v ON_ERROR_STOP=1 -c "$1"
  }
  sorted() { LC_ALL=C sort -u <<<"$1" | sed '/^$/d'; }
  APPLIED=$(psql_q "select distinct migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by 1")
  FAILED=$(psql_q "select distinct migration_name from _prisma_migrations where finished_at is null and rolled_back_at is null order by 1")
  TARGET_MIGRATIONS=$(git ls-tree --name-only "${TARGET_SHA}" prisma/migrations/ | sed -n 's#^prisma/migrations/##p' | grep -v '\.toml$' || true)
  NEWER=$(LC_ALL=C comm -13 <(sorted "$TARGET_MIGRATIONS") <(sorted "$APPLIED"))
  [ -z "$FAILED" ] || block "unfinished migration(s); the rolled-back api's prisma migrate deploy will refuse to start: $(tr '\n' ' ' <<<"$FAILED")"
  {
    echo ""
    if [ -z "$NEWER" ]; then
      echo "Migrations: the target release knows every applied migration."
    else
      echo "Migrations applied in the database that the target release doesn't have ($(grep -c . <<<"$NEWER")). They stay applied; the older api must tolerate them:"
      echo ""
      sed 's/^/- `/; s/$/`/' <<<"$NEWER"
    fi
  } >> "$OUT"
fi

cat "$OUT"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$OUT" >> "$GITHUB_STEP_SUMMARY"
  if [ ${#BLOCKERS[@]} -gt 0 ]; then
    { echo ""; echo "**Blockers:**"; printf -- '- %s\n' "${BLOCKERS[@]}"; } >> "$GITHUB_STEP_SUMMARY"
  fi
fi
[ ${#BLOCKERS[@]} -eq 0 ]
