/**
 * OBA extension unit tests — plain Node assert runner (no dependencies).
 * Run:  node extension/tests/run_all.js
 */
'use strict';
const path = require('path');
const EXT = path.join(__dirname, '..', 'src');

/* load modules in dependency order */
require(path.join(EXT, 'core', 'constants.js'));
require(path.join(EXT, 'core', 'util.js'));
const domDetector = require(path.join(EXT, 'perception', 'dom-detector.js'));
const visionDetector = require(path.join(EXT, 'perception', 'vision-detector.js'));
const redactor = require(path.join(EXT, 'redaction', 'canvas-redactor.js'));
const vaultMod = require(path.join(EXT, 'redaction', 'vault.js'));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n      ' + e.message); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'eq') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

/* ================= DOM detector ================= */
console.log('\ndom-detector');

const els = [
  { tag: 'input', type: 'email', selector: '#email', label: 'Email or username', autocomplete: 'email',
    value: 'demo.user@sih.dev', visible: true, rect: { x: 10, y: 20, width: 220, height: 28 } },
  { tag: 'input', type: 'password', selector: '#pwd', label: 'Password', autocomplete: 'current-password',
    value: 'Sih@2026#Demo', visible: true, rect: { x: 10, y: 60, width: 220, height: 28 } },
  { tag: 'input', type: 'text', selector: '#otp', label: 'OTP code', autocomplete: 'one-time-code',
    value: '', visible: true, rect: { x: 10, y: 100, width: 220, height: 28 } },
  { tag: 'input', type: 'text', selector: '#order', label: 'Order reference', value: '1234567812345678',
    visible: true, rect: { x: 10, y: 140, width: 220, height: 28 } },
  { tag: 'input', type: 'text', selector: '#card', label: 'Card', value: '4111 1111 1111 1111',
    visible: true, rect: { x: 10, y: 180, width: 220, height: 28 } },
  { tag: 'input', type: 'text', selector: '#captcha', label: 'Captcha code', value: '',
    visible: true, rect: { x: 10, y: 220, width: 220, height: 28 } },
  { tag: 'button', selector: '#go', text: 'Sign in', visible: true, rect: { x: 10, y: 260, width: 200, height: 40 } },
  { tag: 'input', type: 'text', selector: '#hidden', label: 'Hidden ref', value: 'X1', visible: false,
    rect: { x: 0, y: 0, width: 0, height: 0 } },
  { tag: 'img', selector: '.profile-photo', classes: ['profile-photo'], alt: 'Applicant photo',
    imgHints: 'profile-photo avatar', isImg: true, visible: true, rect: { x: 10, y: 320, width: 160, height: 160 } }
];
const det = domDetector.detect(els);
const bySel = {};
det.detections.forEach(d => { bySel[d.selector || 'vision'] = d; });

t('password flagged with blackout at 0.99', () => {
  eq(bySel['#pwd'].piiType, 'password');
  eq(bySel['#pwd'].mode, 'blackout');
  ok(bySel['#pwd'].confidence >= 0.99);
});
t('email + otp flagged', () => {
  eq(bySel['#email'].piiType, 'email');
  eq(bySel['#otp'].piiType, 'otp');
});
t('Luhn-valid value flagged as credit_card', () => eq(bySel['#card'].piiType, 'credit_card'));
t('Luhn-invalid 16-digit number NOT flagged (precision)', () => ok(!bySel['#order']));
t('captcha NOT flagged (it is not PII)', () => ok(!bySel['#captcha']));
t('hidden element excluded from context', () => {
  ok(!det.elements.some(e => e.selector === '#hidden'));
  eq(det.elements.length, 7); /* email, pwd, otp, order, card, captcha, button */
});
t('profile photo image flagged for blur', () => {
  eq(bySel['.profile-photo'].piiType, 'photo');
  eq(bySel['.profile-photo'].mode, 'blur');
});

/* ================= redactor ================= */
console.log('\ncanvas-redactor');

function faceBuffer(W, H) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const dx = (x - W / 2) / (W * 0.35), dy = (y - H / 2) / (H * 0.42);
    if (dx * dx + dy * dy < 1) { data[i] = 232; data[i + 1] = 181; data[i + 2] = 140; data[i + 3] = 255; }
    else { data[i] = 15; data[i + 1] = 23; data[i + 2] = 42; data[i + 3] = 255; }
  }
  return { data, width: W, height: H };
}

