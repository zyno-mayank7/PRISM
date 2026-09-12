/**
 * OBA Local Vault — on-device token mapping.
 *
 * Raw PII values are registered here (in extension session memory only)
 * and replaced by opaque tokens such as [USER_PASSWORD_1] in everything
 * that leaves the device. Tokens are resolved back to raw values ONLY
 * for local execution of `type` actions inside the user's own tab.
 *
 * The vault is never flushed to disk (chrome.storage.session at most,
 * which is memory-backed and cleared when the browser closes).
 */
(function (root) {
  'use strict';
  const OBA = (root.OBA = root.OBA || {});
  const U = OBA.util || require('./../core/util.js');
  const C = OBA.MSG ? OBA : (typeof require !== 'undefined' ? require('./../core/constants.js') : OBA);

  const TOKEN_PREFIX = (OBA.TOKEN_PREFIX || (C && C.TOKEN_PREFIX) || {});
  const DEMO_DEFAULTS = (OBA.DEMO_DEFAULTS || (C && C.DEMO_DEFAULTS) || {});

  function kindFromPiiType(piiType) {
    return TOKEN_PREFIX[piiType] || 'USER_SECRET';
  }

  function createVault(opts) {
    opts = opts || {};
    const map = new Map();      // token -> raw value (never transmitted)
    const counters = Object.create(null);

    function nextToken(kind) {
      counters[kind] = (counters[kind] || 0) + 1;
      return '[' + kind + '_' + counters[kind] + ']';
    }

    return {
      /** Register a sensitive value, get its token back. */
      register: function (piiType, rawValue) {
        const kind = kindFromPiiType(piiType);
        const token = nextToken(kind);
        if (rawValue !== undefined && rawValue !== null && String(rawValue).length > 0) {
          map.set(token, String(rawValue));
        }
        return token;
      },

      /** Resolve a token to its raw value; falls back to demo defaults
       * (exact match, then kind-prefix so [ADDRESS_2] resolves too). */
      resolve: function (token) {
        if (typeof token !== 'string') return null;
        if (map.has(token)) return map.get(token);
        const stripped = token.replace(/[[\]]/g, '');
        if (Object.prototype.hasOwnProperty.call(DEMO_DEFAULTS, stripped)) {
          return DEMO_DEFAULTS[stripped];
        }
        const base = stripped.replace(/_\d+$/, '');
        if (base !== stripped) {
          for (const k of Object.keys(DEMO_DEFAULTS)) {
            if (k === base || k.indexOf(base + '_') === 0) return DEMO_DEFAULTS[k];
          }
        }
        return null;
      },

      resolveIfToken: function (value) {
        if (typeof value === 'string' && /^\[[A-Z_]+_\d+\]$/.test(value.trim())) {
          return this.resolve(value.trim());
        }
        return value;
      },

      /**
       * Build the sanitized dom_elements array for transport:
       *  - sensitive fields' values become tokens;
       *  - `placeholder` is dropped from ALL elements — placeholders embed
       *    developer example strings ("name@company.com", "4111 1111 1111
       *    1111") that are PII-shaped and would trip any downstream
       *    scanner; labels already carry the semantics.
       */
      tokenizeElements: function (elements, detections) {
        const bySelector = new Map();
        (detections || []).forEach(function (d) {
          if (d.selector && d.tokenKind && !bySelector.has(d.selector)) {
            bySelector.set(d.selector, d);
          }
        });
        return (elements || []).map(function (el) {
          const copy = Object.assign({}, el);
          delete copy.placeholder;
          const d = bySelector.get(el.selector);
          if (!d || el.value === undefined || el.value === null || el.value === '') {
            if (!d) {
              /* non-sensitive: value travels only if non-empty and non-PII-by-value */
              if (typeof copy.value === 'string' && U.scanText(copy.value).length) copy.value = '';
            } else {
              copy.value = this.register(d.piiType, null); /* empty field still gets a token */
            }
            return copy;
          }
          copy.value = this.register(d.piiType, String(el.value));
          return copy;
        }, this);
      },

      /** Raw values for the leak assertion (never for transport). */
      rawValues: function () {
        const vals = [];
        map.forEach(function (v) { if (v && v.length >= 4) vals.push(v); });
        return vals;
      },

      tokenCount: function () { return Object.keys(counters).reduce(function (a, k) { return a + counters[k]; }, 0); },
      hasToken: function (t) { return map.has(t) || Object.prototype.hasOwnProperty.call(DEMO_DEFAULTS, t.replace(/[[\]]/g, '')); },
      clear: function () { map.clear(); for (const k in counters) delete counters[k]; },

      /** best-effort persistence to memory-backed session storage */
      persist: function () {
        try {
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
            const o = {};
            map.forEach(function (v, k) { o[k] = v; });
            chrome.storage.session.set({ 'oba.vault': o });
          }
        } catch (e) { /* ignore */ }
      }
    };
  }

  OBA.createVault = createVault;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createVault, kindFromPiiType };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
