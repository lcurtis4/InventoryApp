# YGO Scanner — v8.3d

## Quick Start

Serve the folder from a local HTTP server (direct `file://` will not work — camera, CORS, and Tesseract all require HTTP).

**macOS / Linux:** `bash start_macos.sh`  
**Windows:** double-click `start_windows.bat`

Both scripts try `py`, `python`, then `python3` automatically.

---

## What Changed in v8.3d (hotfix #4)

**v8.3c added a second scan region but put it in the wrong place.** The
`right-bezel` region was anchored at ~52% of card height on the right edge of
the card art — i.e. *inside* the artwork. From the recording it was visible
that the yellow scan rectangle sat right in the middle of the card art and
never touched the set code.

On modern Konami prints the set code (e.g. `BLZD-EN045`) is printed in the
**thin strip between the bottom of the card artwork and the [TYPE/Effect]
bar**, right-aligned. Measured against the recording frames, that strip sits
at roughly **72–79% of card height**, and the code occupies the **right ~50%**
of the card width.

v8.3d renames `right-bezel` → `art-bottom-right` and corrects its coordinates:

| Region             | top   | height | left | width | Used by                                  |
| ------------------ | ----- | ------ | ---- | ----- | ---------------------------------------- |
| `art-bottom-right` | 0.72  | 0.07   | 0.50 | 0.49  | Modern prints (BLZD, MP, LED…)           |
| `bottom-left`      | 0.905 | 0.045  | 0.02 | 0.50  | Older prints (LOB, MRD, SDY…)            |

All values remain fractions of the detected card rect, so they still track
the card guide via the overlay-anchored math from v8.3a.

No other behaviour changed — region short-circuit, per-pass DB lookup, yellow
overlay outlines, region-tagged `[codeOcr]` logs, and the `regionUsed` field
in `scanCodeRegion()`'s return all carry over from v8.3c.

## What Changed in v8.3c (hotfix #3)

**The Set code panel was working in v8.3a/b, but the crop was looking at the
wrong part of the card.** On modern Konami prints (e.g. *Doomking Balerdroch*
— `BLZD-EN045`) the set code is printed on the narrow bezel on the **right**
side of the card, between the card art and the `[MACHINE/XYZ/EFFECT]` type bar,
roughly halfway down the card. The v8.3/8.3a/8.3b code only looked at the
**bottom-left** strip (where older prints put it), so on a modern card it was
cropping the effect-text box and OCR'ing flavour text instead of a set code.

v8.3c replaces the single `CODE_REGION` with a `CODE_REGIONS` array and scans
**both** regions every frame:

| Region        | Position on card (fractions)                                  | Used by                                       |
| ------------- | ------------------------------------------------------------- | --------------------------------------------- |
| `right-bezel` | `top: 0.515, height: 0.035, left: 0.55, width: 0.44`          | Modern prints (BLZD, MP, LED… — mid-right)   |
| `bottom-left` | `top: 0.905, height: 0.045, left: 0.02, width: 0.50`          | Older prints (LOB, MRD, SDY… — bottom strip) |

All values are fractions of the detected card rect (the same overlay-anchored
card rect introduced in v8.3a), so the regions track the card guide exactly.

The per-pass scan loop now runs for each region in turn and **short-circuits
on the first DB-confirmed match** — so a modern card resolves on the
`right-bezel` pass without ever burning passes on `bottom-left`, and vice
versa for an older card. If no region produces a DB hit, the region with the
highest code-extraction count wins, mirroring the previous best-of-passes
behaviour.

The yellow card-guide overlay now also draws each scan region as a **dashed
yellow rectangle**, labeled with the region name, so you can visually verify
that the crops are landing on the right parts of the card while you scan.

Every code-OCR log line is now tagged with the region name, e.g.
`[codeOcr] [right-bezel] pass#2 raw="BLZD-EN045"`, so DevTools shows exactly
which region produced any given read.

`scanCodeRegion()`'s return shape gains a `regionUsed` field so downstream
code (and the debug panel) can tell which region resolved the card.

