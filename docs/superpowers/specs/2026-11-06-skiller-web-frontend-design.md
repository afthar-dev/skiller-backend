# Skiller Web Frontend — Design

**Date:** 2026-11-06
**Status:** awaiting review
**Backend:** `D:\skiller\skiller-backend` (`main`, API under `/v1`, contract in `openapi.json`, 204 paths / 248 operations)
**Backend spec:** `docs/superpowers/specs/2026-11-03-skiller-platform-redesign-design.md`

## 1. Intent

Skiller is a mix of Coursera, Fiverr and LinkedIn. The backend has been rebuilt; the old frontend talks to the retired `/api` and has no tests, hides failures as blank screens, and never completed core flows such as course purchase.

**Goal:** a new web app where every MVP flow works end to end on the new API, with a clearly better experience on phones.

**Success means:**

1. A visitor finds a course or gig through Google, signs in with an email code, buys a course, watches it, and earns a certificate.
2. A creator publishes a course, gig and reel with native uploads, sees earnings in the wallet, and requests a payout.
3. A buyer messages a gig seller and gets a live reply.
4. An admin runs moderation, finance, payouts, campaigns and analytics from the app.
5. No screen fails silently: every data view has loading, empty, error and retry states.

## 2. Decisions

| Topic | Decision |
|---|---|
| Old-only features | Dropped: Community, group chat, post Feed, Stories, Leaderboard/XP, CRM, voice messages. Old code stays in git history. Any of them can return later as its own backend and frontend phase. |
| Approach | New Next.js + TypeScript app, not a patch of the old one. |
| Repository | New git repo `D:\skiller\skiller-web`. `skiller-frontend` is frozen and left as it is, including its uncommitted edits, until cutover. |
| Look and feel | Keep the Skiller logo and brand colours. Layouts and navigation redone, mobile-first for member screens. Studio and admin are desktop-first but stay usable on a phone. |
| Language | English only. Copy lives in plain components; no i18n framework. |

## 3. Out of scope

- Organization screens (`/v1/orgs/*`, `/v1/org-invites/*`). Backend stays ready. Institution billing from the old app waits with them.
- Native mobile apps, PWA install, web push.
- Languages other than English.
- Importing old users or content. The old backend has no real users, so nothing is migrated.
- Gig payments and escrow (backend flag `gig_orders` stays off).

## 4. Stack

- Next.js App Router, React, strict TypeScript, pnpm, deployed on Vercel.
- Tailwind CSS and shadcn/ui components; brand values defined as design tokens.
- `openapi-typescript` generates types from the backend's `openapi.json`; `openapi-fetch` is the typed client.
- TanStack Query for all client data; react-hook-form and zod for forms.
- hls.js for video (native HLS on Safari); Razorpay Checkout script for payments.
- Vitest and Testing Library for logic and components; Playwright for flows.

The generated types file is committed. A `pnpm api:check` step regenerates it from the backend contract and fails on any difference, so the app cannot silently drift from the API.

## 5. Rendering

**Server-rendered, indexable, public data only:** landing, course catalog and detail, gig catalog and detail, profiles, hashtag pages, certificate verification. These pages set metadata, canonical URLs and structured data. They never read the user's session on the server; signed-in extras (for example "Continue learning" on a course page) load on the client after the page arrives.

Hidden or removed content returns a real 404 from the server render.

**Client-rendered:** everything signed in, plus the reels feed. Reel view beacons, like state and feed cursors are per-viewer and gain nothing from server rendering.

## 6. Structure

```
src/
  app/
    (public)/     landing, catalogs, details, profiles, hashtags
    (auth)/       sign-in, code entry
    (member)/     learning, player, wallet, messages, reels, settings
    studio/       creator tools
    admin/        platform admin
  features/<area>/  queries, mutations, components, schemas for one area
  lib/api/        client, token handling, error map
  lib/money/      paise formatting
  lib/upload/     multipart upload engine
  components/ui/  shadcn primitives
  components/     shared composites (page states, step-up dialog, video player)
```

Rule: a feature imports `lib`, `components` and its own files. It reaches another feature only through that feature's `index.ts`, enforced with ESLint `no-restricted-imports`, matching the backend's boundary rule. Files stay small and single-purpose.

## 7. Auth and access

- Email OTP only: `POST /v1/auth/otp/request`, then `/otp/verify`. No password, forgot-password or change-password pages exist.
- The access token lives in memory only, never in `localStorage`. On load the app calls `POST /v1/auth/refresh` with credentials to restore the session from the httpOnly `skiller_rt` cookie.
- Refresh is single-flight: parallel 401s wait on one refresh and retry once. A `REFRESH_RACE` response retries the refresh; any other refresh failure signs the user out. Sign-out in one tab reaches others through `BroadcastChannel`.
- **Deployment constraint:** the cookie is `SameSite=Lax` and scoped by `COOKIE_DOMAIN`, so web and API must share a parent domain (for example `skiller.x` and `api.skiller.x`), and the web origin must be in `CORS_ORIGINS`. Preview deployments on `vercel.app` can't hold a session against the production API; they use a staging API on a shared domain or local development.
- Menus follow permissions from `GET /v1/me`. This is presentation only; the backend enforces every rule. A 403 shows a "no access" state and never signs anyone out.
- **Step-up:** one global dialog. An API response with `STEP_UP_REQUIRED` opens it, runs `/v1/auth/step-up/request` and `/verify`, then repeats the original request once with the same `Idempotency-Key`.

## 8. Shared behaviour

**Errors.** The backend returns `{ error: { code, message, details }, requestId }`. One map turns codes into friendly text; unknown codes fall back to a generic message showing `requestId`. `VALIDATION_FAILED` details map onto form fields.

