# Fix wave report: web Phase 7 (cutover)

Branches: web `phase-7-cutover`, backend `web-phase-7`. Nothing pushed, merged or deployed. Commits end with the Co-Authored-By line asked for.

## Findings

| Finding | Status | Commit (web unless noted) | Notes |
| --- | --- | --- | --- |
| I1 CSP vs real Razorpay checkout | Fixed in code; real-script run deferred to owner | dc4da74 (CSP), 0bc4b64 (runbook) | `https://*.razorpay.com` added to `img-src`, `connect-src`, `frame-src`; `script-src` stays nonce + `'strict-dynamic'` (no wildcard). Unit test added. `docs/deploy.md` section 12 is a HARD go-live gate (staging, Razorpay test keys, real checkout.js, report-only first, then enforce), repeated in the go-live checklist. The real script cannot be run here, so this stays an owner gate. |
| I2 legal gate vs parser | Fixed | 339196a, 25b38de, be70e4b | Shared reader `src/lib/legal/front-matter.mjs` used by `parseLegal` and `scripts/check-legal-final.mjs`. Strips BOM, requires front matter, requires `status` exactly `draft`/`final`. The gate now also fails on any unreadable file or a missing one of the four documents, even with `ALLOW_DRAFT_LEGAL=1`. Tests: BOM (final passes, draft still caught), quoted/capitalised/unknown status, no front matter, bad date, missing file, parse tests. |
| I3 Sentry transactions skip scrubber | Fixed | 42959d8 | `beforeSendTransaction` (same `scrubEvent`; also scrubs transaction name and `spans`) and `beforeSendSpan` (`scrubSpan`) added. URL-ish keys (`url`, `http.url`, `http.query`, `url.full`...) in nested data now go through `scrubUrl`, so secret query values go, not only emails. Tests with a recorded transaction and span. |
| I4 suspended owners' courses | Deferred to owner (no code change) | 0bc4b64 | `docs/deploy.md` section 13, decision 1, with both options. |
| M1 scrubber header names, depth | Fixed | 42959d8 | `x-skiller-server` and `x-skiller-client-ip` redacted; past depth 8 the value is replaced with `[Filtered]` instead of passed through. |
| M2 runbook vs CSP mode; HSTS | Fixed | 2b7766b, 0bc4b64 | HSTS now keyed on `VERCEL_ENV=production` (via `isProductionDeployment`), so previews/staging send none. Runbook table corrected: every Vercel build enforces unless `CSP_MODE=report-only`. Checklist line added: all subdomains HTTPS before `includeSubDomains`. |
| M3 X-Robots-Tag on assets | Fixed | 2b7766b | `nonProductionAssetRules` in `next.config.ts` headers: `/_next/:path*` and `/favicon.ico` get `noindex, nofollow` on non-production deployments. Unit test. |
| M4 Sentry upload / source maps | Fixed | fd5b434 | `validateEnv` requires `SENTRY_ORG` and `SENTRY_PROJECT` when the token is set. `silent` is off on CI and production (the plugin already throws on upload failure; no `errorHandler`). New `@smoke` check that a `.map` of the landing page's scripts is 404. Runbook updated. The smoke check was not run against a deployed site. |
| M5 SITEMAP_CACHE_SECONDS | Fixed | fd5b434 | `src/lib/seo/cache-seconds.ts`: invalid values ignored; on the production deployment anything under 300 is ignored at runtime and refused by `validateEnv`. Added to env schema, runbook and tests. |
| M6 CI backend ref | Fixed | a855222 | Both jobs check out `${{ vars.BACKEND_REF \|\| 'main' }}` (merge the backend first). |
| M7 names derived from e-mail in sitemap/profile titles | Deferred to owner (product call) | 0bc4b64 | `docs/deploy.md` section 13, decision 2. |
| M8 redirect edge cases | Fixed, except one sub-item skipped | a855222 | Bare `/reset-password` and `/verify-email`, path-token and `?token=` forms now answered by the proxy: one 308 to `/sign-in` with the query dropped (a config redirect always forwards the query). Moved out of the config table; unit, proxy and e2e tests. **Skipped:** trailing slash in one hop. Next's built-in slash redirect runs before custom redirects and the proxy; removing it needs `skipTrailingSlashRedirect` plus slash handling for every route, which is more risk than value. Two permanent same-site hops remain; documented in the runbook. |
| M9 e2e CSP fixture blind spots | Fixed | 0bc4b64 | Fixture also records console errors that mention a Content Security Policy (how worker violations surface); limits (frame-ancestors, cross-origin popups, fake Razorpay script) written in the fixture comment. |
| M10 cursor secret rotation | Fixed | 30ff307 | On `400 BAD_CURSOR` the sitemap walk restarts once from page 0 with `revalidate: 0`. Tests for entries, ids, and for the failures that must still throw. |
| M11 nits | Fixed | 42959d8/fd5b434 (web), 9ddcb6b (backend) | `SERVER_ONLY` now lists the GRIEVANCE_*, ALLOW_DRAFT_LEGAL, SITEMAP_CACHE_SECONDS, SENTRY_ORG/PROJECT names (with test). Comment added on the SQL vs JS default display name rule (backend). Runbook "build and start both check" corrected for Vercel. |

## Verification

- Web typecheck, lint: green. Unit (vitest): 152 files, 1235 tests, green. `pnpm build`: green. `pnpm api:check`: matches.
- Full `pnpm e2e` once at the end (`E2E_BUILD_BACKEND=1 E2E_PG_PORT=55610`, ffmpeg at D:\tools\ffmpeg\bin): 214 passed, 0 failed (5.2 min; was 212, plus the new redirect test at two sizes). Log: `fix-wave-e2e.log` in this folder. This also rebuilt the backend and exercised the sitemap SQL (comment-only backend change), so no separate backend spec run was made.
- Not run: `pnpm smoke` (needs a deployed site; the new source-map check is untested against a real deployment), `pnpm lhci`.
- The e2e runner tore its stack down. No containers or node processes left. Only untracked `graphify-out/` remains in both repos (not committed).

## For the owner

- Run the Razorpay gate (runbook section 12) on staging before the DNS switch.
- Decide the two items in runbook section 13 (suspended owners' courses; e-mail-derived profile names).
- Merge the backend before enabling the CI e2e/Lighthouse jobs, or set the repository variable `BACKEND_REF`.
- `.next-e2e`, `test-results` and `graphify-out` are not committed.