## What Changed in v8.3b (hotfix #2)

**Name DB search was returning 0 candidates even when OCR was correctly reading
the card name.** OCR commonly appends junk tokens from the icons/pips next to
the title (e.g. `Clown Crew Meteor 68`, `Clown Crew Meteor &`, `Clown Crew Meteor 3`).
The old `fetchCandidates()` sent the whole string — trailing junk included —
to YGOPRODeck's `fname=` endpoint, which treats every token as required. With
"68" attached, the API found zero matches and the scanner gave up.

v8.3b adds a third lookup attempt: when both `name=` (exact) and `fname=`
(fuzzy) come back empty, we strip trailing OCR noise (lone digits, single
letters, short punctuation tail) and retry. `Clown Crew Meteor 68` becomes
`Clown Crew Meteor` and resolves cleanly. Front-of-string content is never
touched, so cards whose names start with digits/short tokens are not affected.

Added `[api]` console logs for every YGOPRODeck request so the lookup pipeline
is visible in DevTools alongside the existing `[ocr]` / `[core]` / `[codeOcr]` logs.

## What Changed in v8.3a (hotfix #1)

v8.3 wired the Set code panel up for per-pass live debug + per-pass DB lookup,
but `cropCodeRegion()` was returning `null` on every frame because the v8.2
crop math derived `cardH` from the visible-video width (not the actual card),
putting the crop entirely below the bottom of the source frame. v8.3a replaces
that math: the crop is now anchored on the same dashed-blue "Place card here"
rectangle `overlay.js` draws on screen — mapped back into source pixels with the
standard object-fit: cover transform. The set-code crop now lands where the
card actually is, which means the Set code panel starts populating and the
per-pass DB lookups wired up in v8.3 finally fire.

## What Changed in v8.3 (initial)

### 1 — Set Code OCR Debug Panel now matches the Name band (live, per-pass)

In v8.2 the **Set code OCR crop** panel only rendered the raw crop once at the end of the scan cycle, so it usually appeared blank or frozen — even while the **Name band OCR crop** panel was updating live on every preprocessing attempt.

v8.3 mirrors the name path:

- The Set code panel now renders the **preprocessed (binarized) image** that Tesseract actually sees on every pass.
- The overlay label shows: raw OCR text, the extracted code (if any), accuracy %, pass label (e.g. `sb th=160`, `gamma=0.5 th=140`, `otsu`), and brightness/contrast.
- Once the database confirms a hit, the label updates again to `DB: MP25-EN120 → Doomking Balerdroch` so the match is visible in the same panel.

### 2 — Per-pass database lookup for set codes

In v8.2 the database lookup for codes happened only **after** all OCR passes finished, in `core.js`. In v8.3 the lookup happens **as soon as any pass extracts a valid code** — the same way the name OCR drives its name search. The remaining passes short-circuit on the first DB-confirmed match, so a clean scan resolves quicker and the per-pass debug overlay shows the matched card name immediately.

### 3 — Console logs for every search attempt

Every code-search and name-search attempt now logs to the browser console with consistent prefixes so it's easy to follow the scan pipeline live in DevTools:

- `[codeOcr]` — per-pass OCR attempts, extracted codes, and DB lookup attempts/results
- `[ocr]` — per-pass name OCR attempts (raw text, normalized text, accuracy)
- `[codeSearch]` — every `resolveCode()` request + its outcome
- `[core]` — the merged search outcome (name + code) used to drive the candidate picker

Example console output during a successful scan:

```
[codeOcr] scanCodeRegion start — crop 432x57  brightness=84  contrast=42  lowLight=false
[codeOcr] pass 1/11 (sb th=160) → raw="MP25-EN120"  codes=["MP25-EN120"]  acc=89%
[codeOcr] DB lookup attempt for code: MP25-EN120
[codeSearch] resolveCode attempt: MP25-EN120
[codeSearch] resolveCode → multi for MP25-EN120 (3 candidates) — best: Doomking Balerdroch
[codeOcr] DB lookup result for MP25-EN120 → status=multi  candidates=3
[codeOcr] DB-confirmed match found via pass 1 (sb th=160) — stopping further passes
[core] using 3 pre-resolved candidate(s) from codeOcr.js per-pass DB lookup
```

