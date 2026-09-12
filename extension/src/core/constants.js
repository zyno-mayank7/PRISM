/**
 * OBA — On-device Browser Agent
 * Shared constants: message contracts, PII taxonomy, redaction modes.
 *
 * Dual-environment module (browser classic script via globalThis.OBA,
 * Node CommonJS via module.exports) so the SAME code runs inside:
 *   - Chrome MV3 service worker (importScripts)
 *   - Firefox MV3 event page (manifest scripts array)
 *   - Content scripts / sidepanel (classic <script>)
 *   - Node (require) — benchmark & unit tests
 */
(function (root) {
  'use strict';
  const OBA = (root.OBA = root.OBA || {});

  /* ------------------------------------------------------------------ *
   * Message contract (extension-internal, never leaves the device)
   * ------------------------------------------------------------------ */
  const MSG = {
    PING: 'OBA_PING',
    RUN_TASK: 'OBA_RUN_TASK',               // sidepanel -> SW {task}
    STOP_TASK: 'OBA_STOP_TASK',             // sidepanel -> SW
    RESET_SESSION: 'OBA_RESET_SESSION',     // sidepanel -> SW
    SETTINGS_UPDATED: 'OBA_SETTINGS_UPDATED',
    DOM_SNAPSHOT_REQUEST: 'OBA_DOM_SNAPSHOT_REQUEST', // SW -> content
    EXECUTE_ACTION: 'OBA_EXECUTE_ACTION',   // SW -> content {action}
    TELEMETRY: 'OBA_TELEMETRY',             // SW -> sidepanel
    INSPECTOR_UPDATE: 'OBA_INSPECTOR_UPDATE', // SW -> sidepanel (raw+sanitized views)
    TASK_DONE: 'OBA_TASK_DONE',             // SW -> sidepanel
    TASK_ERROR: 'OBA_TASK_ERROR'            // SW -> sidepanel
  };

  /* ------------------------------------------------------------------ *
   * PII taxonomy (client-side detection classes)
   * ------------------------------------------------------------------ */
  const PII = {
    PASSWORD: 'password',
    EMAIL: 'email',
    PHONE: 'phone',
    CREDIT_CARD: 'credit_card',
    ACCOUNT_NUMBER: 'account_number',
    CVV: 'cvv',
    EXPIRY: 'expiry',
    SSN: 'ssn',
    NATIONAL_ID: 'national_id',
    DOB: 'dob',
    OTP: 'otp',
    NAME: 'name',
    ADDRESS: 'address',
    PHOTO: 'photo',     // profile photo / avatar image region
    FACE: 'face',       // face detected in pixels
    GENERIC: 'sensitive'
  };

  /* Redaction mode per class. Blackout destroys pixels outright;
   * blur pixelates + smears beyond reconstruction (block downsample). */
  const REDACT_MODE = {
    password: 'blackout', email: 'blackout', phone: 'blackout',
    credit_card: 'blackout', account_number: 'blackout', cvv: 'blackout', expiry: 'blackout',
    ssn: 'blackout', national_id: 'blackout', dob: 'blackout',
    otp: 'blackout', name: 'blackout', address: 'blackout',
    photo: 'blur', face: 'blur', sensitive: 'blackout'
  };

  /* Token prefix used by the local vault for each class. */
  const TOKEN_PREFIX = {
    password: 'USER_PASSWORD', email: 'USER_EMAIL', phone: 'USER_PHONE',
    credit_card: 'CARD_NUMBER', account_number: 'ACCOUNT_NUMBER', cvv: 'CVV', expiry: 'EXPIRY',
    ssn: 'NATIONAL_ID', national_id: 'NATIONAL_ID', dob: 'DOB',
    otp: 'USER_OTP', name: 'USER_NAME', address: 'ADDRESS',
    sensitive: 'USER_SECRET'
  };

  /* Demo defaults — synthetic credentials that the local vault resolves
   * tokens to when the operator has not supplied real ones. They are only
   * ever typed into the local page; they are NEVER transmitted. */
  const DEMO_DEFAULTS = {
    USER_PASSWORD_1: 'Sih@2026#Demo',
    USER_EMAIL_1: 'demo.user@sih.dev',
    USER_PHONE_1: '+91 98765 43210',
    CARD_NUMBER_1: '4111 1111 1111 1111',
    ACCOUNT_NUMBER_1: '987654321012',
    CVV_1: '123',
    EXPIRY_1: '12/28',
    USER_OTP_1: '426749',
    NATIONAL_ID_1: '2345 6789 0123',
    DOB_1: '1996-04-17',
    USER_NAME_1: 'Aarav Sharma',
    ADDRESS_1: '221B Hill Road, Bandra West, Mumbai 400050'
  };

  /* ------------------------------------------------------------------ *
   * Agent action contract (shared with server/pydantic schemas)
   * ------------------------------------------------------------------ */
  const ACTIONS = ['click', 'type', 'scroll', 'finish'];
  const SCROLL_DIRECTIONS = ['up', 'down'];

  function isValidAction(a) {
    if (!a || typeof a !== 'object') return false;
    if (ACTIONS.indexOf(a.action) === -1) return false;
    if (typeof a.selector !== 'undefined' && a.selector !== null &&
        typeof a.selector !== 'string') return false;
    if (a.action === 'type' && !a.selector) return false;
    if (a.action === 'click' && !a.selector) return false;
    const c = typeof a.confidence === 'number' ? a.confidence : 0.8;
    if (c < 0 || c > 1) return false;
    return true;
  }

  /* Defaults */
  const DEFAULTS = {
    SERVER_URL: 'http://127.0.0.1:8000',
    MAX_STEPS: 14,
    STEP_SETTLE_MS: 900,
    VENDOR_ORT: 'vendor/ort.min.js',
    VENDOR_MODEL: 'vendor/face-detection.onnx'
  };

  OBA.MSG = MSG;
  OBA.PII = PII;
  OBA.REDACT_MODE = REDACT_MODE;
  OBA.TOKEN_PREFIX = TOKEN_PREFIX;
  OBA.DEMO_DEFAULTS = DEMO_DEFAULTS;
  OBA.ACTIONS = ACTIONS;
  OBA.SCROLL_DIRECTIONS = SCROLL_DIRECTIONS;
  OBA.isValidAction = isValidAction;
  OBA.DEFAULTS = DEFAULTS;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MSG, PII, REDACT_MODE, TOKEN_PREFIX, DEMO_DEFAULTS,
      ACTIONS, SCROLL_DIRECTIONS, isValidAction, DEFAULTS };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
