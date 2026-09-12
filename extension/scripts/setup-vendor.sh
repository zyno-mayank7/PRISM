#!/usr/bin/env bash
# OBA — optional vendor setup: enables the ONNX Runtime Web (WebGPU/WASM)
# vision tier. Without these files the extension automatically runs the
# built-in heuristic-CV tier (always available, zero downloads).
#
# Usage:  bash extension/scripts/setup-vendor.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vendor

ORT_VER="1.19.2"
BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist"

echo "[1/2] ONNX Runtime Web ${ORT_VER}..."
curl -fL --retry 2 -o vendor/ort.min.js                          "$BASE/ort.min.js"
curl -fL --retry 2 -o vendor/ort-wasm-simd-threaded.jsep.mjs     "$BASE/ort-wasm-simd-threaded.jsep.mjs"
curl -fL --retry 2 -o vendor/ort-wasm-simd-threaded.jsep.wasm    "$BASE/ort-wasm-simd-threaded.jsep.wasm"
echo "  runtime ready (WebGPU execution provider with WASM fallback)."

echo "[2/2] face-detection model..."
# SCRFD face detector (Apache-2.0, hosted by immich-app). ~17 MB.
curl -fL --retry 2 -o vendor/face-detection.onnx \
  "https://huggingface.co/immich-app/buffalo_l/resolve/main/detection/model.onnx"
echo "  model ready as vendor/face-detection.onnx"
echo ""
echo "Done. The service worker will now attempt the ONNX tier first and"
echo "fall back to the heuristic-CV tier automatically if inference fails."
echo "(A model-specific output parser may be required — see"
echo " src/perception/vision-detector.js, runOrt().)"
