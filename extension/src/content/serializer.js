/**
 * OBA DOM Serializer — content-script side.
 * Serializes the live DOM into the element descriptors consumed by the
 * DOM detector, with viewport-space bounding rectangles (CSS px) so the
 * service worker can map detections onto the captured screenshot.
 *
 * Privacy notes:
 *  - element VALUES are included (needed for local vault tokenization),
 *    but they only travel over chrome.runtime messaging — they never
 *    leave the device. The service worker replaces them with tokens
 *    before any network call.
 *  - the URL is stripped to origin + pathname (query strings can carry
 *    tokens/UTMs and are not needed for reasoning).
 */
(function (root) {
  'use strict';
  const OBA = (root.OBA = root.OBA || {});

  const SELECT_NODES = 'input, select, textarea, button, a[href], [role="button"], [role="checkbox"], [role="combobox"], img, canvas, label, [contenteditable="true"]';
  let obaSeq = 0;

  function isVisible(el, rect) {
    if (el.hasAttribute && el.hasAttribute('hidden')) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    if (rect.width < 2 || rect.height < 2) return false;
    if (typeof el.checkVisibility === 'function') {
      try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); }
      catch (e) { /* older engines */ }
    }
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) return false;
    return true;
  }

  function uniqueSelector(el) {
    /* bulletproof: tag a stable data attribute and select on it */
    try {
      let key = el.getAttribute('data-oba-id');
      if (!key) {
        key = 'e' + (++obaSeq);
        el.setAttribute('data-oba-id', key);
      }
      return '[data-oba-id="' + key + '"]';
    } catch (e) { /* detached */ }
    if (el.id) return '#' + CSS.escape(el.id);
    return el.tagName.toLowerCase();
  }

  function labelText(el) {
    try {
      if (el.labels && el.labels.length) {
        const t = el.labels[0].innerText.trim();
        if (t) return t.slice(0, 80);
      }
      const closest = el.closest ? el.closest('label') : null;
      if (closest) {
        const t = closest.innerText.trim();
        if (t) return t.slice(0, 80);
      }
      const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
      if (aria) return aria.slice(0, 80);
      const ph = el.getAttribute('placeholder');
      if (ph) return ph.slice(0, 80);
      const name = el.getAttribute('name');
      if (name) return name;
    } catch (e) { /* noop */ }
    return null;
  }

  function serializeElement(el) {
    const rect = el.getBoundingClientRect();
    const visible = isVisible(el, rect);
    const tag = el.tagName.toLowerCase();
    const descriptor = {
      tag,
      type: (el.getAttribute && el.getAttribute('type')) || (el.type && tag !== 'button' && tag !== 'a' ? el.type : null) || null,
      id: el.id || null,
      name: el.getAttribute && el.getAttribute('name'),
      classes: (el.className && typeof el.className === 'string') ? el.className.split(/\s+/).filter(Boolean).slice(0, 8) : [],
      selector: uniqueSelector(el),
      text: (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') ?
        (el.innerText || el.value || '').trim().slice(0, 60) : null,
      label: labelText(el),
      placeholder: el.getAttribute && el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute && el.getAttribute('aria-label'),
      autocomplete: el.getAttribute && el.getAttribute('autocomplete'),
      role: el.getAttribute && el.getAttribute('role'),
      value: readValue(el),
      isImg: tag === 'img' || tag === 'canvas',
      imgHints: tag === 'img' ? [el.id, el.className, el.alt].filter(Boolean).join(' ').slice(0, 80) : null,
      visible,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
    return descriptor;
  }

  function readValue(el) {
    try {
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'file') {
        return el.value == null ? null : String(el.value);
      }
      if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions.length) {
        return el.selectedOptions[0].value;
      }
    } catch (e) { /* noop */ }
    return null;
  }

  function serializeDocument() {
    const t0 = performance.now();
    const els = [];
    let nodes;
    try { nodes = document.querySelectorAll(SELECT_NODES); }
    catch (e) { nodes = []; }
    for (let i = 0; i < nodes.length && els.length < 400; i++) {
      const el = nodes[i];
      try { els.push(serializeElement(el)); } catch (e) { /* skip bad node */ }
    }
    return {
      url: location.origin + location.pathname,
      title: (document.title || '').slice(0, 80),
      viewport: {
        width: Math.round(window.innerWidth),
        height: Math.round(window.innerHeight),
        dpr: window.devicePixelRatio || 1,
        scrollX: window.scrollX, scrollY: window.scrollY
      },
      elements: els,
      stats: { count: els.length, latencyMs: Math.round((performance.now() - t0) * 100) / 100 }
    };
  }

  const Serializer = { serializeDocument, serializeElement, uniqueSelector, labelText };
  OBA.serializer = Serializer;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Serializer;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
