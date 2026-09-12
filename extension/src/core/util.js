/**
 * OBA — shared utilities: geometry (IoU/box merging), Luhn, PII regexes,
 * timing, ids. Dual-environment module (browser classic + Node CJS).
 */
(function (root) {
  'use strict';
  const OBA = (root.OBA = root.OBA || {});
  const C = OBA.constants || (OBA.constants = null); // (loaded separately when present)

  /* ---------------- geometry ---------------- */
  function clampBox(box, W, H) {
    const x = Math.max(0, Math.min(box.x, W));
    const y = Math.max(0, Math.min(box.y, H));
    const x2 = Math.max(0, Math.min(box.x + box.width, W));
    const y2 = Math.max(0, Math.min(box.y + box.height, H));
    return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
  }

  function expandBox(box, pad, W, H) {
    return clampBox({
      x: box.x - pad, y: box.y - pad,
      width: box.width + pad * 2, height: box.height + pad * 2
    }, W, H);
  }

  function iou(a, b) {
    const ax2 = a.x + a.width, ay2 = a.y + a.height;
    const bx2 = b.x + b.width, by2 = b.y + b.height;
    const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
    const inter = ix * iy;
    const uni = a.width * a.height + b.width * b.height - inter;
    return uni <= 0 ? 0 : inter / uni;
  }

  /** Merge boxes whose IoU >= thr (union bbox); order-stable. */
  function mergeBoxes(boxes, thr) {
    thr = typeof thr === 'number' ? thr : 0.4;
    const out = [];
    const used = new Array(boxes.length).fill(false);
    for (let i = 0; i < boxes.length; i++) {
      if (used[i]) continue;
      let cur = boxes[i];
      used[i] = true;
      for (let j = i + 1; j < boxes.length; j++) {
        if (used[j]) continue;
        if (iou(cur, boxes[j]) >= thr) {
          used[j] = true;
          cur = {
            x: Math.min(cur.x, boxes[j].x),
            y: Math.min(cur.y, boxes[j].y),
            width: Math.max(cur.x + cur.width, boxes[j].x + boxes[j].width) - Math.min(cur.x, boxes[j].x),
            height: Math.max(cur.y + cur.height, boxes[j].y + boxes[j].height) - Math.min(cur.y, boxes[j].y)
          };
        }
      }
      out.push(cur);
    }
    return out;
  }

  /* ---------------- validation ---------------- */
  /** Luhn checksum for card numbers (spaces/dashes stripped). */
  function luhnOk(numStr) {
    const s = String(numStr).replace(/[ -]/g, '');
    if (!/^\d{12,19}$/.test(s)) return false;
    let sum = 0, alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
      let d = s.charCodeAt(i) - 48;
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return sum % 10 === 0;
  }

  /* ---------------- PII text patterns (shared with server + tests) ---------------- */
  const RX = {
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    phone: /(?:\+91[ -]?)?\b[6-9]\d{9}\b|\b\d{3}[ -]\d{3}[ -]\d{4}\b/g,
    ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
    aadhaar: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
    dobIso: /\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g,
    cardCandidate: /\b(?:\d[ -]?){13,19}\b/g,   // candidates, Luhn-checked
    token: /\[(USER_[A-Z_]+|CARD_NUMBER|CVV|EXPIRY|NATIONAL_ID|DOB)_(\d+)\]/g
  };

  /** Scan a text string for concrete PII (excludes vault tokens). */
  function scanText(text) {
    const found = [];
    if (!text || typeof text !== 'string') return found;
    let m;
    RX.email.lastIndex = 0;
    while ((m = RX.email.exec(text)) !== null) found.push({ type: 'email', value: m[0] });
    RX.phone.lastIndex = 0;
    while ((m = RX.phone.exec(text)) !== null) found.push({ type: 'phone', value: m[0] });
    RX.ssn.lastIndex = 0;
    while ((m = RX.ssn.exec(text)) !== null) found.push({ type: 'ssn', value: m[0] });
    RX.aadhaar.lastIndex = 0;
    while ((m = RX.aadhaar.exec(text)) !== null) found.push({ type: 'national_id', value: m[0] });
    RX.dobIso.lastIndex = 0;
    while ((m = RX.dobIso.exec(text)) !== null) found.push({ type: 'dob', value: m[0] });
    RX.cardCandidate.lastIndex = 0;
    while ((m = RX.cardCandidate.exec(text)) !== null) {
      if (luhnOk(m[0])) found.push({ type: 'credit_card', value: m[0] });
    }
    return found;
  }

  /* ---------------- misc ---------------- */
  let _idc = 0;
  function uid(prefix) {
    _idc = (_idc + 1) % 1e6;
    return (prefix || 'oba') + '-' + Date.now().toString(36) + '-' + _idc;
  }
  function now() { return (globalThis.performance && performance.now) ? performance.now() : Date.now(); }
  function round(n, d) { const p = Math.pow(10, d == null ? 2 : d); return Math.round(n * p) / p; }
  function fmtMs(ms) { return round(ms, 1) + ' ms'; }

  OBA.util = {
    clampBox, expandBox, iou, mergeBoxes, luhnOk, RX, scanText,
    uid, now, round, fmtMs
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OBA.util;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
