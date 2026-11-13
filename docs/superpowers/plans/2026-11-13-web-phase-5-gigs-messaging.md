# Web Phase 5 — Gigs and Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visitors find gigs through search and Google; creators build and run gigs from Studio; a buyer messages a seller from a gig or profile and gets a live reply; members control which notifications they get.

**Architecture:** `src/features/gigs` (catalog, detail, cards), `src/app/studio/gigs/*` reusing the Phase 3 upload engine and builder patterns, `src/features/messaging` (conversation list, thread, live stream reader with polling fallback, unread count), and notification preferences in settings. Gig catalog and detail are server-rendered with public data; messaging is client-only.

**Tech Stack:** As Phase 4. No new dependencies: the SSE reader uses `fetch` + `ReadableStream` + `TextDecoder`.

**Spec:** `docs/superpowers/specs/2026-11-06-skiller-web-frontend-design.md` (sections 1 flow 3, 3, 5, 9 Public/Studio/Messaging, 12 phase 5). Earlier web ledgers bind.

## Global Constraints

- Web branch `phase-5-gigs`; backend branch `web-phase-5`, both from `main`.
- Full backend suite once per phase before merge; affected specs between tasks.
- Gig payments and escrow are out of scope (`gig_orders` stays off). Gig pages show the API's off-platform payment notice (`GIG_PAYMENT_NOTICE` text as returned) and a "Message seller" action; no buy button.
- Prices are paise strings formatted with `lib/money`; never computed in the app. Package price limits come from `GIG_PRICE_INVALID` details (`minPaise`, `maxPaise`), never hard-coded.
- Gig field limits come from the API's validation errors; the form mirrors these as soft hints only: title 120, description 10,000, tags 10 × 30, gallery 10, FAQs 10 (question 200, answer 1,000), features 10 × 100 per package, package name 60, description 500. One to three packages, one per tier, BASIC required.
- Gig descriptions, FAQ answers and messages are plain text with line breaks; never HTML.
- Messaging: message max 4,000 chars; 20 new conversations a day and 60 messages an hour are API limits; show the API's message on 429. `MESSAGING_NOT_ALLOWED` shows one neutral text and never guesses why.
- Live delivery: `GET /v1/conversations/stream` read with fetch and the bearer token; heartbeat every 25 s; on `expired`/`revoked` event refresh the token and reconnect; on network failure back off (1, 2, 4, 8, max 30 s) and poll `GET /v1/conversations/:id/messages?after=` every 10 s for the open thread while disconnected. At most one stream per tab (API allows 5 per user).
- Messages are idempotent on the client: dedupe by message id across stream, poll and send response; order by API timestamp then id.
- Every data view uses page states; AA contrast; keyboard reachable; 375 px first.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions taken for this plan (change any you disagree with)

1. **Gig catalog** `/gigs`: search, category, price range, delivery days, sort; server-rendered with canonical URL and structured data (`Service` + `Offer` per package). Gig detail `/gigs/[slug]`: gallery, packages as tabs (phone) or columns (desktop), FAQs, seller card, reviews only if the API returns them, "Message seller".
2. **Profile Gigs tab** and gig link cards on reels now open `/gigs/[slug]` (replaces `/soon`).
3. **Studio → Gigs:** list with status chips (Draft, Active, Paused, Hidden, Removed), create/edit on one page with tabs Details, Packages, Gallery, FAQs, Publish. Activate shows `GIG_NOT_PUBLISHABLE` reasons as a checklist; plan limit `max_active_gigs` shown before activating. Pause and delete (delete needs confirm).
4. **Messages** `/messages` (list) and `/messages/[id]` (thread); desktop shows both side by side. Start from gig ("Message seller", sends `gigId`) or profile ("Message"), both open a compose box that calls `POST /v1/conversations`. Archive/unarchive; report a conversation or message via `POST /v1/reports`; block from the thread menu reuses Phase 4 block.
5. **Unread:** messages badge in the shell from `GET /v1/conversations/unread-count`, updated by the stream and on focus; no polling while the stream is up.
6. **Notification preferences** `/settings/notifications` from `GET/PUT /v1/me/notification-preferences`; message notifications open the thread.

## Review Focus

