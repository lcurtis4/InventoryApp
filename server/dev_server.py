#!/usr/bin/env python3
"""
dev_server.py — YGO Inventory local dev server
Serves files on PORT (default 8765) with Cache-Control: no-store so the
browser always fetches the latest JS/CSS instead of returning 304s.

Usage:
  python3 server/dev_server.py [port]
"""
import sys
import os
from http.server import SimpleHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

class NoCacheHandler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with cache-busting headers on every response."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma",        "no-cache")
        self.send_header("Expires",       "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Suppress the flood of 304 / 200 lines so the terminal stays readable
        status = args[1] if len(args) > 1 else "?"
        if status not in ("304",):
            super().log_message(fmt, *args)

if __name__ == "__main__":
    # Serve from the repo root (one level up from server/)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    server = HTTPServer(("", PORT), NoCacheHandler)
    print(f"Dev server (no-cache) → http://localhost:{PORT}/")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
