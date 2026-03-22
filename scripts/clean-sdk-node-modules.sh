#!/usr/bin/env bash
set -euo pipefail

SDK_DIR="$(cd "$(dirname "$0")/../packages/sdk" && pwd)"

echo "Finding node_modules directories under $SDK_DIR ..."

found=0
while IFS= read -r -d '' dir; do
  size=$(du -sh "$dir" 2>/dev/null | cut -f1 || echo "unknown")
  echo "  Removing $dir ($size)"
  rm -rf "$dir"
  ((found++))
done < <(find "$SDK_DIR" -name node_modules -type d -prune -print0)

if [ "$found" -eq 0 ]; then
  echo "No node_modules directories found."
else
  echo "Done — removed $found node_modules directory(ies)."
fi
