#!/bin/bash
set -e

if [ -f ".deps-installed" ]; then
  echo "Dependencies already installed, skipping."
  exit 0
fi

echo "Installing Python data science dependencies..."
pip install --no-cache-dir -r requirements.txt

mkdir -p data/raw data/processed output/figures output/reports notebooks scripts

touch .deps-installed
echo "Setup complete."
