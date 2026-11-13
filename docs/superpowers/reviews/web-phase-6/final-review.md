# Final review: Web Phase 6 (Admin)

Scope: backend `web-phase-6` vs main (backend.diff, commits 42d50d7, 32f0913, 834d5a5, 124fe42, 7090676, a126446), web `phase-6-admin` vs main (web.diff, HEAD 4f16954). I checked every finding against the branch source, not against the reports. Line numbers refer to the current branch files.

Overall: this is a careful phase. Access follows `me.permissions` only. A cold 403 renders `NoAccess` and re-reads the session. `/admin` for a non-admin throws `notFound()` behind `RequireAuth`'s loading state, so admin chrome never flashes. The layout sets `robots: noindex, nofollow`, and no admin route reads cookies or fetches on the server. `ConfirmDialog` guards with a ref and a disabled button, so a double-click sends exactly one request. A unit test proves this for refunds and payouts. Mutations `await` invalidation in `onSettled` before the dialog closes, so the row shows the API's new state. Step-up is handled only in the API client when `STEP_UP_REQUIRED` comes back, and no admin feature pre-prompts. Money is shown through `formatPaise` from API strings. The only arithmetic is chart geometry and bps/paise inputs passed through as strings.

The campaign preview iframe is `sandbox=""` + `srcDoc`, with no `allow-scripts` or `allow-same-origin`. The HTML comes from the sender's own `renderMail("promo_campaign")` with markdown-it `html: false` and a scheme allowlist. The only secret in it is the asking admin's own unsubscribe link. Its confirm page needs a form POST, and the sandbox blocks forms. The IST audit window is correct: `gte start(from)`, `lt start(to)+24h`, fixed +05:30, calendar-validated, and a reversed range is 400. Exposing `Content-Disposition` through CORS is harmless. `targetKind` is derived server-side from the QA row.

Counts: Critical 0, Important 1, Minor 9.

---

## Important

### I1. A 403 on a refetch keeps showing the old rows and actions ("data flash" after a permission is removed mid-session)
- `skiller-web/src/features/admin-kit/data-table.tsx:45`: `if (query.error && !query.data) return <AdminError .../>`
- Same pattern: `src/features/admin-settings/settings-form.tsx:46`, `src/features/admin-settings/flags-manager.tsx:129`, `src/features/admin-users/user-detail.tsx:40`, `src/features/admin-home/admin-home.tsx:64`.
- `src/lib/api/query-client.ts:14`: `staleTime: 30_000`. React Query keeps `data` when a refetch fails.

Scenario (Review Focus 1, "permission removed mid-session... no data flash"):
1. A finance admin has `/admin/refunds` open. A super admin removes `billing.refund` from their role.
2. The admin does anything that refetches the list: approves another refund (`useDecideRefund.onSettled` invalidates `moneyKeys.all`), opens another page and comes back after 30 s (the cache shows, then the refetch fails), or presses Next/First page and returns to a cached cursor.
3. The refetch gets 403. `query.error` is set but `query.data` is still the old page, so the table keeps rendering the refunds list with its amounts and Approve/Reject buttons.
4. `AdminError` never mounts, so `useSession().reload()` never runs and the menu still shows Refunds. Only an action press reveals the change, as "You don't have access to do that." in the dialog. `adminMessage` does not reload the session either.

Existing tests miss this: `kit.test.tsx:33` covers only a first-load 403, where there is no data.

Fix:
- In `DataTable` (and the five other views), let a forbidden error win over cached data: `if (query.error && (isForbidden(query.error) || !query.data)) return <AdminError .../>`. Optionally also call `queryClient.removeQueries({ queryKey })` for that key.
- In `ConfirmDialog.confirm()`'s catch, call `reload()` from `useSession` when `isForbidden(e)`, so the menu updates after a refused action too.
- Add a unit test: render the table with data, make the next GET return 403, `refetch()`, then assert that the rows are gone, `NoAccess` shows and `reload` was called once.

---

## Minor

