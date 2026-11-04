#!/usr/bin/env bash
# Tests for .github/scripts/lib/prisma-migrate-retry.sh and the migration Job
# that run-prisma-migrations.sh renders (SHO-275).
#
# `prisma migrate deploy` is replaced by a fake that holds a lock the way
# Prisma's pg_advisory_lock does and prints Prisma's real P1002 text when it
# cannot get it, so the contention of the v2.4.7 EU deploy (api entrypoint vs.
# migration Job on one database) is reproduced without Postgres.
#
#   bash .github/scripts/test/prisma_migrate_retry_test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RETRY="$ROOT/.github/scripts/lib/prisma-migrate-retry.sh"
RUNNER="$ROOT/.github/scripts/run-prisma-migrations.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }

# Fake migrator. Takes Prisma's advisory lock *exclusively* (an O_EXCL create,
# so two migrators can never both hold it) and records who holds it. A migrator
# that cannot take the lock records the contention in `$FAKE_DB/contended` and
# fails with Prisma's real P1002 output and exit 1, the way `migrate deploy`
# does.
#
# Holding is a rendezvous, not a sleep (SHO-301). The holder keeps the lock
# until a refused migrator has recorded the contention — or until HOLD_CEILING
# seconds pass, so a broken wrapper still fails — and the refused one waits up
# to LOCK_WAIT seconds for the lock to go free before it reports P1002. Nothing
# here depends on how the runner schedules the two processes.
cat >"$TMP/fake-migrate" <<'EOF'
#!/bin/sh
lock="$FAKE_DB/advisory.lock"
echo call >>"$FAKE_DB/calls.$1"
if [ -n "${FAKE_FAIL:-}" ]; then
  echo "Error: P3009"
  echo "migrate found failed migrations in the target database"
  exit 1
fi
# `set -C` is noclobber: the create fails if the file exists, so the lock is
# exclusive and checkable — not "whoever mkdir'd first wins".
if ( set -C; printf '%s' "$1" >"$lock" ) 2>/dev/null; then
  echo "acquire $1" >>"$FAKE_DB/holders"
  waited=0
  while [ ! -f "$FAKE_DB/contended" ] && [ "$waited" -lt "${HOLD_CEILING:-20}" ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  echo "1 migration found in prisma/migrations"
  echo "All migrations have been successfully applied."
  owner="$(cat "$lock" 2>/dev/null)"
  if [ "$owner" != "$1" ]; then
    echo "lock ownership lost: held by '$owner', releasing '$1'" >&2
    exit 1
  fi
  rm -f "$lock"
  echo "release $1" >>"$FAKE_DB/holders"
  exit 0
fi
# Someone else holds it. Record the contention (the holder releases on seeing
# it), give it LOCK_WAIT seconds to let go, then fail the way Prisma does.
: >"$FAKE_DB/contended"
waited=0
while [ -e "$lock" ] && [ "$waited" -lt "${LOCK_WAIT:-0}" ]; do
  sleep 1
  waited=$((waited + 1))
done
echo "Error: P1002"
echo ""
echo "The database server was reached but timed out."
echo ""
echo "Context: Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369)). Timeout: 10000ms."
exit 1
EOF
chmod +x "$TMP/fake-migrate"

new_db() { rm -rf "$TMP/db"; mkdir -p "$TMP/db"; export FAKE_DB="$TMP/db"; }
calls() { wc -l <"$FAKE_DB/calls.$1" 2>/dev/null | tr -d ' ' || echo 0; }
# Never more than one lock holder: the fake logs `acquire <name>` on taking the
# lock and `release <name>` on giving it back, so a double acquire or a release
# by someone who does not hold it is reported instead of being inferred from
# exit codes.
holder_violations() {
  [ -f "$FAKE_DB/holders" ] || return 0
  awk '
    $1 == "acquire" { if (held != "") { print "two holders: " held " and " $2; bad = 1 } held = $2 }
    $1 == "release" { if (held != $2) { print "released by " $2 " while " (held == "" ? "nobody" : held) " held it"; bad = 1 } held = "" }
    END { if (held != "") { print "still held by " held; bad = 1 } exit bad }
  ' "$FAKE_DB/holders"
}
# Wait (up to 20 s) for a holder to have taken the lock.
wait_for_lock() {
  for _ in $(seq 1 200); do [ -e "$FAKE_DB/advisory.lock" ] && return 0; sleep 0.1; done
  return 1
}

# --- 1. The Job spec carries the retry script verbatim, runnable by the pod ---
mkdir -p "$TMP/bin"
cat >"$TMP/bin/kubectl" <<EOF
#!/bin/sh
case "\$1" in
  apply) cat >"$TMP/job.yaml" ;;
  get) printf 'True' ;;
esac
exit 0
EOF
chmod +x "$TMP/bin/kubectl"

if PATH="$TMP/bin:$PATH" bash "$RUNNER" shogo-test img:tag >"$TMP/runner.out" 2>&1; then
  pass "run-prisma-migrations.sh renders and submits the Job"
else
  fail "run-prisma-migrations.sh exited non-zero"; cat "$TMP/runner.out"
fi

if grep -q 'bunx prisma migrate deploy' "$TMP/job.yaml"; then
  fail "Job still runs bare 'bunx prisma migrate deploy' (no retry)"
else
  pass "Job does not run bare migrate deploy"
