# Fix wave report: Web Phase 6 (Admin)

Backend `web-phase-6`, web `phase-6-admin`. Nothing pushed or merged.

| Finding | Status | Commit | Test |
|---|---|---|---|
| I1 403 wins over cached data | Fixed: `DataTable`, settings form, flags manager, user detail, admin home overview (and the home tiles, which no longer show a stale count on a 403). `ConfirmDialog` re-reads the session on a 403 from the action. | web 023c3c2 | `kit.test.tsx`: 403 after rows were loaded shows no-access, hides the table, reloads the session once; `ConfirmDialog` 403 reloads once |
| M1 `course.flagged` for learners | Fixed: `flagged` is false for ENROLLED access; real value for author, `course.manage_any`, `course.review`. Schema stays boolean, description updated, openapi.json exported, web types regenerated. | backend 0b2546a, web fac26d8 | `course-moderation.e2e-spec.ts`: enrolled learner reads false, owner reads true, reviewer true |
| M2 IST inputs | Fixed: `istToIso` (fixed +05:30) for campaign "Send at" and coupon expiry; labels say IST. | web a3d71c5 | `format.test.ts`; campaign send test sends `12:30Z` for `18:00` |
| M3 preview stale after edit | Fixed: `PreviewPanel` keyed by `updatedAt`. | web a3d71c5 | `campaigns.test.tsx`: preview gone after a saved edit |
| M4 remote images in preview | Fixed: CSP meta (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`) prepended to srcdoc, `sandbox=""` kept. | web a3d71c5 | `campaigns.test.tsx` srcdoc assertion |
| M5 Payouts nav | Fixed: nav entry and the home tile need `wallet.view_any`. | web dfd465e | `admin-shell.test.tsx`: not shown for `payout.approve` alone |
| M6 Hide on deleted review | Fixed: `hideKindOf` returns null when `preview` is null. | web 6190ec9 | `moderation.test.tsx` |
| M7 bad date range | Fixed: audit form and `FilterBar` (refunds, payouts, finance, analytics) show an inline "From must not be after To." and send nothing. A hand-edited URL still gets the API error with Retry (not changed). | web 6190ec9 | `audit.test.tsx` |
| M8 CSV | Fixed: `filenameOf` prefers `filename*`, decodes safely; `revokeObjectURL` delayed 1 s. | web 6190ec9 | `analytics.test.tsx` |
| M9 tests | Fixed: back/forward re-renders earlier filter and cursor; moderator money e2e asserts "Refunds" h1, no-access text, no 404 page, no Approve, no table; I1 test; retry after a lost connection is one new request per press and shows the API's 409. | web 02aeb5b | `use-url-filters.test.tsx`, `e2e/admin.spec.ts`, `money.test.tsx` |

Deferred: a hand-edited URL with a backwards range still shows the generic error with Retry (M7 second half).
Note: refund and payout approves send no Idempotency-Key; a retry is a new request that the API resolves to the real state (tested).
