#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Shogo Worker installer. Mirrors the Cursor `curl https://cursor.com/install | bash` UX.
set -euo pipefail

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js 20+ first: https://nodejs.org" >&2
  exit 1
fi

echo "Installing @shogo-ai/worker globally..."
npm install -g @shogo-ai/worker

echo ""
echo "✓ Installed. Next steps:"
echo "    shogo login"
echo "    shogo worker start"
