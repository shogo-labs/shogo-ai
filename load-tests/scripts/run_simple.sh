#!/bin/bash
set -e

# Activate virtual environment
if [ ! -d ".venv" ]; then
    echo "❌ Virtual environment not found. Run scripts/setup.sh first."
    exit 1
fi

source .venv/bin/activate

# Load configuration
if [ ! -f ".env" ]; then
    echo "❌ .env file not found. Copy .env.example and configure it."
    exit 1
fi

source .env

echo "🚀 Running Simple Load Tests..."
echo "Target: $API_BASE_URL"
echo ""

# Create reports directory
mkdir -p reports

# Test 1.1: Authentication (50-100 users, 5 min)
echo "📝 Test 1.1: Authentication Load Test"
echo "   Users: 100, Spawn rate: 10, Duration: 5m"
locust \
    -f locustfiles/simple/auth_test.py \
    --headless \
    --users 100 \
    --spawn-rate 10 \
    --run-time 5m \
    --host "$API_BASE_URL" \
    --html reports/auth_test_report.html \
    --csv reports/auth_test

echo ""
echo "✅ Test 1.1 complete"
echo ""

# Test 1.2: Workspace CRUD (100-200 users, 10 min)
echo "🏢 Test 1.2: Workspace CRUD Load Test"
echo "   Users: 200, Spawn rate: 20, Duration: 10m"
locust \
    -f locustfiles/simple/workspace_test.py \
    --headless \
    --users 200 \
    --spawn-rate 20 \
    --run-time 10m \
    --host "$API_BASE_URL" \
    --html reports/workspace_test_report.html \
    --csv reports/workspace_test

echo ""
echo "✅ Test 1.2 complete"
echo ""

# Analyze results
echo "📊 Analyzing results..."
python scripts/analyze_results.py --all

echo ""
echo "✅ All simple tests complete!"
echo "📊 Reports available in reports/ directory:"
echo "   - reports/auth_test_report.html"
echo "   - reports/workspace_test_report.html"
