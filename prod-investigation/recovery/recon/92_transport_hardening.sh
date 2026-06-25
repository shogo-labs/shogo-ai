#!/usr/bin/env bash
# Transport hardening for the cross-region logical-replication mesh.
#
# Fixes the connection-drop class (the 2026-06-25 `SSL SYSCALL error: EOF
# detected` flap that rotted sub_from_india for hours), independent of data
# conflicts. Two changes, applied to all three CNPG clusters:
#
#   1. Append TCP keepalives to every subscriber conninfo so an idle/slow
#      cross-region socket gets probed instead of silently reaped by a NAT/LB.
#   2. Raise wal_sender_timeout / wal_receiver_timeout (60s default is too tight
#      for cross-region) and shorten wal_retrieve_retry_interval so a dropped
#      stream reconnects fast.
#
# This does NOT touch disable_on_error. That flips to false only AFTER write
# ownership is enforced (no conflicts left to disable on) — see
# docs/runbooks/region-write-ownership.md Part C3 / Part E.
#
# Safe to re-run: keepalives are only appended when absent, and the CNPG param
# patch is idempotent.
#
#   ./92_transport_hardening.sh           # dry run (default) — prints planned changes
#   ./92_transport_hardening.sh --apply   # execute
set -uo pipefail
NS=shogo-production-system
PSQL='psql -U postgres -d shogo -v ON_ERROR_STOP=1 -tA'
clean(){ grep -vi -E 'opensslwarning|warnings.warn'; }

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
run(){ if [ $APPLY -eq 1 ]; then eval "$@"; else echo "  DRY-RUN: $*"; fi; }

KEEPALIVES='keepalives=1 keepalives_idle=30 keepalives_interval=10 keepalives_count=3'

# context pod label
REGIONS=(
"context-cp7l2tcj76q platform-pg-2 US"
"context-cbbetkypxva platform-pg-1 EU"
"context-c4w44igvdfa platform-pg-2 India"
)

echo "############ 1. subscriber conninfo keepalives ############"
for r in "${REGIONS[@]}"; do
  read -r CX PD RG <<< "$r"
  echo "===== [$RG] subscriptions on $PD ====="
  SUBS=$(kubectl --context=$CX exec -n $NS $PD -c postgres -- $PSQL -c \
    "SELECT subname FROM pg_subscription ORDER BY subname;" 2>/dev/null | clean)
  [ -z "$SUBS" ] && { echo "  no subscriptions"; continue; }
  while IFS= read -r SUB; do
    [ -z "${SUB:-}" ] && continue
    CONN=$(kubectl --context=$CX exec -n $NS $PD -c postgres -- $PSQL -c \
      "SELECT subconninfo FROM pg_subscription WHERE subname='$SUB';" 2>/dev/null | clean)
    if [ -z "$CONN" ]; then echo "  $SUB: could not read conninfo; skipping"; continue; fi
    if echo "$CONN" | grep -q 'keepalives='; then
      echo "  $SUB: keepalives already present — skip"
      continue
    fi
    NEWCONN="$CONN $KEEPALIVES"
    echo "  $SUB: appending keepalives"
    run "kubectl --context=$CX exec -n $NS $PD -c postgres -- $PSQL -c \"ALTER SUBSCRIPTION $SUB CONNECTION '$NEWCONN';\" 2>&1 | clean"
  done <<< "$SUBS"
done

echo "############ 2. CNPG WAL timeouts (per cluster) ############"
# Patch the CNPG Cluster CR. CNPG reconciles these into postgresql.conf and
# reloads; wal_*_timeout take effect on reload, no restart required.
PATCH='{"spec":{"postgresql":{"parameters":{"wal_sender_timeout":"180s","wal_receiver_timeout":"180s","wal_retrieve_retry_interval":"5s"}}}}'
for r in "${REGIONS[@]}"; do
  read -r CX PD RG <<< "$r"
  CLU=$(kubectl --context=$CX get cluster -n $NS -o jsonpath='{.items[0].metadata.name}' 2>/dev/null | clean)
  if [ -z "$CLU" ]; then echo "===== [$RG] no CNPG Cluster found; skipping"; continue; fi
  echo "===== [$RG] patch cluster/$CLU ====="
  run "kubectl --context=$CX patch cluster $CLU -n $NS --type merge -p '$PATCH' 2>&1 | clean"
done

echo "############ 3. verify ############"
for r in "${REGIONS[@]}"; do
  read -r CX PD RG <<< "$r"
  echo "===== [$RG] $PD ====="
  kubectl --context=$CX exec -n $NS $PD -c postgres -- $PSQL -c \
    "SELECT name,setting FROM pg_settings WHERE name IN ('wal_sender_timeout','wal_receiver_timeout','wal_retrieve_retry_interval') ORDER BY name;" 2>/dev/null | clean
  kubectl --context=$CX exec -n $NS $PD -c postgres -- $PSQL -c \
    "SELECT subname, (subconninfo LIKE '%keepalives=%') AS has_keepalives FROM pg_subscription ORDER BY subname;" 2>/dev/null | clean
done
echo "===== TRANSPORT HARDENING $( [ $APPLY -eq 1 ] && echo APPLIED || echo 'DRY RUN' ) ====="
