# OBA Benchmark Report

All client-side numbers are produced by executing the **real extension
modules** (`dom-detector.js`, `vision-detector.js`, `canvas-redactor.js`,
`vault.js`) over deterministic synthetic fixtures — the same code paths
that run inside the browser.

  Metric                        Wt      Measurement                                                     Score
  ----------------------------  ------  --------------------------------------------------------------  --------
  1  Visual context accuracy    25%     F1 = 1.000 (P=1.000, R=1.000)                                   100.0
  2  PII detection              20%     F1 = 1.000 (P=1.000, R=1.000)                                   100.0
  3  Precision of redaction     20%     IoU=0.792, coverage=1.000, overmask=0.036                       90.6
  4  Client resources           20%     heap=5.2 MB, inference=2.34 ms                                  100.0
  5  End-to-end latency         15%     cycle=6.8 ms (perceive+redact+reason)                           100.0

**Weighted composite: 98.1 / 100**

## Scoring formulas (transparent by design)

1. `score = 100 × F1` of reported interactive elements vs ground truth (selector match; hidden decoys must be excluded).
2. `score = 100 × F1` over sensitive elements + face regions (vision boxes matched at IoU ≥ 0.3).
3. `score = 100 × (0.45·meanIoU + 0.55·meanCoverage) × (1 − overmaskPenalty)` — hard-gated on per-block constancy verification, pixel-mutation, and the zero-leak assertion.
4. `score = 100 × (0.5·memScore + 0.5·latScore)`, memScore linear 60→250 MB, latScore linear 150→700 ms.
5. `score = 100 × (1 − (cycle−600)/(2500−600))`, cycle = perception + redaction + server round-trip (mock provider, in-process).

## Per-page details

### login-form
- context: {"precision": 1.0, "recall": 1.0, "f1": 1.0, "tp": 6, "fp": 0, "fn": 0}
- redaction: {"meanIoU": 0.778, "applied": 3, "gtRegions": 3, "verification": true}

### checkout-form
- context: {"precision": 1.0, "recall": 1.0, "f1": 1.0, "tp": 10, "fp": 0, "fn": 0}
- redaction: {"meanIoU": 0.783, "applied": 8, "gtRegions": 8, "verification": true}

### kyc-portal
- context: {"precision": 1.0, "recall": 1.0, "f1": 1.0, "tp": 8, "fp": 0, "fn": 0}
- redaction: {"meanIoU": 0.811, "applied": 6, "gtRegions": 6, "verification": true}

## Privacy gates
- login-form: block-constancy verification PASS, leak assertion PASS, GT raw values blocked from payload PASS, tokens emitted: 3
- checkout-form: block-constancy verification PASS, leak assertion PASS, GT raw values blocked from payload PASS, tokens emitted: 8
- kyc-portal: block-constancy verification PASS, leak assertion PASS, GT raw values blocked from payload PASS, tokens emitted: 5
