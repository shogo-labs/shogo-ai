#!/bin/bash
# =============================================================================
# Multi-Region Load Test — Parallel dry-run simulation across US, EU, India
# =============================================================================
# Launches 3 locust instances in parallel, one per production OCI region,
# targeting each region's Kourier LB IP directly with Host: studio.shogo.ai.
#
# Each region gets a non-overlapping user ID range to avoid signup collisions.
#
# Usage:
#   bash scripts/run_multiregion.sh [--users N] [--time Tm] [--skip-cleanup]
#
# Required env vars (set in .env or export before running):
#   US_HOST       - US region Kourier LB endpoint   (e.g. https://129.x.x.x)
#   EU_HOST       - EU region Kourier LB endpoint   (e.g. https://141.x.x.x)
#   INDIA_HOST    - India region Kourier LB endpoint (e.g. https://152.x.x.x)
#   LOAD_TEST_SECRET - Rate-limit bypass key (must match server env)
#   ADMIN_EMAIL   - Super admin email for post-test cleanup
#   ADMIN_PASSWORD - Super admin password for post-test cleanup
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# ---- Load env first (CLI args override below) ----
if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi

# ---- Activate venv ----
if [ -f ".venv/bin/activate" ]; then
  source .venv/bin/activate
fi

# ---- Defaults (after .env, so .env values are picked up) ----
USERS_PER_REGION=${USERS_PER_REGION:-50}
SPAWN_RATE=${SPAWN_RATE:-5}
RUN_TIME=${RUN_TIME:-10m}
HOST_HEADER=${HOST_HEADER:-studio.shogo.ai}
SKIP_CLEANUP=false

# ---- Parse CLI args (override everything) ----
while [[ $# -gt 0 ]]; do
  case $1 in
    --users)       USERS_PER_REGION="$2"; shift 2 ;;
    --time)        RUN_TIME="$2"; shift 2 ;;
    --spawn-rate)  SPAWN_RATE="$2"; shift 2 ;;
    --skip-cleanup) SKIP_CLEANUP=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ---- Validate required vars ----
missing=()
[ -z "$US_HOST" ]    && missing+=("US_HOST")
[ -z "$EU_HOST" ]    && missing+=("EU_HOST")
[ -z "$INDIA_HOST" ] && missing+=("INDIA_HOST")

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: Missing required env vars: ${missing[*]}"
  echo ""
  echo "Set them in .env or export before running. Example:"
  echo "  export US_HOST=https://129.x.x.x"
  echo "  export EU_HOST=https://141.x.x.x"
  echo "  export INDIA_HOST=https://152.x.x.x"
  exit 1
fi

if [ -z "$LOAD_TEST_SECRET" ]; then
  echo "WARNING: LOAD_TEST_SECRET not set — rate limiting will throttle the test"
fi

# ---- Setup reports ----
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_DIR="reports/multiregion_${TIMESTAMP}"
mkdir -p "$REPORT_DIR"

echo "============================================================"
echo "  Multi-Region Load Test"
echo "============================================================"
echo "  Users/region:  $USERS_PER_REGION"
echo "  Spawn rate:    $SPAWN_RATE/s"
echo "  Duration:      $RUN_TIME"
echo "  Host header:   $HOST_HEADER"
echo ""
echo "  US host:       $US_HOST"
echo "  EU host:       $EU_HOST"
echo "  India host:    $INDIA_HOST"
echo ""
echo "  Reports:       $REPORT_DIR/"
echo "  Cleanup:       $([ "$SKIP_CLEANUP" = true ] && echo 'SKIPPED' || echo 'after test')"
echo "============================================================"
echo ""

# ---- Launch locust instances in parallel ----
# Each region gets its own user ID range and region label.

pids=()