---

## What Changed in v8.2

### 1 — Posting to Sheet (bug fix)

The success modal was never appearing after a successful post. The POST itself was reaching the sheet correctly, but the confirmation dialog stayed invisible because the CSS class `.is-open` was never added. This has been fixed: the success modal now correctly shows after every post, and the form resets cleanly afterwards.

**If posting still appears broken after this update:** open the browser console and look for `[confirm] posting row:` followed by the row object. If that line appears, the data reached `sheetsClient.js`; any failure is on the Apps Script / network side. Check `config.js` URL and SECRET match your deployment.

### 2 — Set Code OCR Debug Panel

Two separate debug canvases are now shown in the camera panel:

- **Name band OCR crop** — the title-strip region used for name recognition (unchanged from v8.1).
- **Set code OCR crop** — a new, dedicated panel showing exactly the bottom-left strip that code OCR is reading. Labelled "Set code OCR crop".

The code-crop panel also shows:
- The raw OCR text or matched code (overlaid on the canvas).
- A brightness/contrast readout: `[B:nn C:nn]` where B is mean pixel luminance (0–255) and C is RMS contrast.
- A **yellow warning badge** if B < 55 or C < 12 (likely too dim for reliable OCR) — see lighting tips below.

### 3 — Parallel Detection with Early-Exit

All three detection methods now fire simultaneously on each stable frame:

| Method | Fires | Trust |
|--------|-------|-------|
| Set code OCR → DB resolve | immediately | highest — exact code match exits instantly |
| Name OCR → fuzzy resolve | immediately (concurrent) | medium |
| Image assist (visual re-rank) | after candidates exist | bonus — non-blocking |

**Early-exit rules:**
- Exact code match → UI is notified immediately; image assist runs in background and improves ranking only if it finishes within ~1.2 s.
- Single high-confidence name match (≥ 90%) and code returned nothing → UI notified immediately.
- Multiple candidates → all three signals merged, image assist re-ranks (with 1.2 s cap), then UI is notified.

The scanner **never waits for all three** if a high-confidence result arrives early.

### 4 — Low-Light Improvements

**Camera:** on supported browsers (Chrome Android, some desktop Chrome), the camera now requests:
- Continuous autofocus (`focusMode: continuous`)
- Continuous auto-exposure (`exposureMode: continuous`)
- A modest positive exposure compensation nudge (+0.5 EV) to help dim rooms
- Continuous white balance

These are applied via `applyConstraints()` after the stream starts. Devices that don't support a particular constraint skip it silently — no errors, no broken behaviour.

**Torch button:** if the device reports torch capability (most modern Android phones), a "🔦 Torch" button appears in the controls bar. Tap to toggle. Turns off automatically when the camera stops.

**Code OCR preprocessing:** the set-code crop is now tried against multiple preprocessing variants before giving up. Additional passes added in v8.2:

| Pass | When it helps |
|------|---------------|
| Gamma 0.5 (brighten mid-tones) | dim/shadowed card bottom |
| Gamma 0.4 (stronger brightening) | very dim room |
| Auto-contrast stretch | camera under-exposes the crop |
| Otsu threshold (per-image optimal) | uneven lighting across the strip |

Passes run in order; the loop exits as soon as any pass yields a valid code, keeping latency low in good light.

---

## Lighting Tips for Better Code Recognition

