#!/bin/sh
# .github/scripts/lib/prisma-migrate-retry.sh
#
# `prisma migrate deploy`, retried while another migrator holds Prisma's
# advisory lock (SHO-275).
#
# Prisma serialises migrators with `pg_advisory_lock(72707369)` and gives up
# after 10 s with P1002. In a region deploy there are always two migrators on
# the same database: `Apply Kubernetes manifests` boots the new api revision,
# whose entrypoint runs `migrate deploy` (SKIP_MIGRATIONS=false), and seconds
# later `run-prisma-migrations.sh` submits its Job. Whichever loses the lock
# saw P1002 and, for the Job (backoffLimit: 0), failed the whole region
# deploy (v2.4.7, 2026-10-31) although the winner applied every migration.
#
# A lock timeout is retried with bounded backoff; any other failure (P3009,
# P3018, SQL errors) exits immediately with prisma's exit code, so a real
# migration error still fails the deploy on the first attempt.
#
# Runs inside the shogo-api image (debian, /bin/sh = dash): POSIX sh only.
# `run-prisma-migrations.sh` ships this file into the Job verbatim, so it
# works with any api image, including one being rolled back to.
#
# Env:
#   MIGRATE_CMD               command to run (default: bunx prisma migrate deploy)
#   MIGRATE_LOCK_ATTEMPTS     total attempts on lock timeouts (default 8)
#   MIGRATE_LOCK_BACKOFF      first backoff in seconds, doubled, capped at 60 (default 5)

MIGRATE_CMD="${MIGRATE_CMD:-bunx prisma migrate deploy}"
attempts="${MIGRATE_LOCK_ATTEMPTS:-8}"
backoff="${MIGRATE_LOCK_BACKOFF:-5}"

out="$(mktemp 2>/dev/null || echo "/tmp/prisma-migrate.$$")"
trap 'rm -f "$out"' EXIT

attempt=1
while :; do
  # Run in a subshell so `set -e` / pipefail differences across shells can't
  # lose prisma's exit code; output is still streamed to the Job log.
  sh -c "$MIGRATE_CMD" >"$out" 2>&1
  status=$?
  cat "$out"

  if [ "$status" -eq 0 ]; then
    [ "$attempt" -gt 1 ] && echo "[migrate] applied on attempt ${attempt}"
    exit 0
  fi

  if ! grep -Eq 'P1002|advisory lock' "$out"; then
    echo "[migrate] prisma migrate deploy failed (exit ${status}); not a lock timeout, not retrying"
    exit "$status"
  fi

  if [ "$attempt" -ge "$attempts" ]; then
    echo "[migrate] advisory lock still held after ${attempts} attempts; giving up"
    exit "$status"
  fi

  echo "[migrate] another migrator holds the advisory lock (P1002); retry ${attempt}/$((attempts - 1)) in ${backoff}s"
  sleep "$backoff"
  attempt=$((attempt + 1))
  backoff=$((backoff * 2))
  [ "$backoff" -gt 60 ] && backoff=60
done
