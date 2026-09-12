# OB▮ — On-device Visual Perception for Light-weight Browser Agents

A privacy-preserving browser automation system: the **perception and redaction run
entirely on the user's device**; the central reasoning server only ever receives an
irreversibly redacted screenshot and a tokenized DOM summary, and returns one
structured action at a time.

```
                        USER'S BROWSER
+-------------------------------------------------------------+
|  Web Page (target site or benchmark demo page)              |
|                     ^  executes click/type/scroll            |
|                     v                                        |
|  [Content Script] DOM serializer + action executor          |
|          |                                                  |
|          v                                                  |
|  [Background Service Worker]                                |
|      captureVisibleTab (raw, local only)                    |
|      Hybrid perception:                                     |
|        - DOM PII inspector (types/autocomplete/labels)      |
|        - regex + Luhn value forensics                       |
|        - vision tier (WebGPU/ONNX or heuristic CV)          |
|      Irreversible redaction (OffscreenCanvas pixels)        |
|      Local vault tokenization ([USER_PASSWORD_1] ...)       |
|      Leak assertion -> 0-PII guarantee or transmission      |
|                             blocked                         |
+-------------------------------------------------------------+
                              |  HTTPS: sanitized JPEG + tokenized DOM only
                              v
+-------------------------------------------------------------+
|  CENTRAL REASONING SERVER (FastAPI)                         |
|  /api/agent/step   VLM/LLM planner -> strict JSON action    |
|  /api/verify-redaction   independent compliance re-scan     |
|  providers: mock (offline) | Ollama | OpenAI-compatible     |
+-------------------------------------------------------------+
```

| What | Where it runs | Ever leaves the device? |
|---|---|---|
| Raw screenshot | extension service worker + sidepanel | **No** |
| Raw element values / secrets | extension session memory (vault) | **No** |
| Redacted screenshot (JPEG, blackout/blur) | → server | Yes (that is the point) |
| Tokenized DOM summary (`[USER_PASSWORD_1]`) | → server | Yes — opaque |
| Commands (`click`, `type`, `scroll`, `finish`) | → client executor | Yes (contain tokens, not secrets) |
| Token → secret resolution | client executor, local messaging | **No** |

---

## Repository layout

```
on-device-browser-agent/
├── extension/                  # Manifest V3 extension (Chrome/Edge primary, Firefox variant)
│   ├── manifest.json
│   ├── firefox/                # manifest overlay + notes for Firefox (sidebar_action)
│   ├── icons/                  # generated (scripts/make_icons.py)
│   ├── src/
│   │   ├── core/               # constants (contracts), util (IoU, Luhn, PII regexes)
│   │   ├── perception/         # dom-detector.js, vision-detector.js
│   │   ├── redaction/          # canvas-redactor.js (irreversible pixels), vault.js (tokens)
│   │   ├── content/            # serializer.js, content-script.js bootstrap
│   │   ├── executor/           # action-executor.js (realistic events + overlay)
│   │   ├── background/         # service-worker.js — the perceive→act loop
│   │   └── sidepanel/          # operator UI: twin lightbox privacy inspector
│   ├── tests/                  # 20 node unit tests (run_all.js)
│   └── scripts/                # make_icons.py, setup-vendor.sh (optional ONNX tier)
├── server/                     # FastAPI reasoning backend
│   ├── main.py                 # /health, /api/agent/step, /api/verify-redaction
│   ├── models/schemas.py       # Pydantic contracts (mirror of the client's)
│   ├── agent/planner.py        # mock | ollama | openai-compatible providers
│   └── tests/                  # 13 pytest cases
└── benchmark-suite/
    ├── index.html              # evaluation bench landing page
    ├── demo-pages/             # login, checkout, KYC (synthetic, all fake data)
    ├── ground-truth/           # per-page element + region specs
    ├── generators/             # synthetic screenshots + face asset (deterministic)
    ├── runner/run_detection.js # executes the REAL extension modules in Node
    ├── evaluator.py            # the 5 competition metrics + report
    ├── fixtures/  reports/     # generated (deterministic, reproducible)
    └── serve.py                # serves the bench on :8080
```

**One code base, five runtimes.** Every shared module is a plain classic script that
attaches to `globalThis.OBA` and also exports CommonJS — the *same files* run inside
the Chrome service worker (`importScripts`), the Firefox event page, content scripts,
the sidepanel, and Node for the benchmark. No build step, no bundler: load the
extension folder unpacked as-is.

> Note on the plan: the design doc named `.ts` sources. This implementation keeps the
> identical module boundaries and responsibilities in dependency-free JavaScript so
> the artifact loads instantly via `chrome://extensions → Load unpacked` with zero
> toolchain. Porting to TypeScript is mechanical if a build step is ever preferred.

## Quickstart (3 terminals, ~2 minutes)

```bash
# 1. reasoning server
cd server
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000

# 2. benchmark demo pages
cd ../benchmark-suite
python3 serve.py                 # http://127.0.0.1:8080

# 3. load the extension
#    Chrome/Edge: chrome://extensions → Developer mode → Load unpacked → extension/
#    (Firefox: copy firefox/manifest.firefox.json over manifest.json, then
#     about:debugging → Load Temporary Add-on → open the sidepanel via View → Sidebar)
```

## The 5-minute judge demo

1. Open `http://127.0.0.1:8080` and click **kyc-portal** (or any demo page).
2. Click the extension icon to open the sidepanel. The status dot turns green
   (`mock · deterministic-dom-planner`).
3. Press the **KYC page** preset chip (or type your own task) and hit **Run task**.
4. Watch the twin lightbox: the **left pane** is the raw capture (amber tag —
   “stays on this device”); the **right pane** is what the server actually receives —
   photo destroyed, ID/DOB/name blacked out, with detection boxes overlaid.
