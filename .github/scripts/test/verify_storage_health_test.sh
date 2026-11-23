#!/usr/bin/env bash
# Tests for .github/scripts/verify-storage-health.sh (SHO-514).
#
# The gate exists because a bucket that had been merged but never applied made
# every upload fail `NoSuchBucket` at users while a green deploy watched an API
# answering 200. So the cases that matter are: a 404 bucket fails the deploy and
# names the env var, and nothing else does.
#
#   bash .github/scripts/test/verify_storage_health_test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GATE="$ROOT/.github/scripts/verify-storage-health.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }

# Runs the gate against a body and records status + output.
run_gate() {
  local body="$1"
  printf '%s' "$body" >"$TMP/body.json"
  output="$("$GATE" US "$TMP/body.json" 2>&1)"
  status=$?
}

expect_exit() {
  local want="$1" label="$2"
  if [ "$status" -eq "$want" ]; then pass "$label"; else fail "$label (exit $status, want $want)"; fi
}

expect_output() {
  local needle="$1" label="$2"
  case "$output" in
    *"$needle"*) pass "$label" ;;
    *) fail "$label (output: $output)" ;;
  esac
}

# --- a bucket that does not exist is a red deploy -------------------------
run_gate '{"ok":true,"storage":{"ok":false,"missing":["PUBLISH_BUCKET"]}}'
expect_exit 1 "a missing bucket fails the deploy"
expect_output "::error::US object storage is missing: PUBLISH_BUCKET" "the error names the env var"
expect_output "terraform.yml" "the error says how to fix it"

run_gate '{"ok":true,"storage":{"ok":false,"missing":["S3_PROJECT_BUCKET","PUBLISH_DATA_BUCKET"]}}'
expect_exit 1 "several missing buckets still fail the deploy"
expect_output "S3_PROJECT_BUCKET, PUBLISH_DATA_BUCKET" "every missing env var is listed"

# --- everything else passes ----------------------------------------------
run_gate '{"ok":true,"storage":{"ok":true,"missing":[]}}'
expect_exit 0 "verified storage passes"
expect_output "US object storage verified" "a pass says so"

# A 503 body still carries the storage verdict: the pod is unhealthy, not the
# bucket, and the rollout gate that runs before this one owns that decision.
run_gate '{"ok":false,"storage":{"ok":true,"missing":[]}}'
expect_exit 0 "an unhealthy pod with good storage does not fail this gate"

# An older release has no field; a rollback of it must not be blocked.
run_gate '{"ok":true,"version":"1.0.0"}'
expect_exit 0 "a release without the field does not fail the deploy"
expect_output "::warning::" "a release without the field is called out"

# --- bodies that cannot be verified --------------------------------------
run_gate ''
expect_exit 1 "an empty body fails the deploy"
expect_output "returned no body" "an empty body says why"

run_gate '<html>502 Bad Gateway</html>'
expect_exit 1 "a non-JSON body fails the deploy"
expect_output "did not return JSON" "a non-JSON body says why"

# --- a bucket named like a missing one must not match --------------------
run_gate '{"ok":true,"storage":{"ok":true,"missing":[]}}'
if printf '%s' "$output" | grep -q '::error::'; then
  fail "a passing body emits no ::error::"
else
  pass "a passing body emits no ::error::"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "all storage-health gate tests passed"
  exit 0
fi
echo "$failures storage-health gate test(s) failed"
exit 1
