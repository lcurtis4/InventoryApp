# YGO Scanner — v5 — Modular

## 🚀 Quick Start (End Users)

1. Put your `config.js` (with `SCRIPT_URL` + `SECRET`) in this same folder (next to `index.html`).
2. Double-click `start_windows.bat` to open the app in your default browser.
3. Click **Start Camera**. Hold a card steady ~3 seconds for auto-scan.
4. *(Optional)* Type **Manual Name** → click **Find Printings** → Confirm → Qty → Add to Sheet.

### Troubleshooting
- If the camera doesn't start:
  - Windows Settings → **Privacy & Security → Camera** → allow browser access.
  - If running in Electron, make sure the app has camera permission.

### Threshold Tuning (`js/scanner/core.js`)
- `SAMPLE_INTERVAL_MS = 300`
- `STABLE_WINDOW_MS = 3000`
- `MOVEMENT_THRESHOLD = 6.0` *(lower = stricter for motion)*
- `MIN_CONTRAST = 22.0` *(raise if it triggers on non-card scenes)*

---

## 🛠 Developer Notes (v5)

- Uses classic `<script>` tags (no ES modules), so it runs directly from `file://`.
- **New files added in v5:**
  - `js/integrations/sheetsClient.js` → defines `window.Sheet.sendToSheet`
  - `js/ui/autocomplete.js` → defines `window.Autocomplete.attach`
- `index.html` loads both before `js/ui.js`.
