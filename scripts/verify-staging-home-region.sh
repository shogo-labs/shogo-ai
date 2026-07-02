#!/usr/bin/env bash
# Staging verification for the region write-ownership feature.
#
# Staging is single-region (REGION_ID=staging, no REGION_PEERS, no replication
# mesh), so this validates the *deploy/runtime* half of the feature — it does
# NOT (cannot) exercise cross-region proxying or replication convergence:
#
#   1. The add_user_home_region migration applied; homeRegion columns + indexes
#      exist on users and workspaces.
#   2. The API is deployed with HOME_REGION_ROUTING configured (shadow OR
#      enforce — staging is now enforce) and is healthy.
#   3. homeRegion is stamped on create: a fresh signup gets users.homeRegion =
#      'staging' (proves the auth additionalField + create hook work end to end).
#   4. The router is inert/safe: because staging has no REGION_PEERS it never
#      actually proxies (every write resolves local), even in enforce — so
#      normal traffic is unaffected. This is the key single-region invariant.
#
# Config (env overrides):
#   NS         k8s namespace          (default: shogo-staging-system)
#   KCONTEXT   kubectl --context      (default: current context)
#   DOMAIN     staging API host       (default: staging.shogo.ai) — set to your
#              actual staging DOMAIN (the GH Actions `vars.DOMAIN`).
#   API        full API base URL      (default: https://$DOMAIN)
#
#   ./scripts/verify-staging-home-region.sh
set -uo pipefail

NS="${NS:-shogo-staging-system}"
KCONTEXT="${KCONTEXT:-}"
DOMAIN="${DOMAIN:-staging.shogo.ai}"
API="${API:-https://$DOMAIN}"
MIGRATION="20260625150000_add_user_home_region"

KC=(kubectl)
[ -n "$KCONTEXT" ] && KC=(kubectl --context "$KCONTEXT")
clean(){ grep -vi -E 'opensslwarning|warnings.warn' || true; }

FAILED=0
pass(){ echo "  PASS: $*"; }
fail(){ echo "  FAIL: $*"; FAILED=1; }
hdr(){ echo "===== $* ====="; }

# --- locate the CNPG primary pod -------------------------------------------
hdr "0. locate staging Postgres primary"
PGPOD=$("${KC[@]}" get pods -n "$NS" -l 'cnpg.io/instanceRole=primary' -o name 2>/dev/null | head -1 | sed 's|pod/||')
if [ -z "$PGPOD" ]; then
  PGPOD=$("${KC[@]}" get pods -n "$NS" -l 'role=primary' -o name 2>/dev/null | head -1 | sed 's|pod/||')
fi
if [ -z "$PGPOD" ]; then
  echo "  could not find a CNPG primary pod in $NS (labels cnpg.io/instanceRole=primary / role=primary)."
  echo "  Set NS/KCONTEXT, or check 'kubectl get pods -n $NS'."
  exit 2
fi
echo "  primary pod: $PGPOD"
PSQL(){ "${KC[@]}" exec -n "$NS" "$PGPOD" -c postgres -- psql -U postgres -d shogo -tA "$@" 2>/dev/null | clean; }

# --- 1. migration + schema --------------------------------------------------
hdr "1. migration + schema"
MIG=$(PSQL -c "SELECT 1 FROM _prisma_migrations WHERE migration_name='$MIGRATION' AND finished_at IS NOT NULL;")
[ "$MIG" = "1" ] && pass "migration $MIGRATION recorded applied" || fail "migration $MIGRATION not applied (got: '${MIG:-<none>}')"

for tbl in users workspaces; do
  COL=$(PSQL -c "SELECT 1 FROM information_schema.columns WHERE table_name='$tbl' AND column_name='homeRegion';")
  [ "$COL" = "1" ] && pass "$tbl.homeRegion column exists" || fail "$tbl.homeRegion column missing"
