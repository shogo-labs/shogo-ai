#!/bin/bash
set -e

echo "🚀 Setting up Shogo AI Load Testing Environment..."

# Check Python version
python_version=$(python3 --version 2>&1 | grep -oE '[0-9]+\.[0-9]+')
required_version="3.9"

if [ "$(printf '%s\n' "$required_version" "$python_version" | sort -V | head -n1)" != "$required_version" ]; then
    echo "❌ Error: Python 3.9+ required (found $python_version)"
    exit 1
fi

echo "✅ Python version: $python_version"

# Create virtual environment
echo "📦 Creating virtual environment..."
python3 -m venv .venv

# Activate virtual environment
source .venv/bin/activate

# Upgrade pip
echo "📦 Upgrading pip..."
pip install --upgrade pip --quiet

# Install dependencies
echo "📦 Installing dependencies..."
pip install -r requirements.txt --quiet

# Copy environment template if needed
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ Created .env file"
    echo "⚠️  Please configure .env with your staging credentials"
else
    echo "✅ .env file already exists"
fi

# Create reports directory
mkdir -p reports
echo "✅ Created reports directory"

# Make scripts executable
chmod +x scripts/*.sh scripts/*.py 2>/dev/null || true

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. source .venv/bin/activate"
echo "  2. Configure .env with your staging credentials"
echo "  3. Run tests: bash scripts/run_simple.sh"
