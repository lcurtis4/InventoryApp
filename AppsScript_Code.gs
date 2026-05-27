/**
 * YGO Scanner — Apps Script backend (v10)
 *
 * Purpose:
 *   Receives a row payload from the YGO Scanner web app.
 *   v10 change: BEFORE appending, scan the Inventory sheet for an existing row
 *   whose (name, set, code, rarity, condition) all match the payload. If found,
 *   increment column E (Quantity) on that row instead of adding a new row.
 *
 * Contract with client (js/integrations/sheetsClient.js):
 *   POST <web app url>?key=<SECRET>
 *   Body: JSON object with keys:
 *     name, set, code, rarity, qty, condition, price, source, notes
 *
 * Response (v10):
 *   On merge:  { ok: true, row: <existing row #>, merged: true,  newQty: <int>, addedQty: <int> }
 *   On append: { ok: true, row: <new row #>,      merged: false, newQty: <int> }
 *   On error:  { ok: false, error: <message> }
 *
 * Match key (case-insensitive, trimmed):
 *   name | set | code | rarity | condition
 *   (price/timestamp/source/notes are NOT part of the key — they vary per add)
 *
 * Spreadsheet:
 *   Hardcoded SPREADSHEET_ID below. Worksheet name: "Inventory".
 *   Column order (must match row 1 headers):
 *     A:Name | B:Set | C:Code | D:Rarity | E:Quantity | F:Condition | G:Price | H:Timestamp | I:Source | J:Notes
 */

const SPREADSHEET_ID = '1e95gO9vxIpttxJF1s_i-PE4RmcAb11ArZFtKBYXiN58';
const SHEET_NAME     = 'Inventory';
const SECRET         = '0104200206121997';

// Column order — change ONLY if you reorder the headers in row 1 of "Inventory"
const COLUMNS = [
  'name', 'set', 'code', 'rarity', 'qty', 'condition', 'price',
  'timestamp', 'source', 'notes'
];

// 1-based column index of Quantity (column E). Used by the merge path.
const QTY_COL = 5;

// 1-based column indices used for matching duplicates.
const COL_NAME      = 1; // A
const COL_SET       = 2; // B
const COL_CODE      = 3; // C
const COL_RARITY    = 4; // D
const COL_CONDITION = 6; // F

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _checkKey(e) {
  const provided = (e && e.parameter && e.parameter.key) ? String(e.parameter.key) : '';
  return provided === SECRET;
}

function _getSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Worksheet "' + SHEET_NAME + '" not found');
  return sh;
}

function _normalizePrice(p) {
  if (p === null || p === undefined || p === '') return '';
  const n = Number(p);
  return isFinite(n) ? n : '';
}

function _normalizeQty(q) {
  const n = parseInt(q, 10);
  return isFinite(n) && n > 0 ? n : 1;
}

function _isoNow() {
  return new Date().toISOString();
}

// Normalize a cell for the match key: trim + lowercase. Empty stays empty.
function _norm(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().toLowerCase();
}

// Scan Inventory for a row whose match-key columns equal the incoming row.
// Returns the 1-based row number on match, or 0 if no match.
function _findDuplicateRow(sh, row) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0; // only header (or empty)

  // Pull A2:F<lastRow> in one call — name(A), set(B), code(C), rarity(D), qty(E), condition(F)
  const range = sh.getRange(2, 1, lastRow - 1, 6).getValues();

  const wantName      = _norm(row.name);
  const wantSet       = _norm(row.set);
  const wantCode      = _norm(row.code);
  const wantRarity    = _norm(row.rarity);
  const wantCondition = _norm(row.condition);

  for (let i = 0; i < range.length; i++) {
    const r = range[i];
    if (
      _norm(r[COL_NAME      - 1]) === wantName &&
      _norm(r[COL_SET       - 1]) === wantSet &&
      _norm(r[COL_CODE      - 1]) === wantCode &&
      _norm(r[COL_RARITY    - 1]) === wantRarity &&
      _norm(r[COL_CONDITION - 1]) === wantCondition
    ) {
      return i + 2; // +2 because range starts at row 2 and i is 0-based
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — health ping. Allows the client to detect bad/missing deployments.
//   GET <url>?ping=1   → { ok: true, version: "v10", time: "<iso>" }
//   GET <url>          → { ok: true, info: "YGO Scanner backend" }
// ─────────────────────────────────────────────────────────────────────────────

function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.ping) {
      return _json({ ok: true, version: 'v10', time: _isoNow() });
    }
    return _json({ ok: true, info: 'YGO Scanner backend' });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — append OR merge a row in the Inventory sheet.
// ─────────────────────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    if (!_checkKey(e)) {
      return _json({ ok: false, error: 'unauthorized' });
    }

    if (!e || !e.postData || !e.postData.contents) {
      return _json({ ok: false, error: 'no payload' });
    }

    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return _json({ ok: false, error: 'invalid JSON: ' + parseErr.message });
    }

    if (!body || typeof body !== 'object') {
      return _json({ ok: false, error: 'payload must be a JSON object' });
    }

    // Minimum-viable validation — name is required.
    const name = String(body.name || '').trim();
    if (!name) {
      return _json({ ok: false, error: 'name is required' });
    }

    // Build the row in column order.
    const row = {
      name:      name,
      set:       String(body.set       || '').trim(),
      code:      String(body.code      || '').trim(),
      rarity:    String(body.rarity    || '').trim(),
      qty:       _normalizeQty(body.qty),
      condition: String(body.condition || '').trim(),
      price:     _normalizePrice(body.price !== undefined ? body.price : body.tcgplayer_price),
      timestamp: body.timestamp ? String(body.timestamp) : _isoNow(),
      source:    String(body.source    || 'scanner').trim(),
      notes:     String(body.notes     || '').trim()
    };

    const sh = _getSheet();

    // v10: duplicate detection. Look for an existing row with matching key.
    const dupRow = _findDuplicateRow(sh, row);
    if (dupRow > 0) {
      const cell = sh.getRange(dupRow, QTY_COL);
      const existing = parseInt(cell.getValue(), 10);
      const safeExisting = isFinite(existing) && existing > 0 ? existing : 0;
      const newQty = safeExisting + row.qty;
      cell.setValue(newQty);
      return _json({
        ok: true,
        row: dupRow,
        merged: true,
        newQty: newQty,
        addedQty: row.qty,
        name: row.name,
        set: row.set,
        code: row.code
      });
    }

    // Otherwise, append as a new row.
    const values = COLUMNS.map(function (k) { return row[k]; });
    sh.appendRow(values);
    const rowNum = sh.getLastRow();
    return _json({
      ok: true,
      row: rowNum,
      merged: false,
      newQty: row.qty,
      name: row.name,
      set: row.set,
      code: row.code
    });

  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) });
  }
}
