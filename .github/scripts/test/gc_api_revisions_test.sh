#!/usr/bin/env bash
# Tests for .github/scripts/gc-old-api-revisions.sh (WO-5, plan §4).
#
# The bug: deleting an obsolete Revision leaves the activator's per-revision
# concurrency reporter ticking against a name that no longer exists, so every
# activator pod logs `Error while getting revision` on every tick for as long as
# it lives. Two pods were writing ~5.2M ERROR rows/24h that way — 99.8% of the
# plane's error volume. The fix is a conditional `rollout restart` of
# knative-serving/activator after a deletion actually happened.
#
# The fake kubectl answers the three reads the script performs and appends every
# argv line to $FAKE_CALLS, so "did it restart the activator?" is asserted from
# the args the script handed kubectl, not inferred from exit codes.
#
#   bash .github/scripts/test/gc_api_revisions_test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/gc-old-api-revisions.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }

mkdir -p "$TMP/bin"
cat >"$TMP/bin/kubectl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_CALLS"
case "$*" in
  *"rollout restart"*)
    [ "${FAKE_ROLLOUT_FAILS-}" = "1" ] && exit 1
    exit 0
    ;;
esac
if [ "$1" = "get" ]; then
  case "$*" in
    *latestReadyRevisionName*) printf '%s' "${FAKE_LATEST_READY-}"; exit 0 ;;
    *latestCreatedRevisionName*) printf '%s' "${FAKE_LATEST_CREATED-}"; exit 0 ;;
  esac
  if [ "$2" = "revision" ]; then
    printf '%s\n' ${FAKE_REVISIONS-}
  fi
fi
exit 0
EOF
chmod +x "$TMP/bin/kubectl"
FAKE_CALLS="$TMP/calls"
export FAKE_CALLS
NS="shogo-system"

called() { grep -qF -- "$1" "$FAKE_CALLS"; }
not_called() { ! grep -qF -- "$1" "$FAKE_CALLS"; }

# run <name> — invoke the script with the current FAKE_* env and capture output.
run() {
  : >"$FAKE_CALLS"
  PATH="$TMP/bin:$PATH" bash "$SCRIPT" "$NS" >"$TMP/$1.out" 2>&1
}

# --- 1. One deletion ⇒ the revision is deleted AND the activator is rolled ---
export FAKE_LATEST_READY="api-00640" FAKE_LATEST_CREATED="api-00641"
export FAKE_REVISIONS="api-00639 api-00640 api-00641"
if run r1; then
  pass "run 1 exits 0"
else
  fail "run 1 exited non-zero"; cat "$TMP/r1.out"
fi
if called "delete revision -n $NS api-00639"; then
  pass "run 1 deletes the obsolete revision"
else
  fail "run 1 did not delete api-00639"; cat "$TMP/calls"
fi
if [ "$(grep -c 'delete revision' "$FAKE_CALLS")" = "1" ]; then
  pass "run 1 deletes only the obsolete revision, keeps Ready + latestCreated"
else
  fail "run 1 deleted $(grep -c 'delete revision' "$FAKE_CALLS") revisions, expected 1"
fi
# The regression this order exists for: without the new block this line is
# absent (the only `rollout restart` in argv would be the one being added).
if called "-n knative-serving rollout restart deploy/activator --wait=false"; then
  pass "run 1 rolls knative-serving/activator --wait=false after a deletion"
else
  fail "run 1 did not roll the activator"; cat "$TMP/calls"
fi

# --- 2. Nothing to delete ⇒ nothing restarts ---
export FAKE_LATEST_READY="api-00641" FAKE_LATEST_CREATED="api-00641"
export FAKE_REVISIONS="api-00641"
if run r2; then
  pass "run 2 exits 0"
else
  fail "run 2 exited non-zero"; cat "$TMP/r2.out"
fi
if not_called "delete revision"; then
  pass "run 2 deletes nothing"
else
  fail "run 2 deleted a kept revision"; cat "$TMP/calls"
fi
if not_called "rollout restart"; then
  pass "run 2 does not roll the activator (no-op deploy stays a no-op)"
else
  fail "run 2 rolled the activator with nothing to GC"; cat "$TMP/calls"
fi

# --- 3. No Ready revision ⇒ refuse to GC, and do not touch the activator ---
export FAKE_LATEST_READY="" FAKE_LATEST_CREATED="api-00641"
export FAKE_REVISIONS="api-00639 api-00641"
if run r3; then
  fail "run 3 exited 0 with no latestReadyRevisionName"
else
  pass "run 3 refuses to GC (exit 1) when the ksvc has no Ready revision"
fi
if grep -q "has no latestReadyRevisionName" "$TMP/r3.out"; then
  pass "run 3 explains why it refused"
else
  fail "run 3 refused without the guard message"; cat "$TMP/r3.out"
fi
if not_called "rollout restart" && not_called "delete revision"; then
  pass "run 3 leaves both revisions and the activator alone"
else
  fail "run 3 mutated the cluster before the refuse-to-GC guard"; cat "$TMP/calls"
fi

# --- 4. A restart that fails must not fail the deploy ---
export FAKE_LATEST_READY="api-00640" FAKE_LATEST_CREATED="api-00641"
export FAKE_REVISIONS="api-00639 api-00640 api-00641"
export FAKE_ROLLOUT_FAILS="1"
if run r4; then
  pass "run 4 stays green when the activator restart is denied (RBAC/absent ns)"
else
  fail "run 4 failed on a restart error"; cat "$TMP/r4.out"
fi
if grep -q "::warning::gc-old-api-revisions: could not restart" "$TMP/r4.out"; then
  pass "run 4 reports the restart failure as a warning"
else
  fail "run 4 swallowed the restart failure"; cat "$TMP/r4.out"
fi
if called "delete revision -n $NS api-00639"; then
  pass "run 4 still deleted the revision it could"
else
  fail "run 4 skipped the deletion because the restart failed"; cat "$TMP/calls"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "all passed"
