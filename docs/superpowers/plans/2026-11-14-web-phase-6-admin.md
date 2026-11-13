# Web Phase 6 — Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff run the platform from `/admin`: users and roles, moderation, course review, money (finance, orders, refunds, payouts, plans, coupons), categories, campaigns with second-admin approval, analytics with CSV export, settings, flags, audit log and outbox.

**Architecture:** `src/app/admin/*` (desktop-first, phone-usable, client-rendered, `noindex`), one `src/features/admin-<area>` per area on the Phase 1–5 client. A shared admin kit (`src/features/admin-kit`): permission gate, data table with server cursors and URL-synced filters, confirm-with-reason dialog, status chips. Backend types the 57 remaining admin routes and reaches the spec's zero-untyped goal for everything except organizations, health, webhooks and unsubscribe.

**Tech Stack:** As Phase 5. Charts: plain SVG components (no chart library) for overview and series.

**Spec:** `docs/superpowers/specs/2026-11-06-skiller-web-frontend-design.md` (sections 7, 9 Admin, 10, 12 phase 6). Earlier web ledgers bind.

## Global Constraints

- Web branch `phase-6-admin`; backend branch `web-phase-6`, both from `main`.
- Full backend suite once per phase before merge; affected specs between tasks.
- Access is the API's: menu items and actions show from `GET /v1/me` `permissions`; the API's 403 is final (show "You don't have access"), never infer access from role names. `/admin` for a user with no admin permission is a 404-style page.
- Sensitive actions use the Phase 1 step-up dialog on `STEP_UP_REQUIRED`; never pre-prompt.
- Money: paise strings via `lib/money`; never compute totals, fees, GST, TDS or balances in the app.
- Every destructive or moderation action asks for confirmation; actions the API takes a reason for require the reason field (send it verbatim).
- Lists use API cursors unchanged; filters and cursor live in the URL so a page is shareable and survives reload.
- Campaign approval: the creating admin can never approve their own campaign (API enforces; UI hides Approve for the author and shows the API error if reached).
- CSV export downloads the API response as-is (no client-side CSV building).
- Admin pages set `robots: noindex` and never render server-side with a session.
- Every data view uses page states; AA contrast; keyboard reachable; tables usable at 375 px (cards on phones).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions taken for this plan (change any you disagree with)

