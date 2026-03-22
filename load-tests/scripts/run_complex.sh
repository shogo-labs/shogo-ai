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

echo "🚀 Running Complex Load Tests..."
echo "Target: $API_BASE_URL"
echo ""

# Setup test data first
echo "📊 Setting up test data..."
python scripts/setup_test_data.py \
    --env staging \
    --users 150 \
    --workspaces 10 \
    --projects 8

echo ""
echo "✅ Test data setup complete"
echo ""

# Create reports directory
mkdir -p reports

# Test 2.1: Multi-Tenant Simulation (150 users, 30 min)
echo "🏢 Test 2.1: Multi-Tenant Workspace Simulation"
echo "   Users: 150, Spawn rate: 15, Duration: 30m"
locust \
    -f locustfiles/complex/multi_tenant_test.py \
    --headless \
    --users 150 \
    --spawn-rate 15 \
    --run-time 30m \
    --host "$API_BASE_URL" \
    --html reports/multi_tenant_report.html \
    --csv reports/multi_tenant

echo ""
echo "✅ Test 2.1 complete"
echo ""

# Test 2.2: Cold Start Stress (100 users, 15 min)
echo "❄️  Test 2.2: Agent Runtime Cold Start Stress Test"
echo "   Users: 100, Spawn rate: 50, Duration: 15m"
locust \
    -f locustfiles/complex/cold_start_test.py \
    --headless \
    --users 100 \
    --spawn-rate 50 \
    --run-time 15m \
    --host "$API_BASE_URL" \
    --html reports/cold_start_report.html \
    --csv reports/cold_start

echo ""
echo "✅ Test 2.2 complete"
echo ""

# Test 2.3: Chat Heavy Workload (100 users, 20 min)
echo "💬 Test 2.3: Chat-Heavy Workload"
echo "   Users: 100, Spawn rate: 10, Duration: 20m"
locust \
    -f locustfiles/complex/chat_heavy_test.py \
    --headless \
    --users 100 \
    --spawn-rate 10 \
    --run-time 20m \
    --host "$API_BASE_URL" \
    --html reports/chat_heavy_report.html \
    --csv reports/chat_heavy

echo ""
echo "✅ Test 2.3 complete"
echo ""

# Test 2.4: Data Intensive Operations (50 users, 20 min)
echo "📊 Test 2.4: Data-Intensive Operations"
echo "   Users: 50, Spawn rate: 5, Duration: 20m"
locust \
    -f locustfiles/complex/data_intensive_test.py \
    --headless \
    --users 50 \
    --spawn-rate 5 \
    --run-time 20m \
    --host "$API_BASE_URL" \
    --html reports/data_intensive_report.html \
    --csv reports/data_intensive

echo ""
echo "✅ Test 2.4 complete"
echo ""

# Analyze results
echo "📊 Analyzing results..."
python scripts/analyze_results.py --all

echo ""
echo "✅ All complex tests complete!"
echo "📊 Reports available in reports/ directory"