**Page states.** Shared `Loading`, `Empty`, `ErrorState` (with retry) and `NoAccess` components. Review treats a query rendered without them as a defect.

**Money.** Amounts stay decimal strings of paise end to end and are formatted through `lib/money` using `BigInt`. `Number` is never used on money. The app displays amounts; it never calculates fees, GST or commission, which come from the API.

**Idempotency.** `POST /v1/checkout`, `POST /v1/wallet/payouts` and `POST /v1/orders/:id/refund-requests` send an `Idempotency-Key` created once per user attempt, kept across retries, replaced only when the user starts over.

**Uploads.** One engine for `POST /v1/media/uploads`, `/parts` and `/complete`: parallel parts, progress, retry per part, resume after refresh, cancel. After completion the UI shows processing state until `GET /v1/media/:id` reports ready or failed. Uploads survive navigation inside the app.

**Video.** Lesson playback calls `GET /v1/media/:id/playback`, refreshes the token before `expiresAt` and after any 401/403 from the edge gate, without interrupting the position. Reels use public HLS.

**Lists.** Signed cursors are opaque and passed back unchanged, through infinite queries.

**Markdown.** Backend-validated Markdown is rendered with raw HTML disabled.

**Accessibility.** Keyboard reachable controls, visible focus, labelled inputs, AA contrast, captions where provided, reduced-motion respected.

**Performance.** Reels preload one item ahead; images are sized and lazy; heavy editors load only in studio and admin. Budget: Lighthouse mobile performance 85 or better on landing and course detail.

**Security.** No secrets in the app; only the Razorpay key id reaches the browser, and only through the API's checkout response or a public env value. Strict Content-Security-Policy allowing Razorpay, the media hosts and the API. Sentry for errors, with tokens and email codes scrubbed.

## 9. Areas

**Public.** Landing, course catalog with search, filters and category, course detail with free previews, reviews, instructor; gig catalog and detail with the off-platform payment notice; public profile with courses, reels, gigs; hashtag pages; certificate verification; legal pages; unsubscribe confirmation served by the API.

**Member.** Onboarding, profile editing (experience, education, skills, portfolio), follows, notifications and preferences, active sessions, blocks and mutes, saved reels, promo preference, become a creator.

**Learner.** My learning, lesson player with progress and resume, quizzes, certificates, reviews, Q&A.

**Money.** Checkout with coupons and GST breakdown, Razorpay payment then `/v1/checkout/verify`, order history, invoices and credit notes, refund requests, plans and subscription change/cancel, wallet balance and transactions, payout account, payout requests.

**Studio.** Course builder (sections, lessons, quizzes, submit for review), gig manager with packages, gallery, FAQs, reel posting with course or gig link, reel and course analytics, review replies. Plan limits are shown before the user hits them.

**Reels.** Full-screen vertical feed with Following and For you tabs, like, save, share, comments with one reply level, report, block, course and gig link cards, 3-second view beacon.

**Messaging.** Conversation list, thread, unread count, start from gig or profile, report. Live delivery from `GET /v1/conversations/stream` using a fetch-based stream reader, because `EventSource` can't send the bearer token, falling back to polling. The first phase using it confirms the route's auth against this design.

**Admin.** Users and roles, moderation queue, course review, finance summary, orders, refunds, payouts, plans, coupons, categories, campaigns with preview, test send and second-admin approval, analytics dashboards with CSV export, settings, flags, audit log, outbox.

## 10. Backend gaps

The frontend must not work around a missing API. When a phase finds a gap, it is a small separate backend change with a test, an `openapi.json` update and a regenerated type file, committed in the backend repo. Backend rules and rulings stay binding.

**Known gap: response schemas.** 202 of the 248 operations in `openapi.json` declare no response body, so generated types can't describe them. Each phase starts by adding response schemas to the backend routes it uses. A backend check keeps an allowlist of untyped operations that may only shrink; it reaches zero by the end of phase 6, except organization routes.

## 11. Testing

- **Vitest:** money formatting, refresh single-flight, error map, upload engine, step-up retry, cursor handling.
- **Playwright:** each flow in section 1 at phone and desktop sizes, against the real local backend with its fake Razorpay, RazorpayX and mail providers and local Postgres, Redis and MinIO.
- **Accessibility:** axe checks inside Playwright on key pages.
- **Every phase passes:** typecheck, lint, build, `api:check`, unit tests, and that phase's Playwright flows.

## 12. Delivery

Each phase has its own plan and uses Sonnet helpers, with one Opus final review and one fix wave at its end. No per-task reviews.

1. **Foundation:** repo, tokens, app shell, API client, OTP sign-in, step-up, page states, profile, settings.
2. **Courses and learning:** catalogs, detail, checkout, player, quizzes, certificates, reviews, Q&A.
3. **Creator money and studio:** upload engine, course builder, plans, wallet, payouts, invoices, refunds.
4. **Reels:** feed, engagement, comments, posting, hashtags, moderation actions.
5. **Gigs and messaging:** catalog, manager, messaging, notifications.
6. **Admin.**
7. **Cutover:** SEO pass, legal pages, CSP, Sentry, Lighthouse, Vercel production, retire the old app.

Phase 1 uses a mobile and desktop design pass to fix tokens, navigation and shared layouts before later phases build on them.

## 13. Open items for the owner

- Production domain, needed for the shared-parent-domain cookie rule. Needed by phase 7, or earlier for staging.
- `RAZORPAY_KEY_SECRET` sits in `skiller-frontend/.env`. It isn't tracked or bundled, but should be removed from that file. If it was ever shared, rotate it.
- Legal page copy (terms, privacy, refund policy) from the lawyer.
