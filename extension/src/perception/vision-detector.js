/**
 * OBA Vision Detector — in-browser / in-worker vision inference.
 *
 * Two tiers:
 *  1. "ort-webgpu" : ONNX Runtime Web session (WebGPU execution provider
 *     with WASM fallback) loaded from extension/vendor/ when the optional
 *     vendor bundle is present (see extension/scripts/setup-vendor.sh).
 *  2. "heuristic-cpu" : pure-JS computer-vision pipeline — YCbCr skin
 *     segmentation + morphological dilation + connected-component
 *     analysis. Always available, zero downloads, deterministic.
 *     This is the offline default and the "mock inference fallback"
 *     guaranteeing the end-to-end loop on any machine.
 *
 * Pure pixel-buffer cores are Node-compatible (used by the benchmark).
 */
(function (root) {
  'use strict';
  const OBA = (root.OBA = root.OBA || {});
  const U = OBA.util || require('./../core/util.js');

  /* ------------------------------------------------------------------ *
   * Tier 2 core — skin-region face detection on an RGBA buffer
   * ------------------------------------------------------------------ */

  /** Classic YCbCr skin chroma window (Chai & Ngan). */
  function isSkinRGB(r, g, b) {
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (cb < 77 || cb > 127) return false;
    if (cr < 133 || cr > 177) return false;
    return (r + g + b) > 90; // reject near-black
  }

  function dilate(mask, gw, gh) {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let v = 0;
        for (let dy = -1; dy <= 1 && !v; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= gh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= gw) continue;
            if (mask[yy * gw + xx]) { v = 1; break; }
          }
        }
        out[y * gw + x] = v;
      }
    }
    return out;
  }

  function connectedComponents(mask, gw, gh) {
    const seen = new Uint8Array(mask.length);
    const comps = [];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || seen[i]) continue;
      const stack = [i]; seen[i] = 1;
      let minX = gw, minY = gh, maxX = 0, maxY = 0, area = 0;
      while (stack.length) {
        const j = stack.pop();
        const x = j % gw, y = (j - x) / gw;
        area++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        const nb = [j - 1, j + 1, j - gw, j + gw];
        for (let k = 0; k < 4; k++) {
          const n = nb[k];
          if (n < 0 || n >= mask.length || seen[n] || !mask[n]) continue;
          if (k === 0 && x === 0) continue;
          if (k === 1 && x === gw - 1) continue;
          seen[n] = 1; stack.push(n);
        }
      }
      comps.push({ minX, minY, maxX, maxY, area });
    }
    return comps;
  }

  /**
   * Face boxes from an RGBA pixel buffer. Pure function, Node-safe.
   * @param {{data:Uint8Array|Uint8ClampedArray, width:number, height:number}} image
   */
  function detectFacesInBuffer(image, opts) {
    opts = opts || {};
    const t0 = U.now();
    const w = image.width, h = image.height, d = image.data;
    const cell = opts.cell || 4;
    const gw = Math.max(1, Math.ceil(w / cell));
    const gh = Math.max(1, Math.ceil(h / cell));
    let mask = new Uint8Array(gw * gh);

    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const px = Math.min(w - 1, gx * cell + (cell >> 1));
        const py = Math.min(h - 1, gy * cell + (cell >> 1));
        const i = (py * w + px) * 4;
        if (isSkinRGB(d[i], d[i + 1], d[i + 2])) mask[gy * gw + gx] = 1;
      }
    }
    mask = dilate(mask, gw, gh);

    const minCells = Math.max(24, Math.floor(gw * gh * (opts.minAreaRatio || 0.0006)));
    const comps = connectedComponents(mask, gw, gh);
    const boxes = [];
    for (let c = 0; c < comps.length; c++) {
      const comp = comps[c];
      if (comp.area < minCells) continue;
      const bw = comp.maxX - comp.minX + 1;
      const bh = comp.maxY - comp.minY + 1;
      const aspect = bw / bh;
      if (aspect < 0.45 || aspect > 2.1) continue;
      const fill = comp.area / (bw * bh);
      if (fill < (opts.minFill || 0.3)) continue;
      boxes.push({
        box: {
          x: comp.minX * cell, y: comp.minY * cell,
          width: bw * cell, height: bh * cell
        },
        piiType: 'face', mode: 'blur',
        confidence: Math.min(0.92, 0.5 + fill * 0.42),
        source: 'vision', selector: null,
        evidence: 'skin-region component (fill=' + U.round(fill, 2) + ')',
        tokenKind: null
      });
    }

    return { boxes: dedupeDetections(boxes), latencyMs: U.round(U.now() - t0, 2) };
  }

  /* Simpler & correct: re-deduplicate on detection objects. */
  function dedupeDetections(dets) {
    const kept = [];
    for (const d of dets) {
      let dup = false;
      for (const k of kept) {
        if (U.iou(k.box, d.box) >= 0.25) { dup = true; break; }
      }
      if (!dup) kept.push(d);
    }
    return kept;
  }

  /* ------------------------------------------------------------------ *
   * Tier 1 — ONNX Runtime Web (WebGPU EP, WASM fallback)
   * ------------------------------------------------------------------ */
  async function runOrt(imageData, opts) {
    const ort = (opts && opts.ort) || globalThis.ort;
    const OffscreenCtor = globalThis.OffscreenCanvas;
    if (!ort) throw new Error('ort not vendored');
    if (!OffscreenCtor) throw new Error('OffscreenCanvas unavailable'); // node
    const modelUrl = (opts && opts.modelUrl) ||
      (OBA.DEFAULTS ? OBA.DEFAULTS.VENDOR_MODEL : 'vendor/face-detection.onnx');
    if (typeof globalThis.fetch !== 'function') throw new Error('fetch unavailable');
    const res = await globalThis.fetch(modelUrl);
    if (!res.ok) throw new Error('model not found: ' + modelUrl);
    const bytes = await res.arrayBuffer();

    /* 128x128 float32 RGB tensor */
    const N = 128;
    const cv = new OffscreenCtor(N, N);
    const ctx = cv.getContext('2d');
    const tmp = new OffscreenCtor(imageData.width, imageData.height);
    const tctx = tmp.getContext('2d');
    tctx.putImageData(new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height), 0, 0);
    ctx.drawImage(tmp, 0, 0, N, N);
    const px = ctx.getImageData(0, 0, N, N).data;
    const tensor = new ort.Tensor('float32', new Float32Array(N * N * 3), [1, N, N, 3]);
    for (let i = 0, j = 0; i < N * N; i++) {
      tensor.data[j++] = px[i * 4] / 255;
      tensor.data[j++] = px[i * 4 + 1] / 255;
      tensor.data[j++] = px[i * 4 + 2] / 255;
    }

    const providers = [];
    try { if (globalThis.navigator && navigator.gpu) providers.push('webgpu'); } catch (e) { /* noop */ }
    providers.push('wasm');
    const session = await ort.InferenceSession.create(bytes, { executionProviders: providers });
    const feeds = {}; feeds[session.inputNames[0]] = tensor;
    const out = await session.run(feeds);
    const scores = out[session.outputNames[0]];
    if (!scores) throw new Error('model produced no output');

    /* Generic single-tensor box postprocess: [1,k,4] or [k,4], normalized. */
    const dims = scores.dims;
    const flat = scores.data;
    const k = dims.length >= 2 ? (dims[dims.length - 2] || dims[1] || 0) : 0;
    const boxes = [];
    for (let b = 0; b < k; b++) {
      const off = b * 4;
      const score = dims[dims.length - 1] === 4 ? (flat[off + 4] || 0) : (flat[b + k * 4] || 0);
      const conf = typeof score === 'number' && score > 0 ? Math.min(0.99, score) : 0.85;
      const rx = flat[off], ry = flat[off + 1], rw = flat[off + 2], rh = flat[off + 3];
      boxes.push({
        box: {
          x: rx * imageData.width, y: ry * imageData.height,
          width: rw * imageData.width, height: rh * imageData.height
        },
        piiType: 'face', mode: 'blur', confidence: conf,
        source: 'vision-onnx', selector: null,
        evidence: 'onnx face box', tokenKind: null
      });
    }
    return boxes;
  }

  /* ------------------------------------------------------------------ *
   * Public orchestrator
   * ------------------------------------------------------------------ */
  /**
   * @param {ImageData|{data,width,height}} imageData RGBA pixels
   * @param {Object} opts {forceHeuristic, ort, modelUrl, cell}
   * @returns {Promise<{detections, tier, latencyMs}>}
   */
  async function detect(imageData, opts) {
    opts = opts || {};
    const t0 = U.now();
    let tier = 'heuristic-cpu';
    let detections = [];

    if (!opts.forceHeuristic) {
      try {
        const boxes = await runOrt(imageData, opts);
        if (boxes && boxes.length) {
          tier = (globalThis.navigator && navigator.gpu) ? 'ort-webgpu' : 'ort-wasm';
          detections = dedupeDetections(boxes);
        }
      } catch (e) {
        tier = 'heuristic-cpu'; // graceful degradation — the offline guarantee
      }
    }

    if (!detections.length) {
      const r = detectFacesInBuffer(imageData, opts);
      detections = dedupeDetections(r.boxes);
      tier = 'heuristic-cpu';
    }

    return {
      detections,
      tier,
      latencyMs: U.round(U.now() - t0, 2)
    };
  }

  const VisionDetector = {
    detect, detectFacesInBuffer, dedupeDetections, isSkinRGB,
    dilate, connectedComponents
  };
  OBA.visionDetector = VisionDetector;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VisionDetector;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
