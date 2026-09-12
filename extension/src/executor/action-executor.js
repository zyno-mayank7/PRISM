/**
 * OBA Action Executor — content-script side.
 * Executes server-issued actions on the page with realistic event
 * dispatch (so React/Vue/jQuery handlers all fire) and a visible
 * overlay so the operator can watch exactly what the agent is doing.
 *
 * Values arriving here are token-RESOLVED by the service worker, i.e.
 * raw secrets only ever travel the local messaging channel.
 */
(function (root) {
  'use strict';
  const OBA = (root.OBA = root.OBA || {});

  const OVERLAY_CSS = `
    .oba-flash { position: fixed; z-index: 2147483647; pointer-events: none;
      border: 2px solid #f59e0b; border-radius: 6px;
      box-shadow: 0 0 0 3px rgba(245,158,11,.25), 0 8px 30px rgba(0,0,0,.35);
      transition: opacity .9s ease .5s; opacity: 1; }
    .oba-flash--done { border-color: #10b981; }
    .oba-flash__tag { position: absolute; left: 0; top: -22px; white-space: nowrap;
      background: #f59e0b; color: #1c1917; font: 700 11px/18px system-ui, sans-serif;
      padding: 0 8px; border-radius: 4px 4px 4px 0; }
    .oba-flash--done .oba-flash__tag { background: #10b981; color: #ecfdf5; }
  `;

  let styleInjected = false;
  function ensureStyle() {
    if (styleInjected) return;
    const st = document.createElement('style');
    st.textContent = OVERLAY_CSS;
    document.documentElement.appendChild(st);
    styleInjected = true;
  }

  function flash(el, label, done) {
    try {
      ensureStyle();
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = 'oba-flash' + (done ? ' oba-flash--done' : '');
      const tag = document.createElement('div');
      tag.className = 'oba-flash__tag';
      tag.textContent = label;
      box.appendChild(tag);
      Object.assign(box.style, {
        left: (r.x - 4) + 'px', top: (r.y - 4) + 'px',
        width: (r.width + 8) + 'px', height: (r.height + 8) + 'px'
      });
      document.documentElement.appendChild(box);
      setTimeout(() => { box.style.opacity = '0'; }, 0);
      setTimeout(() => { box.remove(); }, 1600);
    } catch (e) { /* cosmetic only */ }
  }

  function resolve(selector) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch (e) { /* bad selector */ }
    /* graceful fallbacks: id, name, text match */
    try {
      if (/^#[\w-]+$/.test(selector)) return document.getElementById(selector.slice(1));
      const byName = document.querySelector('[name="' + selector.replace(/["\\]/g, '') + '"]');
      if (byName) return byName;
      const m = selector.match(/^text=(.+)$/);
      if (m) {
        for (const b of document.querySelectorAll('button, a, input[type=submit], [role=button]')) {
          if ((b.innerText || b.value || '').trim().toLowerCase() === m[1].trim().toLowerCase()) return b;
        }
      }
    } catch (e) { /* noop */ }
    return null;
  }

  function fire(el, type, Ctor, init) {
    const ev = new Ctor(type, Object.assign({
      bubbles: true, cancelable: true, composed: true, view: window
    }, init || {}));
    el.dispatchEvent(ev);
  }

  function click(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' in el ? 'instant' : 'auto' });
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const coords = { clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0, buttons: 1 };
    try {
      fire(el, 'pointerover', PointerEvent, Object.assign({ pointerId: 1, pointerType: 'mouse' }, coords));
      fire(el, 'mouseover', MouseEvent, coords);
      fire(el, 'pointerdown', PointerEvent, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, coords));
      fire(el, 'mousedown', MouseEvent, coords);
      try { el.focus({ preventScroll: true }); } catch (e) { /* noop */ }
      fire(el, 'pointerup', PointerEvent, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, coords));
      fire(el, 'mouseup', MouseEvent, coords);
      fire(el, 'click', MouseEvent, coords);
    } catch (e) {
      el.click(); /* engines without PointerEvent */
    }
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
  }

  function type(el, value) {
    el.scrollIntoView({ block: 'center' });
    try { el.focus({ preventScroll: true }); } catch (e) { /* noop */ }
    setNativeValue(el, value);
    fire(el, 'input', InputEvent, { data: value, inputType: 'insertText' });
    fire(el, 'change', Event, {});
    try { el.blur(); } catch (e) { /* noop */ }
  }

  function scroll(direction, distance) {
    window.scrollBy({ top: direction === 'up' ? -(distance || 600) : (distance || 600), behavior: 'smooth' });
  }

  /**
   * Execute one action; returns a status object for the SW.
   * @param {object} a {action, selector, value, direction, distance}
   */
  async function execute(a) {
    a = a || {};
    try {
      if (a.action === 'scroll') {
        scroll(a.direction || 'down', a.distance || 600);
        return { ok: true, note: 'scrolled ' + (a.direction || 'down') };
      }
      if (a.action === 'finish') {
        flash(document.body, 'OBA · task complete', true);
        return { ok: true, note: 'finished' };
      }
      const el = resolve(a.selector || '');
      if (!el) return { ok: false, error: 'element not found: ' + a.selector };
      if (a.action === 'click') {
        flash(el, 'OBA · click');
        click(el);
        return { ok: true, note: 'clicked ' + a.selector };
      }
      if (a.action === 'type') {
        flash(el, 'OBA · type');
        type(el, a.value == null ? '' : String(a.value));
        return { ok: true, note: 'typed into ' + a.selector + ' (value kept local)' };
      }
      return { ok: false, error: 'unknown action: ' + a.action };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  const ActionExecutor = { execute, resolve, click, type, scroll, flash };
  OBA.actionExecutor = ActionExecutor;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ActionExecutor;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
