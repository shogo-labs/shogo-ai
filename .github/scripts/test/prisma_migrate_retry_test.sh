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

# Fake migrator. Takes the lock (mkdir is atomic), "applies" for HOLD seconds,
# releases it. If the lock is held it waits LOCK_WAIT seconds, then fails with
# Prisma's P1002 output and exit 1, like `migrate deploy` does.
cat >"$TMP/fake-migrate" <<'EOF'
#!/bin/sh
lock="$FAKE_DB/advisory.lock"
echo call >>"$FAKE_DB/calls.$1"
if [ -n "${FAKE_FAIL:-}" ]; then
  echo "Error: P3009"
  echo "migrate found failed migrations in the target database"
  exit 1
fi
if mkdir "$lock" 2>/dev/null; then
  sleep "${HOLD:-0}"
  echo "1 migration found in prisma/migrations"
  echo "All migrations have been successfully applied."
  rmdir "$lock"
  exit 0
fi
sleep "${LOCK_WAIT:-0}"
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
mkdir "$FAKE_DB/advisory.lock"
( sleep 2; rmdir "$FAKE_DB/advisory.lock" ) &
if MIGRATE_CMD="$TMP/fake-migrate job" MIGRATE_LOCK_BACKOFF=1 sh "$RETRY" >"$TMP/o2" 2>&1; then
  pass "P1002 is retried and the migration applies once the lock frees ($(calls job) attempts)"
else
  fail "P1002 was not retried to success"; cat "$TMP/o2"
fi
wait
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
HOLD=3 LOCK_WAIT=1 MIGRATE_CMD="$TMP/fake-migrate a" MIGRATE_LOCK_BACKOFF=1 sh "$RETRY" >"$TMP/o5a" 2>&1 & pa=$!
HOLD=3 LOCK_WAIT=1 MIGRATE_CMD="$TMP/fake-migrate b" MIGRATE_LOCK_BACKOFF=1 sh "$RETRY" >"$TMP/o5b" 2>&1 & pb=$!
wait $pa; ra=$?; wait $pb; rb=$?
if [ "$ra" = 0 ] && [ "$rb" = 0 ] && grep -q P1002 "$TMP/o5a" "$TMP/o5b"; then
  pass "two concurrent migrate deploys both succeed (loser hit P1002, retried)"
else
  fail "concurrent migrators: exit codes a=$ra b=$rb"; cat "$TMP/o5a" "$TMP/o5b"
fi

# Control: without the wrapper the loser fails, i.e. the test reproduces the bug.
new_db
HOLD=3 "$TMP/fake-migrate" a >/dev/null 2>&1 & pa=$!
sleep 0.5
if LOCK_WAIT=1 "$TMP/fake-migrate" b >/dev/null 2>&1; then
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