1. **Use a desk lamp aimed at the card**, not behind you. The code strip at the card bottom is small and low-contrast; it needs direct, even light.
2. **Avoid overhead fluorescent/LED strips** — they often create glare on the card surface that washes out the code text.
3. **Hold the card flat**, not at an angle. Even 15° tilt distorts the code region enough to confuse OCR.
4. **Watch the "Set code OCR crop" panel.** If it looks dark grey or the text is invisible, the crop area is too dim. Move the card into better light or tap the Torch button.
5. **Watch the `[B:nn C:nn]` readout.** A healthy crop typically shows B > 80 and C > 20. If the yellow warning appears, add more light.
6. **If the code strip is always in shadow** (e.g. your grip covers it), type the code manually in the Set Code field — the manual lookup path is just as fast.
7. **Torch tip:** on Android Chrome, tap 🔦 Torch to light the card directly. Works best within 15–30 cm of the card.

---

## How to Interpret the Debug Panels

### Name band OCR crop (top panel)
Shows the title-strip region (~top 10–15% of card face). If the card name is visible and legible here, name OCR will work. Overlaid text shows the OCR result and accuracy %.

### Set code OCR crop (bottom panel)
Shows the bottom-left strip of the card face (~bottom 18%, left 65% of width). The set code (e.g. `MP25-EN120`) should be visible as small monospace text here.

- **Code found:** overlay shows `Code: MP25-EN120`
- **Text read but no match:** overlay shows `OCR: "MP25EN12O" (no match)` — the OCR confusion normalization may fix it on a subsequent pass
- **No text read:** overlay shows `No text read` — lighting or positioning issue
- **Yellow warning badge:** brightness or contrast too low; see lighting tips above

---

## Match-Source Status Bar

After a scan result arrives, a coloured bar appears below the camera panel:

| Colour | Meaning |
|--------|---------|
| Green | Exact set-code match — highest confidence |
| Blue | Manual code lookup |
| Amber | Code scanned but not resolved in DB — name fallback used |
| Orange | Name fallback only (no code read this frame) |

---

## Scanning Flow

1. **Start Camera** → scanner begins reading set code + card name simultaneously.
2. Hold card so the full face is visible. The bottom-left strip should be in frame.
3. When a high-confidence result arrives (code match or name match ≥ 90%):
   - **Single printing:** Set and Rarity are filled automatically. Fields still needing input are highlighted in amber. Choose Condition and enter Quantity.
   - **Multiple printings:** candidate picker appears — choose the correct printing.
4. Accept the result, pick Condition, enter Quantity, click **Post to Sheet**.
5. Code-confirm modal shows the set code — click **Confirm** to post.
6. Success modal confirms the post. Form resets for the next card.

---

## Required Fields and Highlights

After a code-confirmed match, fields that still need input are highlighted with an amber border:

- **Set** — pre-filled by code match, no highlight
- **Rarity** — pre-filled by code match, no highlight  
- **Condition** — highlighted until selected (unless a persisted value fills it)
- **Quantity** — highlighted until a value ≥ 1 is entered

Highlights clear as each field is completed.

---

## Configuration (`config.js`)

```js
window.APP_CONFIG = {
  SHEETS_SCRIPT_URL: "https://script.google.com/.../exec",
  SECRET: "your-secret",
};
```

The Apps Script endpoint and secret are **not modified** by v8.2.

