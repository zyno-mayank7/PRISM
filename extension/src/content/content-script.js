/**
 * OBA content-script bootstrap.
 * Wires DOM_SNAPSHOT_REQUEST / EXECUTE_ACTION messages to the serializer
 * and action executor. Loaded LAST in the content-script array.
 */
(function (root) {
  'use strict';
  const OBA = (root.OBA = root.OBA || {});
  const MSG = OBA.MSG;

  if (typeof chrome === 'undefined' && typeof browser === 'undefined') return;
  const api = typeof chrome !== 'undefined' ? chrome : browser;

  api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case MSG.PING:
        sendResponse({ ok: true, alive: true, url: location.href });
        return;

      case MSG.DOM_SNAPSHOT_REQUEST: {
        try {
          const snap = OBA.serializer.serializeDocument();
          sendResponse({ ok: true, snapshot: snap });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        return;
      }

      case MSG.EXECUTE_ACTION: {
        const action = msg.action || {};
        Promise.resolve(OBA.actionExecutor.execute(action)).then(function (res) {
          sendResponse(res || { ok: false, error: 'no result' });
        }).catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        });
        return true; /* async response */
      }
    }
  });

  /* signal presence for debugging */
  root.__obaContentReady = true;
})(typeof globalThis !== 'undefined' ? globalThis : this);