echo "[US] Starting locust (user_ids 100000-199999)..."
REGION_LABEL=us \
USER_ID_MIN=100000 USER_ID_MAX=199999 \
HOST_HEADER="$HOST_HEADER" \
LOAD_TEST_SECRET="${LOAD_TEST_SECRET:-}" \
TEST_USER_PREFIX="${TEST_USER_PREFIX:-loadtest-user}" \
TEST_USER_PASSWORD="${TEST_USER_PASSWORD:-LoadTest123!}" \
locust \
  -f locustfiles/complex/dry_run_simulation.py \
  --host "$US_HOST" \
  --users "$USERS_PER_REGION" \
  --spawn-rate "$SPAWN_RATE" \
  --run-time "$RUN_TIME" \
  --headless \
  --html "${REPORT_DIR}/us.html" \
  --csv "${REPORT_DIR}/us" \
  --print-stats \
  --only-summary \
  2>&1 | sed 's/^/[US] /' &
pids+=($!)

echo "[EU] Starting locust (user_ids 200000-299999)..."
REGION_LABEL=eu \
USER_ID_MIN=200000 USER_ID_MAX=299999 \
HOST_HEADER="$HOST_HEADER" \
LOAD_TEST_SECRET="${LOAD_TEST_SECRET:-}" \
TEST_USER_PREFIX="${TEST_USER_PREFIX:-loadtest-user}" \
TEST_USER_PASSWORD="${TEST_USER_PASSWORD:-LoadTest123!}" \
locust \
  -f locustfiles/complex/dry_run_simulation.py \
  --host "$EU_HOST" \
  --users "$USERS_PER_REGION" \
  --spawn-rate "$SPAWN_RATE" \
  --run-time "$RUN_TIME" \
  --headless \
  --html "${REPORT_DIR}/eu.html" \
  --csv "${REPORT_DIR}/eu" \
  --print-stats \
  --only-summary \
  2>&1 | sed 's/^/[EU] /' &
pids+=($!)

echo "[IN] Starting locust (user_ids 300000-399999)..."
REGION_LABEL=india \
USER_ID_MIN=300000 USER_ID_MAX=399999 \
HOST_HEADER="$HOST_HEADER" \
LOAD_TEST_SECRET="${LOAD_TEST_SECRET:-}" \
TEST_USER_PREFIX="${TEST_USER_PREFIX:-loadtest-user}" \
TEST_USER_PASSWORD="${TEST_USER_PASSWORD:-LoadTest123!}" \
locust \
  -f locustfiles/complex/dry_run_simulation.py \
  --host "$INDIA_HOST" \
  --users "$USERS_PER_REGION" \
  --spawn-rate "$SPAWN_RATE" \
  --run-time "$RUN_TIME" \
  --headless \
  --html "${REPORT_DIR}/india.html" \
  --csv "${REPORT_DIR}/india" \
  --print-stats \
  --only-summary \
  2>&1 | sed 's/^/[IN] /' &
pids+=($!)

echo ""
echo "Waiting for all 3 regions to finish (PIDs: ${pids[*]})..."
echo ""

# ---- Wait for all and track failures ----
failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    ((failed++)) || true
  fi
done

echo ""
echo "============================================================"
echo "  All regions finished. Failures: $failed/3"
echo "  Reports: $REPORT_DIR/"
echo "============================================================"

# ---- Cleanup ----
if [ "$SKIP_CLEANUP" = true ]; then
  echo ""
  echo "Cleanup skipped (--skip-cleanup). Run manually:"
  echo "  python scripts/cleanup_loadtest.py --host https://studio.shogo.ai"
else
  echo ""
  echo "Running post-test cleanup (each region for K8s pod cleanup)..."

  for region_name in US EU India; do
    case $region_name in
      US)    region_host="$US_HOST" ;;
      EU)    region_host="$EU_HOST" ;;
      India) region_host="$INDIA_HOST" ;;
    esac
    echo ""
    echo "--- Cleaning up $region_name ($region_host) ---"
    python scripts/cleanup_loadtest.py \
      --host "$region_host" \
      --host-header "$HOST_HEADER" \
      --prefix "${TEST_USER_PREFIX:-loadtest-user}" || true
  done
fi

echo ""
echo "Done."
