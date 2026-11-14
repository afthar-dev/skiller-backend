# Final review: web Phase 7 (cutover)

Scope: `backend.diff` (skiller-backend `web-phase-7` vs `main`), `web.diff` (skiller-web `phase-7-cutover` vs `main`), plan Decisions and Review Focus, task reports 1, 3-5, 2-6, 7. Read-only review. Spot checks in both repos (Prisma schema, GigVisibility/ReelVisibility, ProfilesService, RateLimitGuard, SignedCursor, publicFetch, refresh-cookie options, admin campaign preview iframe, e2e fake checkout).

## Summary

Solid, well-tested phase. The nonce CSP is built right: per-request nonce from `crypto.randomUUID()` (122 random bits), `'strict-dynamic'`, no `'unsafe-inline'` / `'unsafe-eval'` for scripts outside `next dev`, header name switches with `CSP_MODE`, and invalid values fail closed (enforce). Robots and noindex fail closed in every edge case I tried (port, `www`, trailing dot, missing env, alias host). The sitemap feed restates every module's public rule in SQL, the cursor is HMAC-signed per kind, and the SSR-secret bypass only applies to a trusted server call with no visitor IP, which is exactly how the sitemap calls it. JSON-LD escaping of `<` is correct for a data block. Redirects cannot become open redirects (every destination is a fixed same-origin path; `next` is sanitised by the existing `safe-next`). Test coverage is strong: unit tests per helper, a backend e2e per kind with OpenAPI checks, and the e2e suite ran 3 times with a CSP-violation fixture.

No Critical findings. Four Important ones, mostly about what the tests do not prove yet.

## Critical

None.

## Important

### I1. The real Razorpay checkout script has never run under the enforced policy
- Where: `skiller-web/src/lib/security/csp.ts:23-25` (Razorpay host lists), `skiller-web/e2e/support/fake-checkout.ts:44` (`page.route("https://checkout.razorpay.com/v1/checkout.js", ... fulfill(SCRIPT))`), `skiller-web/src/lib/security/settings.ts:7` (production defaults to enforce).
- Failure scenario: the e2e "Razorpay checkout passes with CSP enforced" claim covers the fake script only. The real `checkout.js` runs in the parent page and, depending on its version, pulls images, styles or extra calls from Razorpay hosts not listed (for example `cdn.razorpay.com` for images, other `*.razorpay.com` telemetry hosts). With production defaulting to `enforce`, the first real payment on go-live can fail or render without its overlay, and the only signal is a Sentry CSP report.
- Suggested fix: before cutover, run staging with Razorpay test keys and the real script in `report-only`, then `enforce`, and record the result in the runbook (section 3/9 already mention it; make it a hard go-live gate, not a checklist line). Consider allowing `https://*.razorpay.com` in `img-src` and `connect-src` (scripts stay pinned by nonce + `'strict-dynamic'`), which matches Razorpay's own CSP guidance more closely. Optionally ship the first production deploy with `CSP_MODE=report-only` for a day.

### I2. The legal build gate and the runtime parser disagree, so a green production build can serve 500s on the legal pages
- Where: `skiller-web/scripts/check-legal-final.mjs:10` (only fails on a front matter line that is exactly `status: draft`), versus `skiller-web/src/lib/legal/parse.ts` `parseLegal` (throws on no front matter or any status other than `draft` / `final`).
- Failure scenario: the lawyer's text is saved on Windows with a UTF-8 BOM, or written as `status: "final"` / `status: Final`, or the front matter is missing. The script's regex (`^---`) does not match, so it finds no draft and the build passes. At runtime `parseLegal` throws: `/legal/terms` (and the others) return 500, and `/sitemap/pages-0.xml` (which loads every legal doc) also returns 500. These are legally required pages, and the failure appears only after go-live.
- Suggested fix: make the script use the same rules as the parser (move `parseLegal` into a shared `.mjs`, or duplicate it exactly). Fail the production build unless every file parses and has `status === "final"`, and strip a leading BOM in both places. Add tests for BOM, a quoted status and a missing front matter.

