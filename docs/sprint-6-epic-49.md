# Sprint 6 — Epic #49: Local Card DB + Weekly Auto-Refresh

Status: **complete** — all child issues committed on `epic/49-local-card-db` (PR #76).

This final commit closes the epic and triggers the review process (Leroy + CodeRabbit) per the team workflow (one PR per epic; commits identify completed issues; a final commit starts review once the last issue is done).

## Delivered

| Issue | Title | Summary |
|-------|-------|---------|
| #70 | CI: CodeRabbit AI code review | `.coderabbit.yaml` (chill profile, auto-review on PRs to main, path filters, per-area instructions), `CONTRIBUTING.md` two-pass review flow. |
| #50 | DB-1: Fetch + store full card DB locally | `scripts/build_card_db.mjs` builds versioned snapshot + manifest from YGOPRODeck; `js/lookup/cardDb.js` IndexedDB store; local-DB-first lookup in `api.js`; boot warming. Baseline snapshot: 14,371 cards. |
| #51 | DB-2: Weekly refresh scheduler + diff/update | `.github/workflows/card-db-refresh.yml` weekly cron (commit-only-on-change); build-time diffing + patch sidecar + CHANGELOG; client incremental-apply. |
| #52 | DB-3: Refresh failure handling + last-good fallback | SHA-256 integrity verification before apply (SubtleCrypto); abort + keep last-good on mismatch; `meta` failure/success state + `CardDb.refreshState()`; fetch retry w/ backoff + atomic temp/rename publish. |
| #53 | DB-4: Surface DB version / last-updated in UI | `js/ui/dbInfo.js` footer showing version, count, last-updated, with amber stale-refresh warning. |
| #56 | Server-side visual recognition (spike) | `server/imageRecognition/` zero-dep Node service computing `imgScore`/`blendedScore` server-side (no CORS); client `backendHook` wiring, disabled by default, silent text-only fallback. |

## Backlog opened during the sprint
- #72 — CodeRabbit config polish / nits
- #73 — Manual CodeRabbit GitHub App install + live verify
- #74 — Add card image refs to snapshot (deferred from #50)

## Review
Review is performed at epic completion only: Leroy (Senior Dev @ Meta) posts the human review on PR #76, and CodeRabbit runs its automated pass on the same PR.
