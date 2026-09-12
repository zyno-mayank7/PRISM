#!/usr/bin/env bash
# OBA — full verification chain: extension unit tests, server API tests,
# and the benchmark evaluator (5 metrics + privacy gates).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== 1/3  extension unit tests (Node) =="
(cd "$ROOT/extension" && node tests/run_all.js)

echo ""
echo "== 2/3  reasoning server API tests (pytest) =="
(cd "$ROOT/server" && python3 -m pytest tests/ -q)

echo ""
echo "== 3/3  benchmark evaluator (5 metrics + privacy gates) =="
(cd "$ROOT/benchmark-suite" && python3 evaluator.py)

echo ""
echo "All verification layers passed."
