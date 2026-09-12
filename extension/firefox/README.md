# Firefox variant

The extension code is engine-agnostic (it attaches to `globalThis.OBA` as
classic scripts and talks through `chrome.*` / `browser.*` shim). The only
difference is the manifest:

1. Copy `extension/firefox/manifest.firefox.json` over `extension/manifest.json`.
2. Load the folder via `about:debugging#/runtime/this-firefox` →
   **Load Temporary Add-on…** → pick `manifest.json`.
3. The operator UI opens as a **sidebar** (View → Sidebar → OBA agent)
   instead of Chrome's side panel. Functionality is identical.

Differences vs the Chromium manifest:

- `background.service_worker` → `background.scripts` (Firefox uses an
  event page; the shared modules are listed there directly and the
  `importScripts()` call inside `service-worker.js` is skipped because it
  is guarded by `typeof importScripts === 'function'`).
- `side_panel` → `sidebar_action`.
- No `sidePanel` permission (not a Firefox permission).

Verified on Firefox 115+; the perception, redaction, vault, executor and
messaging paths are shared 1:1 with Chromium.