done
for idx in users_homeRegion_idx workspaces_homeRegion_idx; do
  IDX=$(PSQL -c "SELECT 1 FROM pg_indexes WHERE indexname='$idx';")
  [ "$IDX" = "1" ] && pass "index $idx exists" || fail "index $idx missing"
done

# --- 2. deployment env + health --------------------------------------------
hdr "2. router config + health"
ROUTING=$("${KC[@]}" get ksvc api -n "$NS" -o jsonpath='{range .spec.template.spec.containers[*]}{range .env[?(@.name=="HOME_REGION_ROUTING")]}{.value}{end}{end}' 2>/dev/null | clean)
if [ -z "$ROUTING" ]; then
  # Fall back to deployment if not a Knative service.
  ROUTING=$("${KC[@]}" get deploy -n "$NS" -l serving.knative.dev/service=api -o jsonpath='{range .items[*].spec.template.spec.containers[*]}{range .env[?(@.name=="HOME_REGION_ROUTING")]}{.value}{end}{end}' 2>/dev/null | clean)
fi
# Accept either configured mode: staging is now "enforce" (single-region, so
# it still never proxies — see check 4), but "shadow" is also valid pre-flip.
if [ "$ROUTING" = "enforce" ] || [ "$ROUTING" = "shadow" ]; then
  pass "HOME_REGION_ROUTING=$ROUTING (configured)"
else
  fail "HOME_REGION_ROUTING is '${ROUTING:-<unset>}' (expected shadow or enforce)"
fi

HTTP=$(curl -sf -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 15 "$API/api/health" 2>/dev/null) || HTTP="000"
[ "$HTTP" = "200" ] && pass "$API/api/health -> 200" || fail "$API/api/health -> $HTTP"

# --- 3. homeRegion stamping on signup --------------------------------------
hdr "3. homeRegion stamped on create"
TS=$(date +%s)
EMAIL="verify_homeregion_${TS}@test.shogo.dev"
PW="VerifyPass_${TS}!"
SIGNUP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
  -X POST "$API/api/auth/sign-up/email" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"name\":\"Verify $TS\"}" 2>/dev/null) || SIGNUP="000"
if [ "$SIGNUP" = "200" ] || [ "$SIGNUP" = "201" ]; then
  pass "signup accepted ($SIGNUP)"
  sleep 1
  HR=$(PSQL -c "SELECT \"homeRegion\" FROM users WHERE lower(email)=lower('$EMAIL');")
  [ "$HR" = "staging" ] && pass "new user homeRegion='staging'" || fail "new user homeRegion='${HR:-<null>}' (expected staging)"
  # cleanup
  PSQL -c "DELETE FROM users WHERE lower(email)=lower('$EMAIL');" >/dev/null
  echo "  (cleaned up test user)"
else
  fail "signup failed ($SIGNUP) — cannot verify stamping. Check signups are open on staging."
fi

# --- 4. router is inert (informational) ------------------------------------
hdr "4. router activity (informational)"
LOGS=$("${KC[@]}" logs -n "$NS" -l serving.knative.dev/service=api -c user-container --tail=2000 --since=1h 2>/dev/null \
  | grep -c 'home-region-router' || true)
echo "  [home-region-router] log lines in last 1h: ${LOGS:-0}"
PROXIED=$("${KC[@]}" logs -n "$NS" -l serving.knative.dev/service=api -c user-container --tail=2000 --since=1h 2>/dev/null \
  | grep -c '\] proxy ' || true)
if [ "${PROXIED:-0}" != "0" ]; then
  fail "router performed $PROXIED actual proxy(ies) — must be 0 in single-region staging"
else
  pass "router performed 0 actual proxies (correct for single-region staging)"
fi

# --- result -----------------------------------------------------------------
echo
if [ "$FAILED" = "0" ]; then
  echo "===== STAGING VERIFY: ALL CHECKS PASSED ====="
  exit 0
else
  echo "===== STAGING VERIFY: FAILURES ABOVE ====="
  exit 1
fi
