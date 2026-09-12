/**
 * OBA Background Service Worker — central controller.
 *
 * Per agent step:
 *   1. captureVisibleTab            (raw screenshot, local only)
 *   2. DOM snapshot from content    (serialized elements + viewport)
 *   3. DOM PII detection            (zero-latency)
 *   4. Vision detection             (WebGPU/ONNX tier or heuristic CV)
 *   5. Coordinate fusion            (CSS px -> capture px scaling)
 *   6. Irreversible redaction       (OffscreenCanvas pixel mutation)
 *   7. Vault tokenization           (raw values never leave device)
 *   8. Leak assertion               (0-PII guarantee before transmit)
 *   9. POST sanitized payload       (server /api/agent/step)
 *  10. Execute returned action      (content script, token-resolved)
 *
 * The RAW screenshot and raw element values are shared ONLY with the
 * sidepanel (same extension process). The network sees the sanitized
 * JPEG + tokenized DOM summary exclusively.
 */
(function (root) {
  'use strict';
  const OBA = (root.OBA = root.OBA || {});
  const api = (typeof chrome !== 'undefined') ? chrome : browser;

  /* Chromium: classic SW pulls the modules in. Firefox: the manifest
   * background.scripts array has already loaded them. */
  if (typeof importScripts === 'function' && !OBA.domDetector) {
    importScripts(
      '/src/core/constants.js',
      '/src/core/util.js',
      '/src/perception/dom-detector.js',
      '/src/perception/vision-detector.js',
      '/src/redaction/canvas-redactor.js',
      '/src/redaction/vault.js'
    );
  }
  const MSG = OBA.MSG;
  const U = OBA.util;

  const state = {
    running: false,
    abort: false,
    session: null,
    vault: null,
    serverUrl: OBA.DEFAULTS.SERVER_URL
  };

  /* ---------------------------------------------------------------- */
  /* bootstrap                                                        */
  /* ---------------------------------------------------------------- */
  api.runtime.onInstalled.addListener(async () => {
    try { if (api.sidePanel) api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (e) {}
    await loadSettings();
  });
  api.runtime.onStartup.addListener(async () => { await loadSettings(); });

  async function loadSettings() {
    try {
      const got = await api.storage.local.get({ 'oba.serverUrl': OBA.DEFAULTS.SERVER_URL });
      state.serverUrl = got['oba.serverUrl'] || OBA.DEFAULTS.SERVER_URL;
    } catch (e) { /* keep default */ }
  }

  /* ---------------------------------------------------------------- */
  /* message router                                                   */
  /* ---------------------------------------------------------------- */
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case MSG.PING:
        sendResponse({ ok: true, running: state.running, serverUrl: state.serverUrl });
        return;
      case MSG.RUN_TASK:
        runTask(String(msg.task || '').trim() || 'Assist the user on this page.')
          .catch(err => broadcast(MSG.TASK_ERROR, { error: String(err && err.message || err) }));
        sendResponse({ ok: true, started: true });
        return;
      case MSG.STOP_TASK:
        state.abort = true;
        sendResponse({ ok: true });
        return;
      case MSG.RESET_SESSION:
        state.session = null;
        if (state.vault) state.vault.clear();
        sendResponse({ ok: true });
        return;
      case MSG.SETTINGS_UPDATED:
        loadSettings().then(() => sendResponse({ ok: true, serverUrl: state.serverUrl }));
        return true;
    }
  });

  async function broadcast(type, payload) {
    try { await api.runtime.sendMessage(Object.assign({ type }, payload)); }
    catch (e) { /* sidepanel closed — fine */ }
  }

  /* ---------------------------------------------------------------- */
  /* helpers                                                          */
  /* ---------------------------------------------------------------- */
  async function getActiveTab() {
    const tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs && tabs[0];
  }

  async function tabMessage(tabId, payload, timeoutMs) {
    timeoutMs = timeoutMs || 2500;
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, error: 'timeout' }); } }, timeoutMs);
      api.tabs.sendMessage(tabId, payload).then(res => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(res || { ok: false, error: 'no response' }); }
      }).catch(err => {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: String(err && err.message || err) }); }
      });
    });
  }

  async function ensureContentScript(tab) {
    if (tab.url && /^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(tab.url)) {
      throw new Error('The agent cannot run on internal browser pages. Open a normal http(s) page (e.g. the benchmark demo pages).');
    }
    let ping = await tabMessage(tab.id, { type: MSG.PING }, 800);
    if (ping && ping.ok) return true;
    /* content script may not be injected yet (e.g. freshly loaded tab) */
    try {
      await api.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'src/core/constants.js', 'src/core/util.js',
          'src/perception/dom-detector.js',
          'src/content/serializer.js',
          'src/executor/action-executor.js',
          'src/content/content-script.js'
        ]
      });
      ping = await tabMessage(tab.id, { type: MSG.PING }, 1500);
      return !!(ping && ping.ok);
    } catch (e) {
      return false;
    }
  }

  async function captureVisible(tab) {
    const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return dataUrl;
  }

  async function decodeToImageData(dataUrl) {
    const blob = new Blob([OBA.redactor.dataUrlToBytes(dataUrl)], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const imageData = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close && bmp.close();
    return imageData;
  }

  async function serverStep(payload) {
    const res = await fetch(state.serverUrl + '/api/agent/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('server ' + res.status + ': ' + text.slice(0, 200));
    }
    return res.json();
  }

  function heapMB() {
    try {
      const m = (typeof performance !== 'undefined') && performance.memory;
      return m ? U.round(m.usedJSHeapSize / 1048576, 1) : null;
    } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- */
  /* main loop                                                        */
  /* ---------------------------------------------------------------- */
  async function runTask(task) {
    if (state.running) { broadcast(MSG.TASK_ERROR, { error: 'A task is already running.' }); return; }
    state.running = true; state.abort = false;
    state.session = { id: U.uid('sess'), step: 0 };
    state.vault = OBA.createVault();

    const tTask = U.now();
    let lastAction = null, finishReason = null, ok = true;
    try {
      while (!state.abort && state.session.step < OBA.DEFAULTS.MAX_STEPS) {
        const stepResult = await runOneStep(task);
        lastAction = stepResult.action;
        if (stepResult.fatal) { ok = false; break; }
        if (stepResult.action && stepResult.action.action === 'finish') {
          finishReason = stepResult.action.reasoning || 'Task complete.';
          break;
        }
        await sleep(OBA.DEFAULTS.STEP_SETTLE_MS);
      }
      if (!finishReason && state.abort) finishReason = 'Stopped by operator.';
      else if (!finishReason) finishReason = 'Step budget exhausted (' + OBA.DEFAULTS.MAX_STEPS + ').';
    } catch (err) {
      ok = false;
      broadcast(MSG.TASK_ERROR, { error: String(err && err.message || err) });
    } finally {
      state.running = false;
      broadcast(MSG.TASK_DONE, {
        ok, steps: state.session ? state.session.step : 0,
        totalMs: U.round(U.now() - tTask, 0), reason: finishReason
      });
    }
  }

  async function runOneStep(task) {
    const timings = {};
    const T = () => U.now();

    /* 1 — active tab */
    const tab = await getActiveTab();
    if (!tab || !tab.id) { broadcast(MSG.TASK_ERROR, { error: 'No active tab.' }); return { fatal: true }; }

    /* 2 — content script present? */
    const ready = await ensureContentScript(tab);
    if (!ready) {
      broadcast(MSG.TASK_ERROR, { error: 'Content script unreachable on this page. Reload the tab and retry.' });
      return { fatal: true };
    }

    /* 3 — raw capture (LOCAL ONLY) */
    let t = T();
    const rawDataUrl = await captureVisible(tab);
    timings.captureMs = U.round(T() - t, 1);

    /* 4 — DOM snapshot */
    t = T();
    const snapRes = await tabMessage(tab.id, { type: MSG.DOM_SNAPSHOT_REQUEST }, 3000);
    if (!snapRes || !snapRes.ok) { broadcast(MSG.TASK_ERROR, { error: 'DOM snapshot failed: ' + (snapRes && snapRes.error) }); return { fatal: true }; }
    const snapshot = snapRes.snapshot;
    timings.domMs = U.round(T() - t, 1);

    /* 5 — hybrid perception */
    t = T();
    const domResult = OBA.domDetector.detect(snapshot.elements);
    const imageData = await decodeToImageData(rawDataUrl);
    const visionResult = await OBA.visionDetector.detect(imageData, {});
    timings.perceptionMs = U.round(T() - t, 1);

    const detections = domResult.detections.concat(visionResult.detections);

    /* 6 — coordinate fusion: CSS px -> capture px */
    const sx = imageData.width / Math.max(1, snapshot.viewport.width);
    const sy = imageData.height / Math.max(1, snapshot.viewport.height);

    /* 7 — irreversible redaction */
    t = T();
    const redaction = await OBA.redactor.redactScreenshot(rawDataUrl, detections, { sx, sy });
    timings.redactionMs = U.round(T() - t, 1);
    if (!redaction.verification.ok) {
      /* Redaction failed verification — refuse to transmit anything. */
      broadcast(MSG.TASK_ERROR, { error: 'Redaction verification failed; step aborted. Nothing was sent.', failures: redaction.verification.failures });
      return { fatal: true };
    }

    /* 8 — tokenized DOM summary for transport */
    const domElements = state.vault.tokenizeElements(snapshot.elements, domResult.detections);

    const payload = {
      task,
      url: snapshot.url,
      title: snapshot.title,
      screenshot_base64: redaction.sanitizedBase64,
      dom_elements: domElements,
      viewport: snapshot.viewport,
      step_index: state.session.step,
      session_id: state.session.id,
      perception: {
        tier: visionResult.tier,
        domMs: domResult.stats.latencyMs,
        visionMs: visionResult.latencyMs,
        redactionMs: redaction.stats.latencyMs,
        piiDetected: detections.length,
        redactionVerified: redaction.verification.ok
      }
    };

    /* 9 — leak assertion: 0-PII guarantee before transmit */
    const leak = OBA.redactor.assertNoLeakage(payload, state.vault.rawValues());
    if (!leak.ok) {
      broadcast(MSG.TASK_ERROR, { error: 'Leak assertion failed — transmission blocked.', leaks: leak.leaks });
      return { fatal: true };
    }

    /* 10 — server reasoning */
    t = T();
    let action;
    try { action = await serverStep(payload); }
    catch (err) {
      broadcast(MSG.TASK_ERROR, { error: 'Reasoning server unreachable (' + state.serverUrl + '). Start it with: uvicorn main:app --port 8000' });
      return { fatal: true };
    }
    timings.networkMs = U.round(T() - t, 1);
    if (!OBA.isValidAction(action)) {
      broadcast(MSG.TASK_ERROR, { error: 'Server returned an invalid action: ' + JSON.stringify(action).slice(0, 200) });
      return { fatal: true };
    }

    /* 11 — local view for the operator (raw never leaves the device) */
    broadcast(MSG.INSPECTOR_UPDATE, {
      step: state.session.step,
      rawDataUrl,
      sanitizedDataUrl: redaction.sanitizedDataUrl,
      detections: detections.map(d => ({
        box: d.box, piiType: d.piiType, mode: d.mode,
        confidence: U.round(d.confidence, 2), source: d.source, selector: d.selector
      })),
      domSummary: domElements.slice(0, 40),
      action
    });

    /* 12 — execute (token resolved LOCALLY) */
    if (action.action !== 'finish') {
      t = T();
      const execMsg = Object.assign({}, action);
      if (typeof execMsg.value === 'string') {
        execMsg.value = state.vault.resolveIfToken(execMsg.value);
      }
      const execRes = await tabMessage(tab.id, { type: MSG.EXECUTE_ACTION, action: execMsg }, 4000);
      timings.execMs = U.round(T() - t, 1);
      if (!execRes || !execRes.ok) {
        /* element vanished — let the planner see the new state next step */
        broadcast(MSG.TELEMETRY, { execError: execRes && execRes.error });
      }
    }

    state.session.step++;

    /* 13 — telemetry */
    broadcast(MSG.TELEMETRY, {
      step: state.session.step,
      sessionId: state.session.id,
      timings,
      totalMs: U.round(timings.captureMs + timings.domMs + timings.perceptionMs + timings.redactionMs + timings.networkMs + (timings.execMs || 0), 1),
      visionTier: visionResult.tier,
      piiDetected: detections.length,
      redactionVerified: redaction.verification.ok,
      leakFree: leak.ok,
      heapMB: heapMB(),
      action
    });

    return { action };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
