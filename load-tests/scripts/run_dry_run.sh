#!/bin/bash
# =============================================================================
# Dry Run Simulation - Reproduces concurrent user scenario
# =============================================================================
# Usage: bash scripts/run_dry_run.sh [--users N] [--time Tm]
#
# Default: 15 users, 10-minute run (simulates a team dry run)
# Aggressive: 30 users, 15-minute run (pre-production stress test)
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# Defaults
USERS=${USERS:-15}
SPAWN_RATE=${SPAWN_RATE:-5}
RUN_TIME=${RUN_TIME:-10m}
HOST=${HOST:-https://api-staging.shogo.ai}

# Parse CLI args
while [[ $# -gt 0 ]]; do
  case $1 in
    --users) USERS="$2"; shift 2 ;;
    --time) RUN_TIME="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --aggressive)
      USERS=30
      SPAWN_RATE=10
      RUN_TIME=15m
      shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "============================================"
echo "Dry Run Simulation"
echo "============================================"
echo "Users:      $USERS"
echo "Spawn rate: $SPAWN_RATE/s"
echo "Duration:   $RUN_TIME"
echo "Host:       $HOST"
echo "============================================"

# Activate venv if it exists
if [ -f ".venv/bin/activate" ]; then
  source .venv/bin/activate
fi

# Load env
if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_PREFIX="reports/dry_run_${TIMESTAMP}"

locust \
  -f locustfiles/complex/dry_run_simulation.py \
  --host "$HOST" \
  --users "$USERS" \
  --spawn-rate "$SPAWN_RATE" \
  --run-time "$RUN_TIME" \
  --headless \
  --html "${REPORT_PREFIX}.html" \
  --csv "${REPORT_PREFIX}" \
  --print-stats \
  --only-summary

echo ""
echo "Report saved to: ${REPORT_PREFIX}.html"
echo "CSV data saved to: ${REPORT_PREFIX}_stats.csv"