5. Watch the action log fill: the server commands `type [USER_PASSWORD_1]`,
   the client resolves the token locally, the form fills, the submit button
   clicks, and the page shows **“KYC submitted”**.
6. Open DevTools → Network on the extension service worker: every request to
   `/api/agent/step` contains only the sanitized JPEG + tokens. Paste any request
   body into `POST /api/verify-redaction` to get an independent compliance verdict.
7. For the offline proof: `cd benchmark-suite && python3 evaluator.py` prints the
   5-metric scorecard (see below) and writes `reports/report.md` plus
   before/after images.

## The five competition metrics

`python3 benchmark-suite/evaluator.py` — all client-side numbers come from executing
the **real extension modules** in Node against deterministic synthetic screenshots
(the runner requires the very files the browser loads).

| Metric | Weight | Method | Typical result |
|---|---|---|---|
| 1. Visual context accuracy | 25% | F1 of perceived interactive elements vs GT (hidden decoys must be dropped) | 100.0 |
| 2. PII detection P/R | 20% | TP/FP/FN over sensitive fields + faces (vision IoU ≥ 0.3) | 100.0 |
| 3. Precision of redaction | 20% | mean IoU + full-coverage + over-mask penalty, hard-gated on irreversibility verification | ~90 |
| 4. Client resource utilization | 20% | JS heap ~5 MB, perception ~3 ms (heuristic tier) | 100.0 |
| 5. End-to-end latency | 15% | perceive + redact + server round-trip; live numbers in the sidepanel | 100.0 (offline) |

Privacy gates run on every fixture: per-block pixel-constancy verification,
pixel-mutation deltas inside every sensitive region, and the zero-leak assertion
(vault values + GT raw strings + PII regexes over the serialized payload).

## Privacy mechanisms (what makes redaction *irreversible*)

- **Blackout** (text PII: passwords, cards, IDs): bytes zeroed. Destruction, not hiding.
- **Pixelate + smear** (faces/photos): region resampled to a coarse block grid
  (blocks are the *unit of destruction* — within-block detail is averaged away),
  then a box-blur smear scaled to the grid. A post-pass verifier asserts each block
  is internally constant; unredacted regions fail it (negative controls in tests).
- **Tokenization**: sensitive values become `[USER_PASSWORD_1]`-style tokens mapped
  in session memory only. Placeholders are dropped from transport because they
  routinely embed PII-shaped example strings.
- **Leak assertion**: before *every* network call the whole payload is serialized,
  tokens are stripped, and the remainder is scanned for raw vault values, emails,
  phones, SSN/Aadhaar patterns, DOBs and Luhn-valid cards. Any hit → transmission
  blocked, step aborted, operator notified.
- **Server-side re-verification**: `/api/verify-redaction` independently re-scans
  payloads (regexes, Luhn, token discipline, black-pixel ratio of the JPEG).

## Reasoning providers

| Provider | Config | Notes |
|---|---|---|
| `mock` (default) | `OBA_PROVIDER=mock` | deterministic DOM planner; full offline demo; the system prompt still mirrors the real contract |
| `ollama` | `OBA_PROVIDER=ollama OBA_MODEL=qwen2.5vl:7b OBA_OLLAMA_URL=http://127.0.0.1:11434` | local open-weights VLM (Qwen2-VL / LLaVA / llama3.2-vision); screenshot + DOM go in the chat |
| `openai-compatible` | `OBA_PROVIDER=openai OBA_API_BASE=… OBA_API_KEY=… OBA_MODEL=gpt-4o-mini` | any cloud/OpenAI-compatible endpoint (Gemini compat, vLLM serving, …) |

All providers share the same redaction-scheme-aware system prompt: the model is told
tokens must be echoed back as `type` values and never resolved.

## Vision tiers (latency vs capability)

1. **`heuristic-cpu` (default, always available)** — YCbCr skin-chroma segmentation,
   morphological dilation, connected-component analysis → face boxes. ~3 ms, zero
   downloads, deterministic; this is the offline “mock inference fallback” that
   guarantees the end-to-end loop on any machine.
2. **`ort-webgpu` / `ort-wasm` (optional)** — ONNX Runtime Web with the WebGPU
   execution provider. Run `extension/scripts/setup-vendor.sh` once (fetches
   ort.min.js + jsep wasm + a face-detection ONNX); the service worker auto-detects
   the vendor bundle and degrades gracefully if inference fails. A model-specific
   output parser may be needed — see `runOrt()` in `vision-detector.js`.

DOM-based perception (types, `autocomplete=cc-*`, labels, ARIA, Luhn) covers
everything the DOM can express at effectively zero cost; the vision tier exists
for pixels the DOM cannot explain (photos, canvas, faces).

## Testing

```bash
cd extension  && node tests/run_all.js        # 20 unit tests (detector/redactor/vault/vision)
cd server     && python3 -m pytest tests/ -q  # 13 API tests (step loop, schema, verify-redaction)
cd benchmark-suite && python3 evaluator.py    # 5 metrics + privacy gates + report
```

`scripts/verify.sh` at the repo root chains all three.

## Honest limitations

- The service worker loop and `captureVisibleTab` paths are exercised manually
  (they need a real browser); everything beneath them is unit- and benchmark-tested.
- The mock planner reads the fixed demo captcha (`A7X3`) rather than solving it from
  the sanitized image — a real VLM provider reads it from the transmitted JPEG.
- The ONNX/WebGPU tier ships unbundled (licensing + size); the heuristic tier is
  the scored, always-on path.
- Redaction boxes inherit a small safety padding, which trades a few IoU points
  for guaranteed coverage — visible as metric 3 scoring ~90 rather than 100.