1. **Layout:** `/admin` shell with a left nav grouped People (Users, Roles), Trust (Moderation, Course review, Content hides), Money (Finance, Orders, Refunds, Payouts, Payout accounts, Plans, Subscriptions, Coupons), Growth (Campaigns, Analytics), System (Categories, Settings, Flags, Audit, Outbox). Groups and items appear only with permission. Admin link in the shell's account menu when any admin permission exists.
2. **Home** `/admin`: analytics overview tiles plus counts needing action (review queue, open reports, pending refunds and payouts) as links.
3. **Detail views** open as full pages (`/admin/users/[id]`, `/admin/payouts/[id]`, `/admin/campaigns/[id]`), not drawers, so links can be shared.
4. **Moderation:** one queue across target types; each item shows the target preview (plain text) and report reasons; Uphold or Dismiss with reason. Course/review/question/answer hide and unhide live on the target's row and in the queue.
5. **Campaigns:** list, create/edit (subject, body from API's allowed format, segment), Preview (API-rendered HTML in a sandboxed iframe with no scripts), Test send to self, Approve (second admin), Send, Pause, Resume, Cancel.
6. **Analytics:** overview, series (range picker, metric), funnel; Rebuild button with confirm; CSV export per view.
7. **Settings and flags:** forms generated from the API's setting/flag list (type, default, description); save shows diff and confirm.

## Review Focus

1. **Permission edges:** user with one admin permission, permission removed mid-session. Expected: only allowed nav and actions; 403 shows no-access state, no crash, no data flash. Test in Task 2.
2. **Double approval/payment actions:** double click Approve on refund or payout, retry after timeout. Expected: one API call per click intent, button disabled while pending, API state shown after. Test in Task 5.
3. **Self-approval of campaign:** Expected: Approve hidden for author; API error shown if reached via stale page. Test in Task 7.
4. **Campaign preview HTML:** Expected: sandboxed iframe, no script execution, no access to the app's origin. Test in Task 7.
5. **Large tables and stale filters:** filter in URL, back/forward, cursor after filter change. Expected: cursor resets on filter change, no mixed pages. Test in Task 2.

---

### Task 1: Backend schemas

Backend `web-phase-6`. Type all 57 untyped admin routes (users, roles, permissions, moderation, courses review, content hides, finance, reconciliation, orders, refunds, payouts, payout accounts, plans, subscriptions, coupons, categories, campaigns, analytics incl. CSV export as `text/csv`, settings, flags, audit, outbox). Validate live responses in e2e as in Phase 2; remove them from the allowlist; ceiling to 14 (organizations, health, ready, unsubscribe, webhooks remain). Affected specs, typecheck, lint, `openapi:check-responses`. Commit `feat: typed responses for admin`. Web: `pnpm api:generate`.

### Task 2: Admin shell and kit, users and roles

`src/app/admin/{layout.tsx,page.tsx,not-found.tsx}`, `src/features/admin-kit/{permission-gate.tsx,use-permissions.ts,data-table.tsx,use-url-filters.ts,confirm-dialog.tsx,status-chip.tsx}`, `src/app/admin/users/*`, `src/app/admin/roles/*`. Users: search/filter list, detail (profile, roles, sessions), suspend/unsuspend with reason, revoke sessions, add/remove role. Roles: list, create/edit with permission picker from `GET /v1/admin/permissions`, delete with confirm. Tests: nav shows only permitted items; 403 renders no-access; non-admin gets 404 page; URL filter round-trip and cursor reset on filter change; suspend requires reason; step-up retry; role editor sends only changed permissions; home counts link to queues.

### Task 3: Moderation and course review

`/admin/moderation`, `/admin/courses/review`. Queue with target previews (plain text), uphold/dismiss with reason; course review queue: open course read-only preview (curriculum, lessons via existing player components), approve, reject with reason, flag/unflag; review/question/answer hide and unhide. Tests: plain-text preview (no HTML); actions remove item from queue after API success, keep it on failure; reject requires reason; empty queue state.

### Task 4: Categories, settings, flags, audit, outbox

`/admin/categories` (CRUD, delete confirm, API error when in use), `/admin/settings`, `/admin/flags` (forms from API metadata, diff + confirm), `/admin/audit` (filters actor/action/date, details JSON pretty-printed as text), `/admin/outbox` (dead items list). Tests: unknown setting type renders read-only; flag save sends full set as API expects; audit filters in URL.

### Task 5: Money

`/admin/finance` (summary, reconciliation list and Run with confirm), `/admin/orders`, `/admin/refunds` (approve, reject with reason), `/admin/payouts` and `[id]` (approve, reject with reason, resolve), `/admin/payout-accounts` (clear flag), `/admin/plans` (list, create, new version), `/admin/subscriptions`, `/admin/coupons` (platform coupons CRUD). Tests: amounts render API strings only; approve buttons disable while pending and one request per click; step-up on payouts; reject requires reason; plan version form shows API validation per field.

### Task 6: Analytics

`/admin/analytics`: overview tiles, series chart (SVG, accessible table fallback), funnel, range picker, Rebuild with confirm, CSV export via download of API response. Tests: range in URL; chart has text alternative; export triggers download with API filename; empty and error states.

### Task 7: Campaigns

`/admin/campaigns` and `[id]` per decision 5. Tests: author sees no Approve; second admin approves; preview in `iframe sandbox=""` with `srcdoc` of API HTML; test send shows API result; send/pause/resume/cancel follow API state; edit locked after approval when API says so.

### Task 8: End-to-end and full suite

Flows at both sizes with seeded admin, moderator and finance roles: moderator upholds a reel report and the reel disappears; admin approves a submitted course and it goes public; finance approves a refund and a payout (step-up); admin suspends a user who then can't sign in; admin edits a role and the affected user's nav changes after reload; campaign created by admin A, approved by admin B, test send arrives in fake Resend; analytics CSV downloads; setting and flag change audited; non-admin gets 404 at `/admin`. axe on admin home, a table page and a form. All earlier flows pass. Backend full suite once, then `pnpm e2e` three times; all green.

## Exit check

- [ ] Staff with the right permissions can review, moderate, pay out and run a campaign from the web app.
- [ ] Untyped API operations are down to organizations, health, webhooks and unsubscribe only.