### I3. Sentry transactions skip the scrubber
- Where: `skiller-web/src/lib/observability/options.ts:17-18`. Only `beforeSend` and `beforeBreadcrumb` are set; `tracesSampleRate` is 0.1 in production.
- Failure scenario: transaction events do not pass through `beforeSend`. Browser pageload and navigation transactions carry the full page URL with its query string, and span data includes outgoing request URLs. Server transactions carry request data (URL, query string, headers). Nothing sensitive goes into URLs today (the refresh cookie is path-scoped to `/v1/auth` on the API, and email is not put in the URL), but the guarantee in the plan, the runbook (section 4) and the draft privacy copy ("Error reports have emails, tokens and cookies removed") does not hold for 10% of traffic. The first URL that carries a token or an email will leak it.
- Suggested fix: add `beforeSendTransaction: (e) => scrubEvent(e)`, and `beforeSendSpan` scrubbing `url` / `http.url` / `http.query` attributes, to `sentryOptions`. Extend `options.test.ts` with a recorded transaction.

### I4. Published courses of suspended owners are listed in the sitemap, which contradicts Review Focus 2
- Where: `skiller-backend/src/modules/public-sitemap/public-sitemap.service.ts:175-179` (courses) and `:203-208` (categories count the same courses). Task 1 report, "Gaps to know about".
- Failure scenario: a creator is suspended for abuse. Gigs, reels and the profile disappear, but their published courses stay in `courses-N.xml` and keep their category in `categories-N.xml`. Search engines are told to index the content of a suspended account. The plan's expected outcome was "hidden, removed, draft, unpublished or suspended-owner items: never listed". The sitemap is consistent with the public course page, which has the same gap, so this is a product decision, not a sitemap bug.
- Suggested fix: decide the rule. If suspended owners' courses should go dark (consistent with gigs and reels), fix it in the course public reads (CatalogService, CoursesService.publicPage) and then add `JOIN users u ON c."ownerType"='USER' AND u.id=c."ownerId" AND u.status='ACTIVE'` (plus the ORG equivalent if organizations can be suspended) to the courses and categories queries, with an e2e case. If they should stay, write that down in the plan and the spec comment so Review Focus 2 reflects reality.

## Minor

### M1. The scrubber's secret-key list misses the real SSR header names, and deep values pass through unscrubbed
- Where: `skiller-web/src/lib/observability/scrub.ts:14` lists `x-ssr-secret`, but the web actually sends `x-skiller-server` (the shared secret) and `x-skiller-client-ip` (`skiller-web/src/lib/api/server.ts:28-29`). Also `scrub.ts:59` returns the raw value when `depth > 8`.
- Scenario: any future capture of outgoing request headers (an integration option, a custom `extra`) would send `SSR_SHARED_SECRET` verbatim. The secret is not an email or a JWT, so the text rules will not catch it. A deeply nested `extra` value (more than 8 levels) is sent unscrubbed.
- Fix: add `x-skiller-server` and `x-skiller-client-ip` to `SECRET_KEY`. Return `REDACTED` (or drop the value) instead of the raw value when the depth limit is hit.

### M2. The runbook says previews and staging default to report-only, but they enforce. HSTS is not "production only" either
- Where: `skiller-web/docs/deploy.md:35`; `skiller-web/src/lib/security/settings.ts:7` and `skiller-web/next.config.ts:30` both key on `NODE_ENV === "production"`, which is true for every Vercel build (production, preview, staging).
- Scenario: the owner expects staging to only report, but it blocks. Every preview and staging host also sends `Strict-Transport-Security: max-age=63072000; includeSubDomains` (harmless on `*.vercel.app`, but a 2-year pin on `staging.<domain>` and its subdomains). On the production apex, `includeSubDomains` pins every subdomain (email tracking hosts, an old-app subdomain) for 2 years.
- Fix: correct the doc table (default is enforce on any Vercel build), or key both on `VERCEL_ENV`. Add a go-live checklist line: "every subdomain of the site's domain serves HTTPS before HSTS includeSubDomains goes out".

