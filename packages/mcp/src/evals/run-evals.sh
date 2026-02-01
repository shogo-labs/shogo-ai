#!/bin/bash
# Run evals with checkpointing support
# Usage: ./run-evals.sh [options]

set -e

# Default values
TEMPLATE="business"
MODEL="sonnet"
WORKERS=2
PORT=7100
FRESH=""
VERBOSE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -t|--template)
      TEMPLATE="$2"
      shift 2
      ;;
    -m|--model)
      MODEL="$2"
      shift 2
      ;;
    -w|--workers)
      WORKERS="$2"
      shift 2
      ;;
    -p|--port)
      PORT="$2"
      shift 2
      ;;
    --fresh)
      FRESH="--fresh"
      shift
      ;;
    -v|--verbose)
      VERBOSE="--verbose"
      shift
      ;;
    -h|--help)
      echo "Usage: ./run-evals.sh [options]"
      echo ""
      echo "Options:"
      echo "  -t, --template <name>   Template to run (business, crm, inventory, hard, all)"
      echo "  -m, --model <name>      Model to use (sonnet, haiku, opus)"
      echo "  -w, --workers <n>       Number of parallel workers (default: 2)"
      echo "  -p, --port <n>          Server port (default: 7100)"
      echo "  --fresh                 Start fresh, ignore checkpoint"
      echo "  -v, --verbose           Enable verbose logging to file"
      echo "  -h, --help              Show this help"
      echo ""
      echo "Examples:"
      echo "  ./run-evals.sh                           # Resume business evals with sonnet"
      echo "  ./run-evals.sh --fresh                   # Start fresh business evals"
      echo "  ./run-evals.sh -t crm -w 4               # Run CRM evals with 4 workers"
      echo "  ./run-evals.sh -t all -m haiku --fresh   # Run all evals with haiku, fresh start"
      echo "  ./run-evals.sh -v --fresh                # Fresh run with verbose logging"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "🚀 Starting Eval Runner"
echo "   Template: $TEMPLATE"
echo "   Model: $MODEL"
echo "   Workers: $WORKERS"
echo "   Port: $PORT"
if [ -n "$VERBOSE" ]; then
  echo "   Verbose: enabled"
fi
echo ""

# Check for existing checkpoint
if [ -z "$FRESH" ] && [ -f /tmp/eval-checkpoint.json ]; then
  COMPLETED=$(cat /tmp/eval-checkpoint.json | jq -r '.completedEvalIds | length')
  LAST_UPDATE=$(cat /tmp/eval-checkpoint.json | jq -r '.lastUpdated')
  COST=$(cat /tmp/eval-checkpoint.json | jq -r '.totalCost // 0')
  echo "📥 Found checkpoint: $COMPLETED completed (last updated: $LAST_UPDATE)"
  if [ "$COST" != "0" ] && [ "$COST" != "null" ]; then
    printf "   Cost so far: \$%.4f\n" "$COST"
  fi
  echo "   Use --fresh to start over"
  echo ""
fi

# Clean up any lingering processes
echo "🧹 Cleaning up old processes..."
pkill -f "eval-server" 2>/dev/null || true
pkill -f "eval-worker" 2>/dev/null || true
lsof -ti:$PORT | xargs kill -9 2>/dev/null || true
sleep 2

# Start the server
echo "🔧 Starting eval server..."
bun run src/evals/eval-server.ts \
  --template "$TEMPLATE" \
  --model "$MODEL" \
  --workers "$WORKERS" \
  --port "$PORT" \
  $FRESH $VERBOSE 2>&1 | tee /tmp/eval-server.log &

SERVER_PID=$!
echo "   Server PID: $SERVER_PID"

# Wait for server to start
sleep 10

# Monitor loop
echo ""
echo "📊 Monitoring progress (Ctrl+C to stop monitoring, evals will continue)"
echo "   Check status: curl http://localhost:$PORT/status"
echo "   View results: curl http://localhost:$PORT/results"
echo ""

check_status() {
  curl -s --max-time 5 "http://localhost:$PORT/status" 2>/dev/null
}

while true; do
  STATUS=$(check_status)
  
  if [ -z "$STATUS" ]; then
    # Server not responding, check if process is still running
    if ! kill -0 $SERVER_PID 2>/dev/null; then
      # Check if completed
      if [ ! -f /tmp/eval-checkpoint.json ]; then
        echo ""
        echo "✅ Eval run completed!"
        RESULTS=$(ls -t /tmp/eval-results-*.json 2>/dev/null | head -1)
        if [ -n "$RESULTS" ]; then
          echo ""
          echo "📊 Results Summary:"
          cat "$RESULTS" | jq '.summary'
          echo ""
          echo "📁 Full results: $RESULTS"
        fi
        exit 0
      else
        echo ""
        echo "⚠️  Server stopped. Checkpoint saved at $(cat /tmp/eval-checkpoint.json | jq -r '.completedEvalIds | length')/32"
        echo "   Run again to resume from checkpoint"
        exit 1
      fi
    fi
    echo "$(date '+%H:%M:%S') ⏳ Server starting..."
  else
    PROGRESS=$(echo "$STATUS" | jq -r '.progress')
    PERCENT=$(echo "$STATUS" | jq -r '.percent')
    ACTIVE=$(echo "$STATUS" | jq -r '.activeWorkers | length')
    STATUS_STATE=$(echo "$STATUS" | jq -r '.status')
    COST=$(echo "$STATUS" | jq -r '.cost // "$0.0000"')
    
    if [ "$STATUS_STATE" = "complete" ]; then
      echo ""
      echo "✅ Eval run completed!"
      RESULTS=$(ls -t /tmp/eval-results-*.json 2>/dev/null | head -1)
      if [ -n "$RESULTS" ]; then
        echo ""
        echo "📊 Results Summary:"
        cat "$RESULTS" | jq '.summary'
        echo ""
        echo "💰 Cost:"
        cat "$RESULTS" | jq '.cost'
        echo ""
        echo "📁 Full results: $RESULTS"
      fi
      exit 0
    fi
    
    echo "$(date '+%H:%M:%S') 📈 Progress: $PROGRESS ($PERCENT) - $ACTIVE workers active - Cost: $COST"
  fi
  
  sleep 30
done
