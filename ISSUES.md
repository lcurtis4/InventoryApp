# Issues Backlog

Tracks pending work items. Tackle one at a time.

## Open

- [ ] Investigate `js/data/snapshotMainfest.js` (typo: "Mainfest"). Both `snapshotManifest.js` and `snapshotMainfest.js` ship in v12 — confirm which is canonical and remove the duplicate.
- [ ] Code scanner set-code pattern context: teach scanner/OCR post-processing to look for Yu-Gi-Oh set codes matching `XXXX-ENNN`, where `X` is any A-Z letter and `N` is any digit 0-9.
- [ ] Reformat outbound/sent timestamps to `DD/MM/YY HH:MM:SS`. Audit where timestamps are constructed before being sent (e.g., to the Apps Script backend / sheet writes) and emit them in `DD/MM/YY HH:MM:SS` format consistently.

## Closed

- [x] Promote v12 as the latest version on `main` (2026-05-27).
