/**
 * OBA benchmark runner — executes the REAL extension modules (the very same
 * files the browser loads) against a synthetic fixture:
 *
 *   node runner/run_detection.js fixtures/login-form/ [iterations]
 *
 * Produces <fixture>/results.json + <fixture>/redacted.bin + a sanitized
 * (vault-tokenized) DOM summary, plus timing/heap telemetry for metrics 4/5.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..', '..', 'extension', 'src');
/* load shared modules in dependency order (each attaches to globalThis.OBA
 * and exports CommonJS — identical files to the ones the browser runs) */
require(path.join(EXT, 'core', 'constants.js'));
require(path.join(EXT, 'core', 'util.js'));
const domDetector = require(path.join(EXT, 'perception', 'dom-detector.js'));
const visionDetector = require(path.join(EXT, 'perception', 'vision-detector.js'));
const redactor = require(path.join(EXT, 'redaction', 'canvas-redactor.js'));
const vaultMod = require(path.join(EXT, 'redaction', 'vault.js'));

const fixtureDir = process.argv[2];
const ITER = Number(process.argv[3] || 10);
if (!fixtureDir) { console.error('usage: node run_detection.js <fixture-dir> [iterations]'); process.exit(2); }

const gt = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gt.json'), 'utf8'));
const dom = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'elements.json'), 'utf8'));
const raw = fs.readFileSync(path.join(fixtureDir, 'raw.bin'));
const W = gt.layout.width, H = gt.layout.height;
const source = { data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), width: W, height: H };
const freshImage = () => ({ data: new Uint8ClampedArray(source.data), width: W, height: H });

const heapBefore = process.memoryUsage().heapUsed;
const timings = { dom: [], vision: [], redact: [], verify: [] };
let domResult, visionResult, redactResult, verifyResult;
let redactedBin = null;

for (let i = 0; i < ITER; i++) {
  let t = process.hrtime.bigint();
  domResult = domDetector.detect(dom.elements);
  timings.dom.push(Number(process.hrtime.bigint() - t) / 1e6);

  t = process.hrtime.bigint();
  visionResult = visionDetector.detectFacesInBuffer(source, {});
  timings.vision.push(Number(process.hrtime.bigint() - t) / 1e6);

  const img = freshImage();
  t = process.hrtime.bigint();
  redactResult = redactor.applyRedaction(img, domResult.detections.concat(visionResult.boxes));
  timings.redact.push(Number(process.hrtime.bigint() - t) / 1e6);

  t = process.hrtime.bigint();
  verifyResult = redactor.verifyRedaction(img, redactResult.applied);
  timings.verify.push(Number(process.hrtime.bigint() - t) / 1e6);
  if (i === ITER - 1) {
    /* keep the last (redacted) buffer + results for the scorer */
    redactedBin = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  }
}

const heapAfter = process.memoryUsage().heapUsed;

/* ---- full client pipeline: vault tokenization + leak assertion ---- */
const vault = vaultMod.createVault();
const sanitizedElements = vault.tokenizeElements(dom.elements, domResult.detections);
const outbound = {
  task: 'benchmark: fill the form',
  dom_elements: sanitizedElements,
  step_index: 0,
  session_id: 'bench'
};
const leakCheck = redactor.assertNoLeakage(outbound, vault.rawValues());
const gtSensitiveRaw = gt.elements
  .filter(e => e.sensitive && e.value && String(e.value).length >= 4)
  .map(e => String(e.value));
const gtLeakCheck = redactor.assertNoLeakage(outbound, gtSensitiveRaw);

const avg = (a) => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100;

fs.writeFileSync(path.join(fixtureDir, 'redacted.bin'), redactedBin);
fs.writeFileSync(path.join(fixtureDir, 'sanitized_elements.json'), JSON.stringify(sanitizedElements, null, 1));

const results = {
  page: gt.page,
  iterations: ITER,
  layout: gt.layout,
  domContext: domResult.elements.map(e => ({ tag: e.tag, selector: e.selector, type: e.type || null })),
  detections: domResult.detections.concat(visionResult.boxes).map(d => ({
    box: d.box, piiType: d.piiType, mode: d.mode,
    confidence: Math.round((d.confidence || 0) * 100) / 100,
    source: d.source, selector: d.selector || null
  })),
  appliedBoxes: redactResult.applied.map(a => ({ box: a.box, mode: a.mode, block: a.block || null, piiType: a.piiType })),
  verification: verifyResult,
  redactionStats: redactResult.stats,
  timings: {
    domMs: avg(timings.dom),
    visionMs: avg(timings.vision),
    redactMs: avg(timings.redact),
    verifyMs: avg(timings.verify),
    inferenceMs: Math.round((avg(timings.dom) + avg(timings.vision)) * 100) / 100
  },
  heap: {
    heapUsedMB: Math.round((heapAfter / 1048576) * 10) / 10,
    heapDeltaMB: Math.round(((heapAfter - heapBefore) / 1048576) * 10) / 10
  },
  leak: {
    vaultValuesOk: leakCheck.ok,
    leaks: leakCheck.leaks,
    gtRawValuesBlocked: gtLeakCheck.ok,
    tokens: sanitizedElements.filter(e => /^\[[A-Z_]+_\d+\]$/.test(e.value || '')).length
  }
};

fs.writeFileSync(path.join(fixtureDir, 'results.json'), JSON.stringify(results, null, 1));
console.log(
  `${gt.page}: ctx=${results.domContext.length} pii=${results.detections.length} ` +
  `infer=${results.timings.inferenceMs}ms redact=${results.timings.redactMs}ms ` +
  `heap=${results.heap.heapUsedMB}MB verify=${verifyResult.ok} leak-free=${leakCheck.ok}`
);