### M1. `course.flagged` on `GET /v1/learn/courses/{slug}` is also returned to enrolled learners
- Backend `src/modules/courses/learn.service.ts:48` (`flagged: course.flaggedAt !== null`). The route is `learn.controller.ts:28-33`.
- Reachability: the route is `@AuthenticatedOnly()`, so anonymous users cannot reach it. Without a lesson, `learnAccess` (`course-access-rules.ts:61-73`) allows only ENROLLED, AUTHOR (owner, org author, `course.manage_any`) or REVIEW (`course.review`). So it is not a public leak.
- Residual: an enrolled learner (including an ORG_SEAT learner) can now read that a moderator flagged the course. That is moderation state meant for staff and the author. The impact is low, because a flagged course already disappears from the public catalog and course page.
- Fix: return the field only to staff and the owner. Set `flagged: access.via === "ENROLLED" ? false : course.flaggedAt !== null`, or better, omit it or set it to `null` for ENROLLED and make the schema `nullable` with a description. Add a spec assertion that an enrolled learner of a flagged course sees `false`/`null`. The web only reads it in `admin-courses/course-preview.tsx:51` (REVIEW/AUTHOR access), so nothing on the web changes.

### M2. `datetime-local` inputs are read in the browser's time zone while the admin UI shows IST
- `src/features/admin-campaigns/campaign-detail.tsx:114` (`new Date(scheduledAt).toISOString()`), `:226`. Also `src/features/admin-money/coupons.tsx:16-20`, `:142`.
- `formatDateTime` (`admin-kit/format.ts:1`) always shows `Asia/Kolkata`.
- Scenario: an admin whose laptop is on UTC schedules a campaign for "18:00". It goes out at 23:30 IST, and the detail page then shows "Scheduled 23:30", not what they typed. The same happens with coupon expiry. A send cannot be undone.
- Fix: label the inputs "(IST)" and convert with a fixed `+05:30` (for example `new Date(`${value}:00+05:30`)`), or at least state the browser zone next to the input. Add a unit test with `TZ=UTC`.

### M3. The campaign preview goes stale after an edit
- `src/features/admin-campaigns/campaign-detail.tsx:36-64`, `:187-191`. `usePreview` is a mutation whose `data` survives a successful `update.mutateAsync`.
- Scenario: the author previews the campaign, edits the subject or segment, and saves. The panel still shows the old subject, HTML and audience count, including the "more than 10,000 / needs a second admin" line, until they press Refresh.
- Fix: give `PreviewPanel` a `key` derived from `c.updatedAt` or a content hash, or call `preview.reset()` when `update` succeeds.

### M4. Remote images in the previewed mail load in the admin's browser
- `campaign-detail.tsx:59`. `sandbox=""` blocks scripts, forms, navigation of the top page and same-origin access, but not subresource loads. markdown-it allows `![](https://…)`.
- Effect: opening Preview fetches whatever image hosts the campaign author put in the body, from the admin's IP. This is the same as the real mail, so it is low risk. It is still a third-party request from the admin origin's user.
- Fix (optional): inject `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` at the top of `srcDoc`, or use the `csp` iframe attribute where supported. A "Load images" toggle can relax it.

### M5. The Payouts menu entry shows for `payout.approve` alone, but the list needs `wallet.view_any`
- `src/features/admin-kit/nav.ts:39` (`permissions: ["wallet.view_any", "payout.approve"]`) vs backend `admin-wallet.controller.ts:57-58,68-69` (`@RequirePermission("wallet.view_any")` on list and detail).
- Scenario: a custom role with `payout.approve` only sees "Payouts" in the menu. Clicking it shows the no-access page. Approve is the only thing they may do, and they cannot reach it.
- Fix: gate the entry on `wallet.view_any` only. Alternatively, have the backend allow `payout.approve` to read payouts.

### M6. The moderation queue offers Hide for a COURSE_REVIEW whose content is gone
- `src/features/admin-moderation/queries.ts:47` returns `"review"` for every `COURSE_REVIEW`, even when `item.preview === null`. `moderation-queue.tsx:93-98` then renders "Hide".
- Scenario: the review was deleted. The row says "The content is gone." yet offers Hide, which returns a 404 in the dialog.
- Fix: return `null` from `hideKindOf` when `item.preview` is null.

### M7. A bad audit date range shows a full-page error with a Retry that cannot succeed
- `src/features/admin-audit/audit-log.tsx:56-61` writes `from`/`to` as typed. The API's 400 (`from must not be after to`) turns into `DataTable` → `AdminError` → generic `ErrorState`. Retry repeats the same 400. Refunds and payouts (`FilterBar`) behave the same way.
- Fix: in `onSubmit`, refuse `from > to` with an inline field error and do not call `url.set`. For a hand-edited URL, show the API's validation sentence (`adminMessage`) with a "Clear filters" action instead of Retry.

