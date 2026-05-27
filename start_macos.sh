#!/usr/bin/env bash
# YGO Scanner — macOS / Linux launcher
# Starts a local HTTP server on port 8765 and opens the app in the default browser.
# Requirements: Python 3 (pre-installed on macOS 12+) or Node.js.

set -euo pipefail

PORT=8765
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting local server at http://localhost:${PORT}/ ..."
echo "Press Ctrl+C to stop."
echo ""

# Open the browser in background after a short delay
(sleep 1 && open "http://localhost:${PORT}/" 2>/dev/null || \
           xdg-open "http://localhost:${PORT}/" 2>/dev/null || \
           echo "Open http://localhost:${PORT}/ in your browser.") &

cd "$SCRIPT_DIR"

# Try Python 3 first, then fall back to node/npx
if command -v python3 &>/dev/null; then
    python3 -m http.server "${PORT}"
elif command -v python &>/dev/null && python -c "import sys; assert sys.version_info[0]==3" 2>/dev/null; then
    python -m http.server "${PORT}"
elif command -v npx &>/dev/null; then
    npx --yes http-server . -p "${PORT}" --cors -o
else
    echo "ERROR: Neither Python 3 nor Node.js (npx) found."
    echo "Install Python 3 from https://python.org or Node.js from https://nodejs.org"
    exit 1
fi