1. **Stream drops and token expiry mid-thread:** Expected: reconnect with fresh token, missed messages fetched with `after=`, no duplicates, no lost messages. Test in Task 4.
2. **Send retry after timeout:** double tap or network error on send. Expected: one message shown per successful send, failed send shows Retry, text kept. Test in Task 4.
3. **Blocked or disallowed recipient:** Expected: neutral `MESSAGING_NOT_ALLOWED` text, compose disabled, blocked user's messages hidden. Test in Task 4.
4. **Gig edited while active / hidden by moderation:** Expected: Studio shows the API state and reason; public page gives real 404 for hidden or removed. Test in Task 3.
5. **Many tabs open:** Expected: each tab one stream; closing tabs releases streams; unread count consistent after read in another tab (on focus). Test in Task 4.

---

### Task 1: Backend schemas and messaging check

Backend `web-phase-5`. Type every gig, studio gig, profile gigs, conversations and messages route on the untyped allowlist (18 operations, `GET /v1/conversations/stream` documented as `text/event-stream` with event names `message`, `expired`, `revoked`); validate live responses in e2e as in Phase 2; lower the ceiling. Confirm the stream's auth against the spec (bearer header, ends on token expiry or session revoke) with an e2e test that reads the stream with fetch. Affected specs, typecheck, lint, `openapi:check-responses`. Commit `feat: typed responses for gigs and messaging`. Web: `pnpm api:generate`.

### Task 2: Gig catalog and detail

`src/features/gigs/*`, `src/app/(public)/gigs/{page.tsx,[slug]/page.tsx}`, profile Gigs tab, reel gig link cards. Tests: filters map to query params and back; cursor paging without duplicates; packages render API price strings; payment notice shown; plain-text description; OG, canonical and JSON-LD; real 404 for missing, hidden or removed; "Message seller" asks signed-out visitors to sign in and returns them to the gig.

### Task 3: Studio gigs

`src/app/studio/gigs/*`, `src/features/studio-gigs/*`, Studio home lists gigs. Tests: create draft; details autosave saved/error; packages editor enforces one per tier with BASIC, shows `GIG_PRICE_INVALID` with the API's min/max; gallery and cover use `UploadField`, only READY assets attach; FAQ add/reorder/delete; activate shows `GIG_NOT_PUBLISHABLE` reasons; plan limit shown at `max_active_gigs`; pause; `GIG_STATE_INVALID` shows message and reloads; hidden/removed shows reason read-only; delete confirm.

### Task 4: Messaging

`src/features/messaging/{stream.ts,use-message-stream.ts,store.ts,conversation-list.tsx,thread.tsx,composer.tsx}`, `src/app/(member)/messages/*`, shell badge. Produces `openMessageStream({ getToken, onEvent, signal })` returning a closer, and `useMessages(conversationId)`. Tests (mock fetch stream): parses SSE frames split across chunks; heartbeat comments ignored; `expired` → refresh then reconnect; network drop → backoff and polling with `after=` then back to stream; dedupe by id across stream/poll/send; send keeps text on failure with Retry and no duplicate on retry; 429 and `MESSAGING_NOT_ALLOWED` texts; 4,000-char counter; read marks on view; unread badge updates from stream and on focus; one stream per tab, closed on sign-out and unmount; archive/unarchive; report sends once; block hides thread. Start flows from gig and profile.

### Task 5: Notification preferences and links

`/settings/notifications` per decision 6; notification items for messages and gigs link to the right page. Tests: toggles save with saved/error state; unknown preference keys from the API render generically; message notification opens the thread.

### Task 6: End-to-end and full suite

Flows at both sizes: creator builds a gig with packages, gallery and FAQs, activates it; visitor finds it in `/gigs` and opens detail; signs in from "Message seller", sends a message; seller sees it live and replies; buyer sees reply live; stream cut (server restart or token expiry) then catch-up without duplicates; blocked buyer gets the neutral message; plan limit at max active gigs; notification preferences saved; gig hidden by admin returns 404. All earlier flows pass. Backend full suite once, then `pnpm e2e` three times; all green.

## Exit check

- [ ] A creator publishes a gig; a visitor finds it, messages the seller and gets a live reply.
- [ ] Messaging survives stream drops without lost or duplicated messages.