Optional Card-DB key (DB-1 / #50):

```js
window.APP_CONFIG = {
  // ...
  CARD_DB_BASE: "snapshots/", // where manifest.json + card snapshot live.
                              // Defaults to the shipped local folder; point at
                              // a CDN base to serve a remote snapshot (#51).
};
```

---

## Local Card DB (DB-1 — #50)

Name → printings/sets/rarities lookups resolve against a **local card database**
instead of a per-scan live YGOPRODeck call (epic #49). `js/lookup/api.js`
(`fetchCardSetsAndRarities`) consults the local DB first and only falls through
to the live API on a miss.

### Storage format

- **Runtime store:** IndexedDB database `ygoCardDb` (chosen over `localStorage`
  because the full DB is several MB — past the ~5MB string cap). Object store
  `cards` keyed on `nameLower`; a `meta` store holds the loaded manifest so
  re-imports are skipped when the version is unchanged.
- **Snapshot file:** `snapshots/cards-<version>.json` (versioned by UTC build
  date), described by `snapshots/manifest.json`
  (`{ schema, version, snapshot, count, builtAt, sha256 }`).
- **Snapshot schema (v1):**
  ```json
  {
    "schema": 1,
    "version": "YYYY-MM-DD",
    "builtAt": "<ISO8601>",
    "count": 14371,
    "cards": [
      { "id": 46986414, "name": "Dark Magician",
        "sets": [ { "set_name": "...", "set_code": "...", "set_rarity": "..." } ] }
    ]
  }
  ```
- **Size:** ~4.4 MB for ~14,400 cards (~13,900 with printings) as of the
  2026-05-30 build. Image refs are **deferred** (#74) to keep this small.

### Building / refreshing the snapshot

```bash
node scripts/build_card_db.mjs              # fetch live + write snapshot + manifest
node scripts/build_card_db.mjs --in dump.json   # build from a saved API dump
```

The weekly auto-refresh (#51) re-runs this build and bumps the manifest version;
`CardDb.ready()` then imports the new snapshot on next load.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Post to Sheet does nothing | Open console — look for `[confirm] posting row:`. If present, data reached sheetsClient; check Apps Script deployment URL and SECRET in config.js |
| Success modal doesn't appear | Update to v8.2 — this was the root cause of the posting-appears-broken bug |
| Code never reads | Watch the code-crop panel. If it's dark, improve lighting. Try typing the code manually |
| Yellow "dim" warning | Add direct light to the card bottom; or tap Torch if available |
| Wrong code read | Type the code manually in the Set Code field — same lookup pipeline |
| No DB match for code | Some promos/regionals may not be in YGOPRODeck. Use name lookup instead |
| Camera won't start | Browser needs camera permission. On Windows: Settings → Privacy → Camera |
| Torch button not showing | Device/browser doesn't report torch capability; use external light |

---

## Developer Notes

### Files changed in v8.2

| File | Change |
|------|--------|
| `js/ui/confirm.js` | **Bug fix:** success modal now uses `window.UI.modal.open()` (adds `.is-open`). All POST logic and field names identical to v6. |
| `js/scanner/core.js` | Parallel detection with early-exit. Code crop drawn to `#codeDebugCanvas`. Low-light warning forwarded to UI hint. |
| `js/scanner/codeOcr.js` | Added gamma, auto-contrast, and Otsu preprocessing passes for low-light. Returns `brightness`, `contrast`, `lowLightWarning` fields. |
| `js/scanner/camera.js` | Requests continuous focus/exposure/WB via `applyConstraints`. Torch button added when supported. |
| `js/ui/scan.js` | `captureConfirmBtn` no longer force-enables Post button before condition is selected. Match-source status bar. `.needs-input` highlights. |
| `js/ui/lookup.js` | Clears `.needs-input` from set/rarity when name-path populates them. |
| `index.html` | Added `#codeDebugCanvas` panel, `#codeDebugHint` span, `#matchSourceBar`. Version badge updated to v8.2. |
| `style.css` | Added `.needs-input`, `.match-source-bar`, `.debug-canvas--code`, `.debug-hint` styles. |
| `config.js` | Cleaned up (removed comment blocks inside object literal). Tuning notes moved to comments outside the object. |

### Planned for later audit/refactor (not in v8.2)

- **Decouple confirm.js from modal.js** — currently confirm.js calls `window.UI.modal.open()` directly; a proper event-based or injected-dependency pattern would be cleaner.
- **Component split for scan.js** — the file handles OCR status, candidate picker, code lookup, and form highlighting; splitting into focused modules will make patching easier.
- **Unified debug panel controller** — `showDebug` and `showCodeDebug` exist in `core.js` but are called from multiple places; a small `debugPanel.js` module would centralize this.
- **Remove stale file** — `js/data/snapshotMainfest.js` (note: misspelling) appears to be a duplicate/leftover of `snapshotManifest.js`; confirm and delete in the audit.
- **Resolve `window.$` aliasing** — `$` is defined inconsistently across modules (some use `document.getElementById`, some use `document.querySelector`, some reference `window.UI.$`). Standardize in a shared `dom.js`.
