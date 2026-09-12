/**
 * OBA Canvas Redactor — irreversible, pixel-level redaction engine.
 *
 * Core ops are pure functions over an RGBA buffer {data,width,height}
 * (Node-safe, benchmark-testable). The browser adapter runs in the
 * service worker on an OffscreenCanvas and re-encodes to JPEG.
 *
 * Irreversibility:
 *  - blackout : bytes zeroed. Information destroyed, not hidden.
 *  - blur     : block downsample (pixelate) + separable box blur.
 *               The source signal is resampled to ~1/10 resolution
 *               BEFORE smearing; high-frequency content is not
 *               recoverable (this is destruction, not obfuscation).
 */
(function (root) {
  'use strict';
  const OBA = (root.OBA = root.OBA || {});
  const U = OBA.util || require('./../core/util.js');

  /* ------------------------------------------------------------------ *
   * Pure core
   * ------------------------------------------------------------------ */

  function blackoutRegion(data, W, x0, y0, w, h) {
    const x1 = Math.min(W, x0 + w);
    const y1 = Math.min(data.length / (4 * W), y0 + h);
    for (let y = Math.max(0, y0); y < y1; y++) {
      let i = (y * W + Math.max(0, x0)) * 4;
      for (let x = Math.max(0, x0); x < x1; x++) {
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
        i += 4;
      }
    }
  }

  function pixelateRegion(data, W, x0, y0, w, h, block) {
    const x1 = x0 + w, y1 = y0 + h;
    for (let by = y0; by < y1; by += block) {
      for (let bx = x0; bx < x1; bx += block) {
        let r = 0, g = 0, b = 0, n = 0;
        const yMax = Math.min(y1, by + block), xMax = Math.min(x1, bx + block);
        for (let y = by; y < yMax; y++) {
          for (let x = bx; x < xMax; x++) {
            const i = (y * W + x) * 4;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
        }
        if (!n) continue;
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        for (let y = by; y < yMax; y++) {
          for (let x = bx; x < xMax; x++) {
            const i = (y * W + x) * 4;
            data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
          }
        }
      }
    }
  }

  /** Separable box blur confined to a region (approximates Gaussian). */
  function blurRegion(data, W, H, x0, y0, w, h, radius, passes) {
    radius = radius || 4; passes = passes || 2;
    const x1 = Math.max(0, x0), y1 = Math.max(0, y0);
    const x2 = Math.min(W, x0 + w), y2 = Math.min(H, y0 + h);
    if (x2 <= x1 || y2 <= y1) return;
    let tmp = new Float32Array((x2 - x1) * (y2 - y1) * 3);
    for (let p = 0; p < passes; p++) {
      /* horizontal */
      for (let y = y1; y < y2; y++) {
        for (let x = x1; x < x2; x++) {
          let r = 0, g = 0, b = 0, n = 0;
          for (let k = -radius; k <= radius; k++) {
            const xx = Math.max(x1, Math.min(x2 - 1, x + k));
            const i = (y * W + xx) * 4;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
          const j = ((y - y1) * (x2 - x1) + (x - x1)) * 3;
          tmp[j] = r / n; tmp[j + 1] = g / n; tmp[j + 2] = b / n;
        }
      }
      /* vertical, write back */
      for (let y = y1; y < y2; y++) {
        for (let x = x1; x < x2; x++) {
          let r = 0, g = 0, b = 0, n = 0;
          for (let k = -radius; k <= radius; k++) {
            const yy = Math.max(y1, Math.min(y2 - 1, y + k));
            const j = ((yy - y1) * (x2 - x1) + (x - x1)) * 3;
            r += tmp[j]; g += tmp[j + 1]; b += tmp[j + 2]; n++;
          }
          const i = (y * W + x) * 4;
          data[i] = Math.round(r / n);
          data[i + 1] = Math.round(g / n);
          data[i + 2] = Math.round(b / n);
          data[i + 3] = 255;
        }
      }
    }
  }

  /**
   * Mutates the buffer applying each detection box. Overlapping detections
   * (e.g. a DOM photo region + a vision face box inside it) are merged FIRST
   * so their pixelate grids coincide — otherwise the second pass would
   * re-pixelate on a shifted grid and break both irreversibility and the
   * verification sampler.
   * @param {Array} detections [{box:{x,y,width,height}, mode, piiType, confidence?}]
   */
  function applyRedaction(image, detections, opts) {
    opts = opts || {};
    const t0 = U.now();
    const W = image.width, H = image.height;
    const data = image.data;
    const pad = typeof opts.pad === 'number' ? opts.pad : 4;
    const applied = [];
    let blackoutCount = 0, blurCount = 0;

    /* --- merge overlapping detections (union box, best metadata) ---
     * plain IoU is blind to containment (a face box inside a photo box has
     * IoU ~0.3), so we also merge when the smaller box is mostly covered. */
    const list = (detections || []).filter(d => d && d.box && d.box.width >= 1 && d.box.height >= 1);
    const shouldMerge = function (a, b) {
      const inter = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
                    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      if (inter <= 0) return false;
      const iouV = inter / (a.width * a.height + b.width * b.height - inter);
      const containment = inter / Math.min(a.width * a.height, b.width * b.height);
      return iouV >= (opts.mergeIou == null ? 0.3 : opts.mergeIou) || containment >= 0.65;
    };
    const groups = [];
    for (let i = 0; i < list.length; i++) {
      let g = null;
      for (let k = 0; k < groups.length; k++) {
        if (groups[k].some(function (j) { return shouldMerge(list[j].box, list[i].box); })) { g = groups[k]; break; }
      }
      if (g) g.push(i); else groups.push([i]);
    }
    const merged = groups.map(function (group) {
      let box = list[group[0]].box;
      group.forEach(function (j) {
        const b = list[j].box;
        box = {
          x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
          width: Math.max(box.x + box.width, b.x + b.width) - Math.min(box.x, b.x),
          height: Math.max(box.y + box.height, b.y + b.height) - Math.min(box.y, b.y)
        };
      });
      let best = null;
      group.forEach(function (j) {
        const d = list[j];
        if (!best || (d.confidence || 0) > (best.confidence || 0)) best = d;
      });
      return best ? Object.assign({}, best, { box: box }) : best;
    }).filter(Boolean);

    for (let i = 0; i < merged.length; i++) {
      const d = merged[i];
      /* round once so the pixelate grid, blur region, and the verification
       * sampler all share an identical integer origin */
      const raw = U.expandBox(d.box, pad, W, H);
      const box = {
        x: Math.round(raw.x), y: Math.round(raw.y),
        width: Math.round(raw.width), height: Math.round(raw.height)
      };
      if (box.width < 1 || box.height < 1) continue;
      const mode = d.mode || 'blackout';
      if (mode === 'blackout') {
        blackoutRegion(data, W, Math.round(box.x), Math.round(box.y),
                       Math.round(box.width), Math.round(box.height));
        blackoutCount++;
        applied.push({ box, mode, piiType: d.piiType, source: d.source || 'dom' });
      } else {
        const block = Math.max(6, Math.round(Math.min(box.width, box.height) / 6));
        pixelateRegion(data, W, box.x, box.y, box.width, box.height, block);
        /* smear scaled to the block grid so block interiors stay constant
         * (pixelation is the destruction; blur is the visual smear) */
        blurRegion(data, W, H, box.x, box.y, box.width, box.height,
                   Math.max(1, Math.round(block / 8)), 2);
        blurCount++;
        applied.push({ box, mode, piiType: d.piiType, source: d.source || 'dom', block });
      }
    }
    return {
      applied,
      stats: {
        blackoutCount, blurCount,
        latencyMs: U.round(U.now() - t0, 2)
      }
    };
  }

  /**
   * Post-redaction verification: assert every target region is actually
   * destroyed.
   *  - blackout : near-black and flat.
   *  - blur     : each pixelation block must be internally CONSTANT —
   *               that is precisely the information destruction claim
   *               (within-block detail is averaged away and cannot be
   *               reconstructed). Brightness edges BETWEEN blocks are
   *               legitimate (face over dark background stays two colors).
   */
  function verifyRedaction(image, applied, opts) {
    opts = opts || {};
    const W = image.width, H = image.height, data = image.data;
    const failures = [];
    let checked = 0;
    for (let i = 0; i < applied.length; i++) {
      const a = applied[i];
      const b = U.clampBox(a.box, W, H);
      if (b.width < 2 || b.height < 2) continue;
      checked++;

      if (a.mode === 'blackout') {
        let sum = 0, sumSq = 0, n = 0;
        const step = Math.max(1, Math.floor(Math.min(b.width, b.height) / 8));
        for (let y = b.y; y < b.y + b.height; y += step) {
          for (let x = b.x; x < b.x + b.width; x += step) {
            const idx = (Math.min(H - 1, y | 0) * W + Math.min(W - 1, x | 0)) * 4;
            const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
            sum += lum; sumSq += lum * lum; n++;
          }
        }
        const mean = sum / Math.max(1, n);
        const variance = Math.max(0, sumSq / Math.max(1, n) - mean * mean);
        const ok = mean < (opts.blackMeanMax || 10) && variance < (opts.blackVarMax || 8);
        if (!ok) failures.push({ box: b, mode: a.mode, mean: U.round(mean, 1), variance: U.round(variance, 1) });
      } else {
        /* per-block constancy on the SAME pixelate grid used in apply */
        const block = a.block || Math.max(6, Math.round(Math.min(b.width, b.height) / 6));
        const rim = Math.min(6, Math.max(1, Math.round(block / 4))); /* blur-smeared rim */
        let badBlocks = 0, blocksChecked = 0;
        const bx0 = Math.round(b.x), by0 = Math.round(b.y);
        const bx1 = Math.round(b.x + b.width), by1 = Math.round(b.y + b.height);
        for (let by = by0; by < by1 - rim; by += block) {
          for (let bx = bx0; bx < bx1 - rim; bx += block) {
            let sum = 0, sumSq = 0, n = 0;
            const xEnd = Math.min(bx + block - rim, bx1);
            const yEnd = Math.min(by + block - rim, by1);
            const s = Math.max(1, Math.floor((block - rim) / 3));
            for (let y = by + rim; y < yEnd; y += s) {
              for (let x = bx + rim; x < xEnd; x += s) {
                const idx = (Math.min(H - 1, y) * W + Math.min(W - 1, x)) * 4;
                const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
                sum += lum; sumSq += lum * lum; n++;
              }
            }
            if (n < 3) continue;
            blocksChecked++;
            const variance = Math.max(0, sumSq / n - (sum / n) * (sum / n));
            if (variance > (opts.blurBlockVarMax || 12)) badBlocks++;
          }
        }
        if (blocksChecked === 0) failures.push({ box: b, mode: a.mode, reason: 'no blocks sampled' });
        else if (badBlocks > 0) {
          failures.push({ box: b, mode: a.mode, badBlocks, blocksChecked });
        }
      }
    }
    return { ok: failures.length === 0, checked, failures };
  }

  /**
   * Leak assertion over the ENTIRE outbound payload object:
   *  1. no raw vault value may appear anywhere in the serialized JSON;
   *  2. no concrete PII pattern (email / Luhn card / SSN / Aadhaar / DOB)
   *     may appear outside of [TOKEN] placeholders.
   */
  function assertNoLeakage(payloadObj, rawValues, opts) {
    opts = opts || {};
    const leaks = [];
    let text;
    try { text = JSON.stringify(payloadObj); }
    catch (e) { return { ok: false, leaks: [{ reason: 'unserializable payload' }] }; }

    (rawValues || []).forEach(function (v) {
      if (typeof v === 'string' && v.length >= 4 && text.indexOf(v) !== -1) {
        leaks.push({ reason: 'raw vault value present', hint: v.slice(0, 2) + '***' });
      }
    });

    /* strip tokens first so [USER_EMAIL_1] cannot match email regexes */
    const stripped = text.replace(/\[[A-Z_0-9]+\]/g, '[]');
    const hits = U.scanText(stripped);
    (hits || []).forEach(function (h) {
      if (opts.allow && opts.allow.indexOf(h.value) !== -1) return;
      leaks.push({ reason: 'PII pattern in payload', type: h.type, hint: h.value.slice(0, 3) + '***' });
    });

    return { ok: leaks.length === 0, leaks };
  }

  /* ------------------------------------------------------------------ *
   * Browser adapter (service worker)
   * ------------------------------------------------------------------ */

  function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const bin = atob(base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }

  function bytesToDataUrl(bytes, mime) {
    const arr = new Uint8Array(bytes);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < arr.length; i += CH) {
      s += String.fromCharCode.apply(null, arr.subarray(i, i + CH));
    }
    return 'data:' + (mime || 'image/jpeg') + ';base64,' + btoa(s);
  }

  /**
   * Full screenshot redaction in the service worker.
   * @param {string} dataUrl  raw capture (PNG)
   * @param {Array}  detections CSS-px detections
   * @param {{sx:number, sy:number}} scale CSS px -> capture px
   */
  async function redactScreenshot(dataUrl, detections, scale, opts) {
    opts = opts || {};
    const t0 = U.now();
    const blob = new Blob([dataUrlToBytes(dataUrl)], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const imageData = ctx.getImageData(0, 0, bmp.width, bmp.height);

    const sx = (scale && scale.sx) || 1, sy = (scale && scale.sy) || 1;
    const scaled = detections.map(function (d) {
      return Object.assign({}, d, {
        box: { x: d.box.x * sx, y: d.box.y * sy, width: d.box.width * sx, height: d.box.height * sy }
      });
    });

    /* applyRedaction merges overlapping boxes internally (single code path
     * shared with the Node benchmark runner) */
    const res = applyRedaction(imageData, scaled, opts);
    ctx.putImageData(imageData, 0, 0);
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: opts.jpegQuality || 0.72 });
    const bytes = await outBlob.arrayBuffer();
    const verification = verifyRedaction(imageData, res.applied, opts);

    return {
      sanitizedDataUrl: bytesToDataUrl(bytes, 'image/jpeg'),
      sanitizedBase64: bytesToDataUrl(bytes, 'image/jpeg').split(',')[1],
      appliedBoxes: res.applied,
      verification,
      stats: Object.assign(res.stats, { totalMs: U.round(U.now() - t0, 2) })
    };
  }

  const CanvasRedactor = {
    applyRedaction, verifyRedaction, assertNoLeakage,
    blackoutRegion, pixelateRegion, blurRegion,
    redactScreenshot, dataUrlToBytes, bytesToDataUrl
  };
  OBA.redactor = CanvasRedactor;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CanvasRedactor;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
