#!/bin/bash
set -e

# Test authenticated CRUD operations with cookie-based auth

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

echo "🔐 Testing Authenticated CRUD Operations"
echo "Target: $API_BASE_URL"
echo ""
echo "This test validates:"
echo "  ✅ Cookie-based session authentication"
echo "  ✅ Workspace CRUD operations"
echo "  ✅ Project CRUD operations"
echo "  ✅ Session persistence across requests"
echo ""

# Create reports directory
mkdir -p reports

# Run authenticated workspace CRUD test
echo "📝 Test: Authenticated Workspace & Project CRUD"
echo "   Users: 50, Spawn rate: 10, Duration: 5m"
echo "   Operations: list, create, update, delete workspaces & projects"
echo ""

locust \
    -f locustfiles/simple/workspace_test.py \
    --headless \
    --users 50 \
    --spawn-rate 10 \
    --run-time 5m \
    --host "$API_BASE_URL" \
    --html reports/workspace_crud_authenticated.html \
    --csv reports/workspace_crud_authenticated

EXIT_CODE=$?

echo ""
echo "✅ Test complete"
echo ""

# Analyze results
echo "📊 Analyzing results..."
python scripts/analyze_results.py --report reports/workspace_crud_authenticated

echo ""
echo "📊 Report available at: reports/workspace_crud_authenticated.html"

# Check if test passed (exit code 0 means all requests succeeded)
if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "✅ SUCCESS: All authenticated CRUD operations working!"
    echo ""
    echo "🎉 Cookie-based authentication is properly configured."
    echo "   - Session cookies are being set on login/signup"
    echo "   - Cookies are automatically sent with API requests"
    echo "   - Protected /api/v2/* endpoints accept authenticated requests"
    exit 0
else
    echo ""
    echo "⚠️  Some operations failed. Check the report for details."
    echo ""
    echo "Common issues:"
    echo "  - 401 errors: Session cookies not being set or sent"
    echo "  - 400 errors: Validation issues (expected for some operations)"
    echo "  - 404 errors: Endpoints not available"
    exit 1
fi