fi
grep -q 'backoffLimit: 0' "$TMP/job.yaml" && pass "Job keeps backoffLimit: 0" || fail "backoffLimit changed"

B64="$(awk '/name: MIGRATE_RETRY_SH/{getline; sub(/^ *value: "/,""); sub(/"$/,""); print}' "$TMP/job.yaml")"
if [ -n "$B64" ] && printf '%s' "$B64" | base64 -d >"$TMP/embedded.sh" 2>/dev/null && cmp -s "$TMP/embedded.sh" "$RETRY"; then
  pass "embedded MIGRATE_RETRY_SH decodes to lib/prisma-migrate-retry.sh"
else
  fail "embedded MIGRATE_RETRY_SH does not match lib/prisma-migrate-retry.sh"
fi

# Run the container command line exactly as rendered, through /bin/sh.
CMD="$(sed -n 's/^ *command: \["sh", "-c", "\(.*\)"\]$/\1/p' "$TMP/job.yaml" | sed 's/\\"/"/g')"
CMD="${CMD//cd \/app/cd $TMP}"
CMD="${CMD//\/tmp\/prisma-migrate-retry.sh/$TMP/pod-retry.sh}"
new_db
if MIGRATE_RETRY_SH="$B64" MIGRATE_CMD="$TMP/fake-migrate pod" sh -c "$CMD" >"$TMP/pod.out" 2>&1 && grep -q 'successfully applied' "$TMP/pod.out"; then
  pass "rendered container command runs the retry script under /bin/sh"
else
  fail "rendered container command failed"; cat "$TMP/pod.out"
fi

# --- 2. Lock held, then released: retried until it applies ---
new_db
# A holder that keeps the lock until the retrying migrator records that it was
# refused, then lets go. Rendezvous, not a sleep: the outcome no longer depends
# on how fast either process gets scheduled.
HOLD_CEILING=20 sh "$TMP/fake-migrate" holder >"$TMP/o2-holder" 2>&1 & ph=$!
wait_for_lock || fail "test 2: the holder never took the lock"
if MIGRATE_CMD="$TMP/fake-migrate job" MIGRATE_LOCK_BACKOFF=1 sh "$RETRY" >"$TMP/o2" 2>&1; then
  pass "P1002 is retried and the migration applies once the lock frees ($(calls job) attempts)"
else
  fail "P1002 was not retried to success"; cat "$TMP/o2"
fi
wait $ph
grep -q 'retry 1/' "$TMP/o2" && pass "retry is logged" || fail "retry not logged"

# --- 3. A real migration failure fails fast, no retry ---
new_db
if FAKE_FAIL=1 MIGRATE_CMD="$TMP/fake-migrate job" MIGRATE_LOCK_BACKOFF=1 sh "$RETRY" >"$TMP/o3" 2>&1; then
  fail "P3009 exited 0"
else
  [ "$(calls job)" = 1 ] && pass "P3009 fails on the first attempt, no retry" || fail "P3009 retried $(calls job) times"
fi

# --- 4. Lock never released: bounded attempts, non-zero exit ---
new_db
# A directory nobody removes: the exclusive create fails on every attempt.
mkdir "$FAKE_DB/advisory.lock"
if MIGRATE_CMD="$TMP/fake-migrate job" MIGRATE_LOCK_ATTEMPTS=3 MIGRATE_LOCK_BACKOFF=0 sh "$RETRY" >"$TMP/o4" 2>&1; then
  fail "permanently held lock exited 0"
else
  [ "$(calls job)" = 3 ] && pass "held lock gives up after MIGRATE_LOCK_ATTEMPTS (3)" || fail "expected 3 attempts, got $(calls job)"
fi

# --- 5. Two simultaneous migrators on one database: neither fails ---
# The v2.4.7 EU shape: api entrypoint and migration Job start together, the
# loser times out on the lock while the winner is still applying.
new_db
MIGRATE_CMD="$TMP/fake-migrate a" MIGRATE_LOCK_BACKOFF=1 sh "$RETRY" >"$TMP/o5a" 2>&1 & pa=$!
MIGRATE_CMD="$TMP/fake-migrate b" MIGRATE_LOCK_BACKOFF=1 sh "$RETRY" >"$TMP/o5b" 2>&1 & pb=$!
wait $pa; ra=$?; wait $pb; rb=$?
if [ "$ra" = 0 ] && [ "$rb" = 0 ] && grep -q P1002 "$TMP/o5a" "$TMP/o5b"; then
  pass "two concurrent migrate deploys both succeed (loser hit P1002, retried)"
else
  fail "concurrent migrators: exit codes a=$ra b=$rb"; cat "$TMP/o5a" "$TMP/o5b"
fi
if holder_violations >"$TMP/hv5"; then
  pass "concurrent migrators never held the lock twice"
else
  fail "concurrent migrators held the lock twice"; cat "$TMP/hv5"
fi

# Control: without the wrapper the loser fails, i.e. the test reproduces the bug.
new_db
HOLD_CEILING=20 sh "$TMP/fake-migrate" a >/dev/null 2>&1 & pa=$!
wait_for_lock || fail "control: the holder never took the lock"
if LOCK_WAIT=1 sh "$TMP/fake-migrate" b >/dev/null 2>&1; then
  fail "control: bare migrator did not hit the lock (fake is wrong)"
else
  pass "control: a bare concurrent migrate deploy fails with P1002"
fi
wait $pa

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "all passed"
