/**
 * OBA DOM Detector — zero-latency PII & element detection over the
 * serialized DOM. Runs in the service worker (and in Node for benchmarks).
 *
 * Input  : elements[] as produced by the content serializer
 *          { tag, type, id, name, classes, selector, text, label,
 *            placeholder, autocomplete, role, value, isImg, imgHints,
 *            visible, rect:{x,y,width,height} }
 * Output : { elements:   interactive/structural elements recognized,
 *            detections: [{box, piiType, mode, confidence, source,
 *                          selector, tokenKind}] }
 */
(function (root) {
  'use strict';
  const OBA = (root.OBA = root.OBA || {});
  const U = OBA.util || require('./../core/util.js');

  /* context words that mark a FIELD as sensitive (id/name/label/placeholder/autocomplete/aria) */
  const SENSITIVE_CONTEXT = [
    [/passwo?r?d|passwd|pwd|passphrase|current-password|new-password/i, 'password', 0.99],
    [/\bpin\b|passcode|\botp\b|one[\s-]?time[\s-]?(code|password)|verification\s+code|m[\s-]?code/i, 'otp', 0.92],
    [/\bcvv\b|\bcvc\b|\bcsc\b|card\s*(verification|security)\s*code|security\s*code/i, 'cvv', 0.97],
    [/\bssn\b|social\s*security(\s*number)?/i, 'ssn', 0.97],
    [/aadhaa?r|uidai|\bpan\b|permanent\s*account\s*number|passport\s*(no|number|#)|driver'?s?\s*licen[cs]e/i, 'national_id', 0.95],
    [/date\s*of\s*birth|\bdob\b|\bborn\s*on\b/i, 'dob', 0.95],
    [/salary|income|annual\s*income|ctc\b/i, 'sensitive', 0.72],
    [/\bsecret\b|\btoken\b(?!.*(?:id|name))|api[\s-]?key/i, 'sensitive', 0.75]
  ];

  const EMAIL_CONTEXT = /\be[\s-]?mail|electronic\s*mail|\bemail\b/i;
  const PHONE_CONTEXT = /phone|mobile|contact(\s*number)?|\btel\b|whatsapp/i;
  const NAME_CONTEXT  = /full\s*name|^name\b|first\s*name|last\s*name|surname|applicant\s*name|name\s*\(as\s*per/i;
  const ADDR_CONTEXT  = /address|street|city|town|\bzip\b|postal|locality|state\b/i;
  const CC_AUTOCOMPLETE = /^cc-(number|csc|exp|exp-month|exp-year|name|type)$/;
  const PHOTO_CONTEXT = /photo|avatar|profile[\s-]?(pic|image|photo)|selfie|user[\s-]?pic|applicant\s*image|headshot|portrait/i;
  const OTP_AUTOCOMPLETE = 'one-time-code';

  function contextString(el) {
    return [el.id, el.name, (el.classes || []).join(' '),
            el.label, el.placeholder, el.ariaLabel,
            el.autocomplete, el.role, el.selector]
      .filter(Boolean).join(' ');
  }

  /**
   * Classify ONE element descriptor.
   * Returns null for non-sensitive elements, otherwise a detection.
   */
  function classifyElement(el) {
    const type = (el.type || '').toLowerCase();
    const ac = (el.autocomplete || '').toLowerCase();
    const ctx = contextString(el);
    let piiType = null, confidence = 0.5, evidence = '';

    /* ---- hard signals: input type ---- */
    if (el.tag === 'input' || el.tag === 'textarea') {
      if (type === 'password') { piiType = 'password'; confidence = 0.99; evidence = 'type=password'; }
      else if (type === 'email' || ac === 'email') { piiType = 'email'; confidence = 0.95; evidence = 'email field'; }
      else if (type === 'tel' || ac === 'tel' || ac === 'mobile') { piiType = 'phone'; confidence = 0.93; evidence = 'tel field'; }
      else if (type === 'date' && DOB_HINT(ctx)) { piiType = 'dob'; confidence = 0.93; evidence = 'date-of-birth field'; }
    }

    /* ---- autocomplete (strongest web-standard signal) ---- */
    if (!piiType && CC_AUTOCOMPLETE.test(ac)) {
      const map = { 'cc-number': 'credit_card', 'cc-csc': 'cvv', 'cc-exp': 'expiry',
                    'cc-exp-month': 'expiry', 'cc-exp-year': 'expiry' };
      if (map[ac]) { piiType = map[ac]; confidence = 0.97; evidence = 'autocomplete=' + ac; }
      else if (ac === 'cc-name') { piiType = 'name'; confidence = 0.9; evidence = 'autocomplete=cc-name'; }
    }
    if (!piiType && ac === OTP_AUTOCOMPLETE) { piiType = 'otp'; confidence = 0.95; evidence = 'autocomplete=one-time-code'; }

    /* ---- contextual keyword rules ---- */
    if (!piiType) {
      for (let i = 0; i < SENSITIVE_CONTEXT.length; i++) {
        const rule = SENSITIVE_CONTEXT[i];
        const m = ctx.match(rule[0]);
        if (m) { piiType = rule[1]; confidence = rule[2]; evidence = 'context "' + m[0] + '"'; break; }
      }
    }
    if (!piiType && EMAIL_CONTEXT.test(ctx) && isTextual(el)) { piiType = 'email'; confidence = 0.85; evidence = 'email context'; }
    if (!piiType && PHONE_CONTEXT.test(ctx) && isTextual(el)) { piiType = 'phone'; confidence = 0.82; evidence = 'phone context'; }
    if (!piiType && NAME_CONTEXT.test(ctx) && isTextual(el))  { piiType = 'name'; confidence = 0.8; evidence = 'name context'; }
    if (!piiType && ADDR_CONTEXT.test(ctx) && isTextual(el))  { piiType = 'address'; confidence = 0.78; evidence = 'address context'; }

    /* ---- value-content forensics (regex + Luhn) ---- */
    if (!piiType && typeof el.value === 'string' && el.value.length > 0 && type !== 'file') {
      const hits = U.scanText(el.value);
      if (hits.length) {
        /* a Luhn-valid 13-19 digit run is a card even if a 12-digit prefix
         * also matches the Aadhaar pattern — prefer the card reading */
        const card = hits.find(function (h) { return h.type === 'credit_card'; });
        piiType = card ? card.type : hits[0].type;
        confidence = card ? 0.96 : (hits[0].type === 'credit_card' ? 0.96 : 0.88);
        evidence = 'value pattern: ' + piiType;
      }
    }

    if (!piiType) return null;

    const mode = OBA.REDACT_MODE
      ? (OBA.REDACT_MODE[piiType] || 'blackout')
      : (piiType === 'photo' || piiType === 'face' ? 'blur' : 'blackout');
    const tokenKind = OBA.TOKEN_PREFIX ? (OBA.TOKEN_PREFIX[piiType] || 'USER_SECRET') : 'USER_SECRET';

    return {
      box: normalizeRect(el.rect),
      piiType, mode, confidence, source: 'dom',
      selector: el.selector, evidence,
      tokenKind, tagName: el.tag
    };
  }

  function DOB_HINT(ctx) { return /birth|dob|born/i.test(ctx); }
  function isTextual(el) {
    const t = (el.type || '').toLowerCase();
    if (el.tag === 'textarea') return true;
    if (el.tag !== 'input') return false;
    return ['', 'text', 'search', 'visible'].indexOf(t) !== -1 || t === 'tel' || t === 'email';
  }
  function normalizeRect(r) {
    if (!r) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: r.x || 0, y: r.y || 0, width: r.width || 0, height: r.height || 0 };
  }

  /**
   * img / canvas regions that plausibly hold a personal photo.
   * (The vision detector then sweeps these + the whole frame for faces.)
   */
  function classifyImage(el) {
    const ctx = [el.id, el.name, (el.classes || []).join(' '),
                 el.alt, el.ariaLabel, el.selector, el.imgHints]
      .filter(Boolean).join(' ');
    if (!PHOTO_CONTEXT.test(ctx)) return null;
    return {
      box: normalizeRect(el.rect),
      piiType: 'photo', mode: 'blur', confidence: 0.8,
      source: 'dom', selector: el.selector,
      evidence: 'image region: ' + ctx.slice(0, 40), tokenKind: null, tagName: 'img'
    };
  }

  /* Interactive/structural elements the agent reports as page context. */
  const INTERACTIVE_TAGS = ['input', 'textarea', 'select', 'button', 'a'];
  function isInteractive(el) {
    if (INTERACTIVE_TAGS.indexOf(el.tag) !== -1) return true;
    if (el.role === 'button' || el.role === 'link' || el.role === 'textbox' ||
        el.role === 'checkbox' || el.role === 'combobox' || el.role === 'menuitem') return true;
    return false;
  }

  /**
   * Main entry.
   * @param {Array} elements serialized DOM descriptors (see serializer)
   * @param {Object} opts {includeInvisible:false}
   */
  function detect(elements, opts) {
    opts = opts || {};
    const t0 = U.now();
    const els = Array.isArray(elements) ? elements : [];
    const context = [];
    const detections = [];

    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.visible === false && !opts.includeInvisible) continue;
      if (!el.rect || el.rect.width < 2 || el.rect.height < 2) {
        if (!opts.includeInvisible) continue;
      }
      if (isInteractive(el)) {
        context.push({
          tag: el.tag, type: el.type || null, selector: el.selector,
          label: el.label || el.placeholder || el.text || null,
          text: (el.text || '').slice(0, 60) || null,
          role: el.role || null, rect: normalizeRect(el.rect)
        });
      }
      const d = (el.tag === 'img' || el.isImg) ? (classifyImage(el) || classifyElement(el)) : classifyElement(el);
      if (d && d.box.width > 1 && d.box.height > 1) detections.push(d);
    }

    return {
      elements: context,
      detections,
      stats: {
        elementsScanned: els.length,
        interactiveFound: context.length,
        piiFound: detections.length,
        latencyMs: U.round(U.now() - t0, 2)
      }
    };
  }

  const DomDetector = { detect, classifyElement, classifyImage, isInteractive, contextString };
  OBA.domDetector = DomDetector;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DomDetector;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