### M8. CSV export robustness
- `src/features/admin-analytics/queries.ts:50-51`: `decodeURIComponent(match[1])` throws `URIError` for a plain `filename="…%…"`. The download is then reported as failed even though the bytes arrived. Wrap it in try/catch and fall back to the raw value.
- `:76-78`: `URL.revokeObjectURL` runs synchronously after `click()`. Some Safari and Firefox versions cancel the download. Defer it with `setTimeout(() => URL.revokeObjectURL(url), 0)` (or ~1 s).

### M9. Test gaps against the Review Focus
- `src/features/admin-kit/use-url-filters.test.tsx:81-86` ("back and forward work") only counts `router.push` calls. It does not show that a popped URL re-renders the list with the old filter and cursor. Add a test that changes the mocked search params (simulating back) and asserts that the query key and request use the earlier filter and cursor.
- `e2e/admin.spec.ts:399-404`: the heading regex `/Refunds|Overview|We could not/` would also accept the 404 page. Assert the "Refunds" h1 plus "You don't have access", and that no `Approve refund` button is present.
- There is no test for I1 (403 after data) and none for "retry after timeout" on refund/payout approve (Focus 2: same Idempotency-Key on a retried call). The client covers the step-up retry (`client.test.ts:112`), not a user retry after a network error. Add the I1 unit test. If the API needs one key per click intent, add a unit test that a second press after a network failure is a new request that the API resolves to its state, with the 409 text shown.
- The tests confirmed: double-click → one POST (`money.test.tsx:93`, `:164`); step-up only on demand with the same request repeated (`admin-money/step-up.test.tsx:43`, `admin-users/step-up.test.tsx:56`); author and last editor see no Approve, and a stale-page approval shows the API sentence (`campaigns.test.tsx:95-136`); iframe `sandbox=""` with `srcdoc`, no injection into the document (`campaigns.test.tsx:138`, e2e `admin.spec.ts:276`); cursor reset on filter change (`use-url-filters.test.tsx:62`, `:117`); reject reasons sent verbatim apart from surrounding spaces (`money.test.tsx:124`; the backend also `trim()`s); non-admin 404 (`admin.spec.ts:386`).

---

## Checked and fine

- Review Focus 1: menu entries and actions come from `me.permissions` (`use-permissions.ts`, `nav.ts`). A cold 403 shows `NoAccess` and re-reads `/v1/me` once (`errors.tsx:29-39`). Exception: I1.
- Review Focus 2: `confirm-dialog.tsx:51-65` uses a ref guard plus a disabled submit. `mutateAsync` resolves after `onSettled` invalidation, so the API state shows before the dialog closes.
- Review Focus 3: `campaign-detail.tsx:113` hides Approve for the author and the last editor, and once the campaign is approved. The API error is shown in the dialog.
- Review Focus 4: `sandbox=""` and `srcDoc` give an opaque origin with no scripts, no forms, no top navigation and no popups. The backend HTML comes from `renderMail` (`html: false`, scheme allowlist). The only token in it is the acting admin's own unsubscribe link, and that confirm page needs a POST, which the sandbox blocks.
- Review Focus 5: `use-url-filters.ts` makes every change `router.push`, drops `cursor` on a filter change (`:52`), and reads values from `useSearchParams`, so back and forward re-render. Query keys include filters and cursor, so pages never mix.
- Audit `from`/`to` (7090676): `istWindow` uses `gte istDayRange(from).from` and `lt istDayRange(to).to`. That is inclusive of both IST days at the exact +05:30 boundaries. Non-calendar dates are refused and so is a reversed range. Ordering by uuid7 `id` with the cursor `lt` stays consistent with `createdAt`.
- `exposedHeaders: ["Content-Disposition"]` (32f0913) only allows the configured `corsOrigins` to read that header. No risk.
- `targetKind` (a126446) is derived from `item.kind` server-side. The queue strips `kind` out of `preview`, and the OpenAPI enum is nullable.
- Admin pages: `app/admin/layout.tsx:6` sets `robots: { index: false, follow: false }`. Every page is a thin server component or a `"use client"` page rendering client features, with no server data fetch or cookie read. A non-admin hits `notFound()` inside `AdminShell` after `RequireAuth` resolves (the soft 404 is client-side, which is acceptable with noindex).
- Money: `formatPaise` on API strings everywhere. Coupon value and plan price go out as strings. `Number()` appears only for `maxUses`, `commissionBps` and chart geometry.

## Verdict

**Merge-ready after fixing I1** (a small change in `DataTable` and its siblings plus one unit test). M1 (scope `flagged` to staff and the owner) is recommended before merge because it is a one-line backend change with a spec. M2 should be fixed before campaigns are used by staff outside IST. The rest can follow.
