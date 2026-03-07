#!/bin/bash
# =============================================================================
# Agent Runtime Load Test — Exercises agent-runtime pod endpoints
# =============================================================================
# Usage:
#   bash scripts/run_agent_runtime.sh                       # Default: 5 users, 5m
#   bash scripts/run_agent_runtime.sh --users 10 --time 10m # Custom
#   bash scripts/run_agent_runtime.sh --soak                # Soak: 3 users, 30m
#   bash scripts/run_agent_runtime.sh --stress              # Stress: 20 users, 10m
#   bash scripts/run_agent_runtime.sh --tags health,files   # Only tagged tests
#
# This test creates agent projects on staging and hits the agent-runtime
# endpoints via the API server's agent-proxy path.
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# Load env FIRST (before defaults so CLI flags can override)
if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi

# Defaults — conservative to avoid burning LLM credits
USERS=${USERS:-5}
SPAWN_RATE=${SPAWN_RATE:-2}
RUN_TIME=${RUN_TIME:-5m}
HOST=${HOST:-https://app.example.com}
TAGS=""

# Parse CLI args (override everything)
while [[ $# -gt 0 ]]; do
  case $1 in
    --users) USERS="$2"; shift 2 ;;
    --time) RUN_TIME="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --spawn-rate) SPAWN_RATE="$2"; shift 2 ;;
    --tags) TAGS="$2"; shift 2 ;;
    --soak)
      USERS=3
      SPAWN_RATE=1
      RUN_TIME=30m
      shift ;;
    --stress)
      USERS=20
      SPAWN_RATE=5
      RUN_TIME=10m
      shift ;;
    --no-chat)
      TAGS="health,status,files,catalog,dynamic-app,logs,export"
      shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "============================================"
echo "Agent Runtime Load Test"
echo "============================================"
echo "Users:      $USERS"
echo "Spawn rate: $SPAWN_RATE/s"
echo "Duration:   $RUN_TIME"
echo "Host:       $HOST"
if [ -n "$TAGS" ]; then
  echo "Tags:       $TAGS"
fi
echo "============================================"

# Activate venv if it exists
if [ -f ".venv/bin/activate" ]; then
  source .venv/bin/activate
elif [ -f "venv/bin/activate" ]; then
  source venv/bin/activate
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REPORT_PREFIX="reports/agent_runtime_${TIMESTAMP}"

mkdir -p reports

LOCUST_ARGS=(
  -f locustfiles/complex/agent_runtime_test.py
  --host "$HOST"
  --users "$USERS"
  --spawn-rate "$SPAWN_RATE"
  --run-time "$RUN_TIME"
  --headless
  --html "${REPORT_PREFIX}.html"
  --csv "${REPORT_PREFIX}"
  --print-stats
  --only-summary
)

if [ -n "$TAGS" ]; then
  LOCUST_ARGS+=(--tags "$TAGS")
fi

locust "${LOCUST_ARGS[@]}"

echo ""
echo "============================================"
echo "Report:  ${REPORT_PREFIX}.html"
echo "CSV:     ${REPORT_PREFIX}_stats.csv"
echo "============================================"
