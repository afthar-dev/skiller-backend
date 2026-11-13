# Web Phase 7 — Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `skiller-web` is ready to replace the old app in production: search engines can find and read every public page, legal pages exist, a strict CSP and security headers are on, errors reach Sentry with secrets scrubbed, landing and course detail meet the Lighthouse budget, old URLs redirect, and a written runbook takes the owner from accounts to live.

**Architecture:** Next.js metadata routes (`src/app/sitemap.ts`, `src/app/robots.ts`) fed by one new public backend route; legal pages rendered from Markdown files in the repo; CSP with a per-request nonce set in `src/proxy.ts` (Next 16's middleware) plus static security headers in `next.config.ts`; `@sentry/nextjs` behind an env switch; Lighthouse CI in GitHub Actions; deployment described in `docs/deploy.md`, not performed by helpers.

**Tech Stack:** As Phase 6, plus `@sentry/nextjs` and `@lhci/cli` (dev). No other new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-skiller-web-frontend-design.md` (sections 5, 7 deployment constraint, 8 Performance and Security, 9 Public, 12 phase 7, 13). Earlier web ledgers bind.

## Global Constraints

- Web branch `phase-7-cutover`; backend branch `web-phase-7`, both from `main`.
- Full backend suite once per phase before merge; affected specs between tasks.
- Helpers never deploy, create accounts, buy domains, touch DNS, or enter keys. Anything needing the owner's accounts goes into `docs/deploy.md` as an owner step.
- Public pages stay server-rendered with public data only; they never read the session on the server.
- Only the Razorpay key id reaches the browser. No secret in any `NEXT_PUBLIC_*` value; the build fails if a server-only env name is prefixed `NEXT_PUBLIC_`.
- CSP allows exactly: self, the API origin, Razorpay checkout hosts, the media/CDN hosts from env, Sentry ingest from env. No `unsafe-eval`; no `unsafe-inline` for scripts.
- Sentry scrubs: `Authorization` headers, `skiller_rt` cookie, access tokens, OTP codes, email addresses in URLs and bodies, and the `code` field of `/v1/auth/*` requests.
- Lighthouse mobile performance 85 or better on landing and course detail (spec section 8).
- Non-production hosts (preview, staging, localhost) send `noindex` and a `robots.txt` that disallows everything.
- Every data view uses page states; AA contrast; keyboard reachable; 375 px first.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions taken for this plan (change any you disagree with)

1. **Sitemap source:** new backend route `GET /v1/public/sitemap/{kind}` (`courses`, `gigs`, `profiles`, `categories`, `hashtags`) returning `{ items: [{ slug, updatedAt }], nextCursor }`, 1,000 per page, only items that are public right now. The web splits sitemaps with `generateSitemaps` (one per kind per 1,000-item page) and revalidates every hour. Reels are left out (no indexable reel page).
2. **Legal pages:** `/legal/terms`, `/legal/privacy`, `/legal/refunds`, `/legal/grievance` (grievance officer contact, required for Indian intermediaries). Copy lives in `content/legal/*.md` with front matter `title`, `updated`, `status: draft | final`. Draft pages show a "Draft, not yet reviewed" banner and are `noindex`. Placeholder copy is written by the helper and marked draft; the lawyer's copy replaces it later. A production build check fails while any legal file is `draft` (override with `ALLOW_DRAFT_LEGAL=1` for staging).
3. **Footer:** public and member shells get a footer with the four legal links and the copyright line. The checkout sheet links Terms and Refunds next to the pay button.
4. **CSP:** nonce-based, set per request in `src/proxy.ts`, `'strict-dynamic'`, `frame-ancestors 'none'`. Mode from env `CSP_MODE=enforce | report-only` (default enforce in production, report-only elsewhere). Violations report to Sentry's CSP endpoint when a DSN is set.
5. **Other headers (all routes):** HSTS 2 years with `includeSubDomains` (production only), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` with camera, microphone and geolocation off, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (Razorpay opens a popup).
6. **Sentry:** client, server and edge; on only when `NEXT_PUBLIC_SENTRY_DSN` is set; 10% traces in production, 0 elsewhere; no session replay; source maps uploaded only when `SENTRY_AUTH_TOKEN` is set (owner step). Error boundaries report with the API `requestId` as a tag.
7. **Lighthouse:** `@lhci/cli` in CI against a production build with the e2e backend, mobile preset, on `/` and one seeded course detail; asserts performance ≥ 85, accessibility ≥ 95, SEO ≥ 95, best practices ≥ 90.
8. **Old app:** permanent redirects for its addresses (table in Task 6); the `/soon` placeholder page is deleted and every link that still points at it is removed or pointed at the real page. Old repo archiving, DNS switch and old deployment shutdown are owner steps in the runbook.
9. **Env validation:** `src/env.ts` (zod) validates server and public env at build and start; missing required production values fail the build with the variable's name.

## Review Focus

1. **CSP breaks a real flow:** Razorpay checkout, HLS video from the media host, image uploads to the storage host, the messaging stream, step-up dialog. Expected: every e2e flow runs with CSP enforced and zero `securitypolicyviolation` events. Test in Task 3 (listener in the e2e fixture) and Task 7.
2. **Sitemap leaks or misses content:** hidden, removed, draft, unpublished or suspended-owner items. Expected: never listed; published items listed with `updatedAt`. Test in Task 1 (backend spec per kind) and Task 2.
3. **Preview or staging indexed:** Expected: `noindex` header/meta and disallow-all `robots.txt` on any host that is not `NEXT_PUBLIC_SITE_URL` in production. Test in Task 2.
4. **Sentry captures secrets:** an error thrown during OTP verify or a 401 refresh. Expected: event contains no token, code, cookie or email. Test in Task 4 (unit test on `beforeSend` / `beforeBreadcrumb` with a recorded event).
5. **Old link lands on a 404 or a loop:** Expected: every row of the redirect table resolves in one hop to a 200 page (or sign-in). Test in Task 6.

---

### Task 1: Backend sitemap feed

Backend `web-phase-7`. `src/modules/public-sitemap/` (controller, service, DTOs) with `GET /v1/public/sitemap/:kind?cursor=` per decision 1, public, rate limited as other public reads (SSR shared secret lifts the limit), typed response schema, signed cursor as other lists. Visibility rules reuse each module's existing "is public" query (published course, active gig, non-suspended profile with at least one public item or a complete profile per the profile module's rule, category with at least one published course, hashtag with at least one public reel). Tests: one e2e spec per kind asserting hidden, removed, draft and suspended-owner items are absent and a published one is present with `updatedAt`; cursor paging without duplicates; unknown kind gives 404. Typecheck, lint, `openapi:check-responses` (ceiling stays 14). Commit `feat: public sitemap feed`. Web: `pnpm api:generate`.

### Task 2: SEO pass

Web `phase-7-cutover`. `src/app/sitemap.ts` (`generateSitemaps` + per-kind pages, `revalidate = 3600`), `src/app/robots.ts`, `src/lib/seo/{site.ts,is-indexable-host.ts}`, default OG image `src/app/opengraph-image.tsx`, `src/app/manifest.ts`. Audit every public route (landing, courses, course detail, lesson preview, categories, gigs, gig detail, profile, followers/following, hashtags, certificates, legal): unique title and description, canonical, OG and Twitter tags, JSON-LD present where it applies (`Course`, `Service`, `ProfilePage`, `BreadcrumbList`, `Organization` on landing); followers/following pages and search pages `noindex, follow`; the 404 page `noindex`. Robots disallows `/admin`, `/studio`, `/settings`, `/messages`, `/learn`, `/learning`, `/checkout`, `/notifications`, `/onboarding`, `/sign-in`. Tests: robots for production vs preview host; sitemap index lists one entry per kind page; sitemap entries use canonical absolute URLs; unit test per public page's `generateMetadata` (title, canonical, robots); JSON-LD parses as JSON and has the required fields; non-production host gets `noindex`. Commit `feat: sitemap, robots and metadata pass`.

### Task 3: Security headers, CSP and env validation

`src/proxy.ts` (nonce, CSP per decision 4), `src/lib/security/csp.ts` (`buildCsp({ nonce, apiOrigin, mediaOrigins, sentryIngest, mode }): { header: string; value: string }`), headers per decision 5 in `next.config.ts`, `src/env.ts` per decision 9, root layout passes the nonce to scripts that need it (Razorpay loader, JSON-LD). e2e fixture in `e2e/support/csp.ts` that fails a test on any `securitypolicyviolation` event, applied to all specs. Tests: `buildCsp` unit tests (no `unsafe-eval`, script-src has nonce + `strict-dynamic`, origins from env only, report-only header name in report-only mode); header presence on a public page, an admin page and an API-less 404; env validation names the missing variable; a `NEXT_PUBLIC_` secret name fails. Commit `feat: csp, security headers and env validation`.

### Task 4: Sentry

`@sentry/nextjs` with `instrumentation.ts`, `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts` per decision 6; `src/lib/observability/scrub.ts` (`scrubEvent(event): event | null`, `scrubBreadcrumb(crumb): crumb | null`) used by every config; `app/error.tsx` and `global-error.tsx` report with `requestId` tag; CSP report URI wired when DSN set. Tests: scrub removes Authorization, cookies, `accessToken`, OTP `code`, emails in URL query and body, and keeps `requestId`; Sentry init skipped when DSN empty (no network in e2e); build passes with no auth token. Commit `feat: sentry with scrubbing`.

### Task 5: Legal pages and footer

`content/legal/{terms,privacy,refunds,grievance}.md` (draft placeholder copy, plain and short, naming Skiller, the email OTP sign-in, Razorpay, GST invoices, the refund rules the API enforces as stated in the backend refund module, and a grievance officer name/email from env `GRIEVANCE_OFFICER_NAME`, `GRIEVANCE_OFFICER_EMAIL`), `src/app/(public)/legal/[doc]/page.tsx` (static params, Markdown via the existing renderer with raw HTML off), `src/components/site-footer.tsx` in public and member shells, links in checkout sheet, `scripts/check-legal-final.mjs` run in `build` when `VERCEL_ENV=production` per decision 2. Tests: each page renders title and updated date; draft banner and `noindex` when draft; unknown doc 404; footer links at 375 px; checkout shows Terms and Refunds links; the check script fails on a draft file and passes with `ALLOW_DRAFT_LEGAL=1`. Commit `feat: legal pages and footer`.

### Task 6: Performance budget, old-app redirects and runbook

- Lighthouse per decision 7: `lighthouserc.json`, `pnpm lhci` script, CI job after e2e. Fix whatever keeps landing or course detail below budget (images sized and lazy, fonts preloaded, heavy client bundles split; no change to API behaviour).
- Redirects added to `src/lib/redirects.ts`, all permanent: `/login`, `/register`, `/verify-otp`, `/forgot-password`, `/reset-password/:token`, `/change-password`, `/verify-email/:token` → `/sign-in`; `/dashboard` → `/home`; `/c/:username` → `/u/:username`; `/billing/plans` and `/billing/me` → `/settings/plan`; `/wallet/:path*` and `/withdrawals/:path*` → `/studio/earnings`; `/posts/:path*` and `/feed` → `/reels`. Delete `/soon` and repoint or remove each link to it.
- `docs/deploy.md` in the web repo: Vercel project settings (Node from `.nvmrc`, build command, env list with which are server-only), shared parent domain and `COOKIE_DOMAIN` / `CORS_ORIGINS` values for the API, staging setup, Sentry project and auth token, Razorpay live keys and webhook URLs, DNS switch, old app shutdown and repo archive, rollback (Vercel instant rollback, DNS revert), and a go-live checklist with the owner items from spec section 13 (domain, accounts, live keys, CA and lawyer sign-off, rotate the old `RAZORPAY_KEY_SECRET` if shared).
- `e2e/smoke.spec.ts` tagged `@smoke` that runs against `E2E_BASE_URL` without seeding (landing, course catalog, a course detail, sign-in page, `robots.txt`, `sitemap.xml`, headers present) for the owner to run against staging and production.
Tests: one-hop redirect for every table row (Review Focus 5); no link in `src` points to `/soon`; `lhci` assertions pass locally. Commit `feat: lighthouse budget, old app redirects and deploy runbook`.

### Task 7: End-to-end and full suite

All earlier flows pass with CSP enforced and the violation fixture on (Razorpay checkout, lesson HLS, uploads, messaging stream, step-up, admin campaign preview). New flows at both sizes: `robots.txt` and `sitemap.xml` reachable and list a seeded published course but not a hidden one; a legal page from the footer; an old `/login` link lands on sign-in; security headers present on a public and a member page. axe on legal pages. Backend full suite once, then `pnpm e2e` three times and `pnpm lhci` once; all green.

## Exit check

- [ ] A production build passes with CSP enforced, Sentry configured, final legal copy and the Lighthouse budget.
- [ ] The owner can follow `docs/deploy.md` from accounts to a live site and back out with rollback.
