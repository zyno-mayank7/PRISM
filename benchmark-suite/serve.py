#!/usr/bin/env python3
"""Serve the benchmark suite (demo pages + index) on http://127.0.0.1:8080."""
import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"OBA benchmark bench served at http://127.0.0.1:{PORT}")
    print("Open http://127.0.0.1:8080 in Chrome/Edge and run the extension sidepanel.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
