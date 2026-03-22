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
    echo "❌ .env file not found. Copy env.example and configure it."
    exit 1
fi

source .env

echo "🚀 Running Enhanced Load Tests (with proper authentication)"
echo "Target: $API_BASE_URL"
echo ""

# Create reports directory
mkdir -p reports

# Test 1: Authentication Test (enhanced with retry logic)
echo "📝 Test 1: Authentication Load Test"
echo "   Users: 50, Spawn rate: 10, Duration: 3m"
echo "   Tests: signup, login, session management"
locust \
    -f locustfiles/simple/auth_test.py \
    --headless \
    --users 50 \
    --spawn-rate 10 \
    --run-time 3m \
    --host "$API_BASE_URL" \
    --html reports/auth_enhanced_report.html \
    --csv reports/auth_enhanced

echo ""
echo "✅ Test 1 complete"
echo ""

# Test 2: Workspace CRUD (with authentication)
echo "🏢 Test 2: Workspace CRUD Load Test (Authenticated)"
echo "   Users: 30, Spawn rate: 10, Duration: 5m"
echo "   Tests: create, read, update, delete workspaces"
locust \
    -f locustfiles/simple/workspace_test.py \
    --headless \
    --users 30 \
    --spawn-rate 10 \
    --run-time 5m \
    --host "$API_BASE_URL" \
    --html reports/workspace_enhanced_report.html \
    --csv reports/workspace_enhanced

echo ""
echo "✅ Test 2 complete"
echo ""

# Test 3: API Endpoints (authenticated)
echo "🔧 Test 3: API Endpoints"
echo "   Users: 50, Spawn rate: 10, Duration: 3m"
echo "   Tests: templates, workspaces, projects, health"
locust \
    -f locustfiles/simple/api_test.py \
    --headless \
    --users 50 \
    --spawn-rate 10 \
    --run-time 3m \
    --host "$API_BASE_URL" \
    --html reports/api_enhanced_report.html \
    --csv reports/api_enhanced

echo ""
echo "✅ Test 3 complete"
echo ""

# Analyze all results
echo "📊 Analyzing results..."
python scripts/analyze_results.py --all

echo ""
echo "✅ All enhanced tests complete!"
echo "📊 Reports available in reports/ directory:"
echo "   - reports/auth_enhanced_report.html"
echo "   - reports/workspace_enhanced_report.html"
echo "   - reports/api_enhanced_report.html"
echo ""
echo "Total test duration: ~11 minutes"