### M3. Preview and staging image and static responses carry no `X-Robots-Tag`
- Where: `skiller-web/src/proxy.ts:38`. The matcher skips `_next/static`, `_next/image`, `favicon.ico` and prefetch requests.
- Scenario: the preview HTML is noindex and robots.txt disallows everything, but an optimized image URL on a staging host linked from elsewhere can still be picked up by image search (robots.txt blocks crawling, but a URL can still be indexed without content).
- Fix: on non-production deployments, add `X-Robots-Tag: noindex, nofollow` for `/:path*` from `next.config.ts` `headers()` (keyed on `VERCEL_ENV !== "production"`), or widen the proxy matcher for that header only.

### M4. Public source maps are not verified, and a half-configured Sentry upload fails silently
- Where: `skiller-web/next.config.ts:45` (`silent: true`); `skiller-web/src/env.ts` does not require `SENTRY_ORG` / `SENTRY_PROJECT` when `SENTRY_AUTH_TOKEN` is set.
- Scenario: the token is set but the org or project is missing or wrong. The upload fails quietly, and under a Turbopack build the after-compile delete step may not run, so `/_next/static/**/*.map` ships publicly. This is untested (Task 3-5 concerns).
- Fix: in `validateEnv`, require `SENTRY_ORG` and `SENTRY_PROJECT` when the token is set. Use `silent: false` on CI and production. Add a smoke check that a `.map` URL from the landing page's chunks returns 404.

### M5. `SITEMAP_CACHE_SECONDS` is unvalidated, and setting it to 0 in production makes the sitemap an unthrottled API amplifier
- Where: `skiller-web/src/lib/seo/sitemap.ts:19-23`.
- Scenario: someone sets `SITEMAP_CACHE_SECONDS=0` on production while debugging. Each anonymous request to `/sitemap/courses-<n>.xml` (any unique `n` bypasses the CDN cache) then walks every API page uncached. The SSR secret with no visitor IP also lifts the API rate limit (`rate-limit.guard.ts` `isPublicRead` path).
- Fix: ignore the variable when `VERCEL_ENV=production` (or floor it at, say, 300), and add it to `env.ts`.

### M6. The CI e2e and Lighthouse jobs check out backend `web-phase-1`, which has no sitemap route
- Where: `skiller-web/.github/workflows/ci.yml:40` and `:83`.
- Scenario: once `E2E_ENABLED=true`, `e2e/seo.spec.ts` (sitemap test) fails, and so does `pnpm lhci` if anything there depends on the feed. The jobs are dormant today, so nothing fails yet.
- Fix: point both jobs at backend `main` (after the backend merge) or at a repository variable.

### M7. Sitemap lists, and profile pages index, names derived from email addresses
- Where: `skiller-backend/src/modules/public-sitemap/public-sitemap.service.ts:195-199`; `skiller-web/src/app/(public)/u/[handle]/page.tsx:14`.
- Scenario: a creator who never changed the default display name (the email local part, which `ProfilesService.isDefaultDisplayName` says must not be shown publicly) but has a published reel is listed. Their page title `john.smith1987 (@handle)` is then submitted to search engines. The page was already public, so this is not new exposure, but the sitemap actively promotes it.
- Fix (product call): `noindex` on profile pages whose display name is still the default, and drop the display-name escape hatch from the sitemap rule, or keep the reel/gig/course OR-branches only when the name was changed.