t('blackout zeroes the target pixels', () => {
  const img = faceBuffer(120, 120);
  const r = redactor.applyRedaction(img, [{ box: { x: 20, y: 20, width: 60, height: 40 }, mode: 'blackout' }]);
  eq(r.stats.blackoutCount, 1);
  const px = (x, y) => { const i = (y * 120 + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  eq(JSON.stringify(px(50, 40)), '[0,0,0]');
  ok(redactor.verifyRedaction(img, r.applied).ok);
});
t('blur destroys per-block detail and verifies', () => {
  const img = faceBuffer(200, 200);
  const r = redactor.applyRedaction(img, [{ box: { x: 30, y: 30, width: 140, height: 140 }, mode: 'blur' }]);
  ok(redactor.verifyRedaction(img, r.applied).ok, 'redacted must pass');
  const fresh = faceBuffer(200, 200);
  ok(!redactor.verifyRedaction(fresh, r.applied).ok, 'unredacted must fail');
});
t('overlapping detections merge to one pixelate grid', () => {
  const img = faceBuffer(200, 200);
  const r = redactor.applyRedaction(img, [
    { box: { x: 40, y: 40, width: 120, height: 120 }, mode: 'blur', confidence: 0.9 },
    { box: { x: 70, y: 70, width: 60, height: 60 }, mode: 'blur', confidence: 0.7 }
  ]);
  eq(r.applied.length, 1);
  ok(redactor.verifyRedaction(img, r.applied).ok);
});
t('leak assertion blocks raw vault values and raw PII', () => {
  const payload = { task: 'x', dom_elements: [{ selector: '#a', value: '[USER_PASSWORD_1]' }] };
  ok(redactor.assertNoLeakage(payload, ['Sih@2026#Demo']).ok, 'tokens must pass');
  const leaky = { task: 'x', dom_elements: [{ selector: '#a', value: 'Sih@2026#Demo' }] };
  ok(!redactor.assertNoLeakage(leaky, ['Sih@2026#Demo']).ok);
  const emaily = { task: 'x', dom_elements: [{ selector: '#a', value: 'ravi.kumar@example.com' }] };
  ok(!redactor.assertNoLeakage(emaily, []).ok);
  const cardy = { task: 'x', text: 'pay with 4111111111111111 now' };
  ok(!redactor.assertNoLeakage(cardy, []).ok);
});
t('luhn utility', () => {
  ok(require(path.join(EXT, 'core', 'util.js')).luhnOk('4111 1111 1111 1111'));
  ok(!require(path.join(EXT, 'core', 'util.js')).luhnOk('1234567812345678'));
});

/* ================= vault ================= */
console.log('\nvault');

t('register → token → resolve round-trip', () => {
  const v = vaultMod.createVault();
  const tok = v.register('password', 'SecretPass123');
  eq(tok, '[USER_PASSWORD_1]');
  eq(v.resolve(tok), 'SecretPass123');
});
t('unmapped tokens fall back to demo defaults (incl. kind fallback)', () => {
  const v = vaultMod.createVault();
  eq(v.resolve('[USER_OTP_1]'), '426749');
  ok(String(v.resolve('[ADDRESS_2]')).length > 5, 'ADDRESS_2 resolves via kind prefix');
});
t('resolveIfToken passes literals through', () => {
  const v = vaultMod.createVault();
  eq(v.resolveIfToken('Mumbai'), 'Mumbai');
  eq(v.resolveIfToken(' [USER_EMAIL_1] '), 'demo.user@sih.dev');
});
t('tokenizeElements: values tokenized, placeholders dropped, PII-shaped non-sensitive values wiped', () => {
  const v = vaultMod.createVault();
  const els2 = [
    { tag: 'input', type: 'password', selector: '#pwd', label: 'Password', placeholder: '•••',
      value: 'Sih@2026#Demo', visible: true, rect: { x: 0, y: 0, width: 10, height: 10 } },
    { tag: 'input', type: 'text', selector: '#nick', label: 'Nickname', placeholder: 'cool.name@mail.com',
      value: 'ravi.kumar@example.com', visible: true, rect: { x: 0, y: 0, width: 10, height: 10 } },
    { tag: 'input', type: 'text', selector: '#city', label: 'City', placeholder: 'Mumbai',
      value: 'Mumbai', visible: true, rect: { x: 0, y: 0, width: 10, height: 10 } }
  ];
  const dets2 = [
    { selector: '#pwd', piiType: 'password', mode: 'blackout', confidence: 0.99, box: {}, tokenKind: 'USER_PASSWORD' }
  ];
  const out = v.tokenizeElements(els2, dets2);
  eq(out[0].value, '[USER_PASSWORD_1]');
  ok(out[0].placeholder === undefined, 'placeholder must be dropped');
  eq(out[1].value, '', 'PII-shaped value on non-sensitive field must be wiped');
  eq(out[2].value, 'Mumbai', 'neutral value travels');
  ok(v.rawValues().indexOf('Sih@2026#Demo') !== -1);
});

/* ================= vision ================= */
console.log('\nvision-detector');

t('skin oval is detected as a face box', () => {
  const r = visionDetector.detectFacesInBuffer(faceBuffer(200, 200), {});
  eq(r.boxes.length, 1);
  const b = r.boxes[0].box;
  ok(b.width > 80 && b.height > 100, 'box ' + JSON.stringify(b));
  eq(r.boxes[0].piiType, 'face');
  eq(r.boxes[0].mode, 'blur');
});
t('dark background yields no false face', () => {
  const W = 100, H = 100, data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 20; data[i + 1] = 26; data[i + 2] = 40; data[i + 3] = 255; }
  const r = visionDetector.detectFacesInBuffer({ data, width: W, height: H }, {});
  eq(r.boxes.length, 0);
});
t('async detect falls back to heuristic tier in Node (no ORT vendor)', async () => { /* sync shim */ });

(async () => {
  const r = await visionDetector.detect(faceBuffer(200, 200), {});
  if (r.tier !== 'heuristic-cpu' || r.detections.length !== 1) {
    failed++; console.error('  FAIL async detect tier/detections', r.tier, r.detections.length);
  } else { passed++; console.log('  ok  async detect uses heuristic tier offline'); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
