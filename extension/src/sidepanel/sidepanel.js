/**
 * OBA sidepanel controller — talks to the service worker only.
 * Renders the twin lightbox (raw vs sanitized), telemetry chips,
 * and the action log. Saves the server URL setting.
 */
(function () {
  'use strict';
  const MSG = globalThis.OBA && OBA.MSG;
  const api = (typeof chrome !== 'undefined') ? chrome : browser;

  const $ = (id) => document.getElementById(id);
  const el = {
    connDot: $('connDot'), connLabel: $('connLabel'),
    serverUrl: $('serverUrl'), task: $('task'),
    runBtn: $('runBtn'), stopBtn: $('stopBtn'), runState: $('runState'),
    rawImg: $('rawImg'), sanImg: $('sanImg'), boxCanvas: $('boxCanvas'),
    rawEmpty: $('rawEmpty'), sanEmpty: $('sanEmpty'),
    rawScreen: document.querySelector('[data-side="raw"] .pane__screen'),
    sanScreen: document.querySelector('[data-side="san"] .pane__screen'),
    showBoxes: $('showBoxes'),
    teleChips: $('teleChips'), latBar: $('latBar'), latLabel: $('latLabel'),
    logList: $('logList')
  };

  let latestDetections = [];

  /* ---------------- settings ---------------- */
  api.storage.local.get({ 'oba.serverUrl': 'http://127.0.0.1:8000' }).then(g => {
    el.serverUrl.value = g['oba.serverUrl'];
    pingServer();
  }).catch(() => pingServer());

  let pingTimer = null;
  el.serverUrl.addEventListener('change', () => {
    api.storage.local.set({ 'oba.serverUrl': el.serverUrl.value.trim() });
    api.runtime.sendMessage({ type: MSG.SETTINGS_UPDATED });
    pingServer();
  });

  async function pingServer() {
    const url = (el.serverUrl.value || '').trim();
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = setTimeout(async () => {
      try {
        const r = await fetch(url.replace(/\/$/, '') + '/health', { cache: 'no-store' });
        const j = await r.json();
        el.connDot.className = 'dot dot--up';
        el.connLabel.textContent = (j.provider || 'planner') + ' · ' + (j.model || '');
      } catch (e) {
        el.connDot.className = 'dot dot--down';
        el.connLabel.textContent = 'server offline';
      }
    }, 300);
  }

  /* ---------------- task control ---------------- */
  document.querySelectorAll('.presets .chip').forEach(b => {
    b.addEventListener('click', () => { el.task.value = b.dataset.task; el.task.focus(); });
  });

  el.runBtn.addEventListener('click', () => {
    if (!el.task.value.trim()) { el.task.focus(); return; }
    el.logList.innerHTML = '';
    api.runtime.sendMessage({ type: MSG.RUN_TASK, task: el.task.value.trim() });
    setRunning(true);
  });
  el.stopBtn.addEventListener('click', () => {
    api.runtime.sendMessage({ type: MSG.STOP_TASK });
  });

  function setRunning(on) {
    el.runBtn.disabled = on;
    el.stopBtn.disabled = !on;
    el.runState.textContent = on ? 'running…' : '';
  }

  /* ---------------- runtime messages ---------------- */
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === MSG.INSPECTOR_UPDATE) renderInspector(msg);
    else if (msg.type === MSG.TELEMETRY) renderTelemetry(msg);
    else if (msg.type === MSG.TASK_DONE) { setRunning(false); logFinish(msg); }
    else if (msg.type === MSG.TASK_ERROR) { setRunning(false); logError(msg.error); }
  });

  /* ---------------- inspector ---------------- */
  function renderInspector(m) {
    el.rawImg.src = m.rawDataUrl;
    el.sanImg.src = m.sanitizedDataUrl;
    el.rawScreen.classList.add('has-img');
    el.sanScreen.classList.add('has-img');
    latestDetections = m.detections || [];
    el.sanImg.decode ? el.sanImg.decode().then(drawBoxes).catch(drawBoxes) : drawBoxes();
  }

  function drawBoxes() {
    const cv = el.boxCanvas;
    const nat = { w: el.sanImg.naturalWidth, h: el.sanImg.naturalHeight };
    if (!nat.w) return;
    cv.width = nat.w; cv.height = nat.h;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, nat.w, nat.h);
    if (!el.showBoxes.checked) { el.sanScreen.classList.remove('show-boxes'); return; }
    el.sanScreen.classList.toggle('show-boxes', el.showBoxes.checked);
    latestDetections.forEach(d => {
      const b = d.box;
      if (!b || !b.width) return;
      ctx.strokeStyle = d.mode === 'blur' ? '#14b8a6' : '#f59e0b';
      ctx.lineWidth = Math.max(2, nat.w / 320);
      ctx.setLineDash(d.mode === 'blur' ? [] : []);
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      ctx.fillStyle = d.mode === 'blur' ? 'rgba(20,184,166,.14)' : 'rgba(245,158,11,.18)';
      ctx.fillRect(b.x, b.y, b.width, b.height);
      const tag = (d.piiType || '?') + ' ' + Math.round((d.confidence || 0) * 100) + '%';
      ctx.font = Math.max(11, Math.round(nat.w / 60)) + 'px ui-monospace, monospace';
      const tw = ctx.measureText(tag).width + 8;
      ctx.fillStyle = d.mode === 'blur' ? '#14b8a6' : '#f59e0b';
      ctx.fillRect(b.x, Math.max(0, b.y - 18), tw, 17);
      ctx.fillStyle = '#10131a';
      ctx.fillText(tag, b.x + 4, Math.max(12, b.y - 6));
    });
  }

  el.showBoxes.addEventListener('change', drawBoxes);

  /* ---------------- telemetry ---------------- */
  function renderTelemetry(m) {
    if (m.action) logAction(m.step, m.action);
    const t = m.timings || {};
    const total = m.totalMs != null ? m.totalMs : 0;
    const chips = [];
    chips.push(chip('cycle <b>' + total + ' ms</b>'));
    if (t.perceptionMs != null) chips.push(chip('perceive <b>' + t.perceptionMs + ' ms</b>'));
    if (t.redactionMs != null) chips.push(chip('redact <b>' + t.redactionMs + ' ms</b>'));
    if (t.networkMs != null) chips.push(chip('reason <b>' + t.networkMs + ' ms</b>'));
    chips.push(chip('PII <b>' + (m.piiDetected != null ? m.piiDetected : '—') + '</b>'));
    chips.push(m.redactionVerified ? chipOk('redaction verified') : chipWarn('redaction ✗'));
    chips.push(chip(m.leakFree ? chipOkHtml('leak-free payload') : '<b style="color:#b42318">LEAK BLOCKED</b>'));
    if (m.visionTier) chips.push(chip('vision: <b>' + m.visionTier + '</b>'));
    if (m.heapMB != null) chips.push(chip('heap <b>' + m.heapMB + ' MB</b>'));
    if (m.execError) chips.push(chipWarn('exec: ' + m.execError.slice(0, 40)));
    el.teleChips.innerHTML = chips.join('');

    const pct = Math.max(0, Math.min(100, (total / 3000) * 100));
    el.latBar.style.width = pct + '%';
    el.latBar.className = total > 1500 ? 'is-slow' : '';
    el.latLabel.textContent = 'cycle ' + total + ' ms';
  }

  const chip = (html) => '<span class="chip-data">' + html + '</span>';
  const chipOk = (txt) => '<span class="chip-data is-ok">' + txt + '</span>';
  const chipOkHtml = (txt) => '<span class="chip-data is-ok">' + txt + '</span>';
  const chipWarn = (txt) => '<span class="chip-data is-warn">' + txt + '</span>';

  /* ---------------- log ---------------- */
  function logAction(step, a) {
    const li = document.createElement('li');
    li.className = 'log__item';
    li.dataset.kind = a.action;
    const val = a.action === 'type' ? (a.value == null ? '' : String(a.value)) : '';
    const valShown = /^\[[A-Z_]+_\d+\]$/.test(val) ? val + ' (resolved locally)' : (val ? val.slice(0, 24) : '');
    li.innerHTML =
      '<div class="li__top"><span class="li__action">' + esc(a.action) +
      (a.direction ? ' ' + a.direction : '') + '</span><span class="li__step">step ' + step + '</span></div>' +
      (a.selector ? '<div class="li__selector">' + esc(a.selector) + '</div>' : '') +
      (valShown ? '<div class="li__selector">value: ' + esc(valShown) + '</div>' : '') +
      (a.reasoning ? '<div class="li__why">' + esc(a.reasoning) + '</div>' : '') +
      '<div class="li__conf"><i style="width:' + Math.round((a.confidence == null ? 0.8 : a.confidence) * 100) + '%"></i></div>';
    el.logList.appendChild(li);
    el.logList.scrollTop = el.logList.scrollHeight;
  }

  function logFinish(m) {
    const li = document.createElement('li');
    li.className = 'log__item';
    li.dataset.kind = 'finish';
    li.innerHTML =
      '<div class="li__top"><span class="li__action">task ' + (m.ok ? 'complete' : 'stopped') + '</span><span class="li__step">' +
      m.steps + ' steps · ' + (m.totalMs || 0) + ' ms</span></div>' +
      '<div class="li__why">' + esc(m.reason || '') + '</div>';
    el.logList.appendChild(li);
    el.logList.scrollTop = el.logList.scrollHeight;
    el.runState.textContent = '';
  }

  function logError(err) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="log__err">' + esc(err || 'Unknown error') + '</div>';
    el.logList.appendChild(li);
    el.logList.scrollTop = el.logList.scrollHeight;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