### M8. Old-app redirect edge cases
- Where: `skiller-web/src/lib/redirects.ts`.
- Scenario: `/login/` (trailing slash) takes two hops (Next's slash redirect, then the 308). A bare `/reset-password` or `/verify-email` (no token segment), or a query-token variant `/reset-password?token=...`, either returns 404 or forwards the token in the query string to `/sign-in`, where it shows up in logs and Sentry URLs (see I3).
- Fix: add `/reset-password` and `/verify-email` without a segment, and add `has`-free rows that drop the query for the token routes (for example a destination with `?` emptied, or handle them in the proxy). Test the trailing-slash case.

### M9. Blind spots in the e2e CSP fixture
- Where: `skiller-web/e2e/support/csp.ts:37-47`.
- Scenario: the listener sits on `document`. Violations raised inside workers (the hls.js blob worker) and `frame-ancestors` violations (reported to the framed document) are never seen. Together with I1, "zero violations" overstates the coverage.
- Fix: note the limits in the fixture comment. For workers, also assert on console messages matching `Content Security Policy` via `page.on("console")`.

### M10. Rotating the cursor secret makes the sitemap return 500 for up to an hour
- Where: `skiller-backend/src/modules/public-sitemap/public-sitemap.module.ts:11` (SignedCursor keyed on `jwtSecret`); `skiller-web/src/lib/seo/sitemap.ts:277-283`.
- Scenario: after a `JWT_SECRET` rotation, the cached page 0 holds a cursor the API now rejects with 400. `sitemapEntries` throws, and every sitemap piece after the first returns 500 until the cache expires. Crawlers retry, so the impact is low.
- Fix: on a `BAD_CURSOR` from the feed, retry once with `revalidate: 0` from page 0, or `revalidateTag` the sitemap fetches.

### M11. Nits
- `skiller-web/src/env.ts:34`: `SERVER_ONLY` could also list `GRIEVANCE_OFFICER_*`, `ALLOW_DRAFT_LEGAL` and `SITEMAP_CACHE_SECONDS`. These are not secrets, but having them listed documents intent.
- The backend profile rule mirrors `defaultDisplayName` with `BTRIM` / `LEFT` against JS `trim()` / `slice(0, 80)` (whitespace class and UTF-16 code units versus characters). There is no practical drift for real emails; a comment would help the next reader.
- `validateEnv` "at start" does not run on Vercel (the config is evaluated at build only). It is fine because Vercel uses the same env for both, but the runbook claim "the build and the start both check them" is only true off Vercel.

## Checked and fine
- Nonce strength and freshness, nonce on the request CSP header (Next stamps its scripts), the theme script nonce, the Razorpay loader nonce, and `z.config({ jitless: true })` instead of loosening `script-src`.
- `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, COOP `same-origin-allow-popups` (Razorpay popup), and a Permissions-Policy that does not break anything (no camera, microphone or geolocation use in `src`). The admin preview iframe is a sandboxed `srcdoc` with its own policy.
- `isIndexableHost`: case-insensitive, port and `www` mismatches fail closed, and an invalid site URL fails closed. robots.txt and `X-Robots-Tag` share one function.
- Sitemap visibility per kind matches GigVisibility, ReelVisibility and ProfilesService.getByHandle. `DELETED` and `SUSPENDED` users are excluded through `status = 'ACTIVE'` joins. The cursor is HMAC-SHA256 per `sitemap:<kind>`, tamper and cross-kind checks are tested, an unknown kind returns 404, and page numbers past the end return an empty urlset without walking forever. An API failure throws (no empty sitemap is cached) and does not set the `s-maxage` response.
- Redirects: all 308, one hop (unit test checks no destination is a source), no open redirect (fixed destinations; `next` goes through `safe-next`).
- Legal drafts: always `noindex`, always out of the sitemap, and production builds stop while any file is draft unless `ALLOW_DRAFT_LEGAL=1` (subject to I2).
- Env: required production values are named on failure, a `NEXT_PUBLIC_*` secret name fails, and dev and test only need the two URLs.
- JSON-LD: `<` escaped (`<`) in the shared helper and the pre-existing course, gig and profile builders. Tests include a `</script>` payload.
- Backend test-isolation fixes (admin audit row filter, activity-tracker year range) are correct and narrowly scoped.

## Verdict

**Ready to merge after fixes.** Fix I2 and I3 (small, mechanical) before merging. I1 and I4 need owner action or decisions: I1 is a go-live gate on staging with the real Razorpay script, and I4 is the suspended-owner rule. Neither blocks the merge if they are recorded as go-live blockers in `docs/deploy.md`. The Minor items can follow.
