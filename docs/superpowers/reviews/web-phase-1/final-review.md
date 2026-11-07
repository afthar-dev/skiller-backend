# Final review: Skiller web Phase 1 foundation

Reviewed: `skiller-web` branch `phase-1-foundation` (head 87db1f7), backend `web-phase-1` through `backend-review.diff`, plus the backend code those changes touch (identity, mail, queue, idempotency, profiles).
Method: read all in-scope code and tests and traced each claim through the code, including the installed `openapi-fetch` 0.17 source. I did not run the app or the test suites. Contrast ratios were computed from the tokens in `globals.css`.

## Verdict: merge with fixes

The auth core is sound: token in memory, single-flight refresh, race handling and open-redirect guard all hold up. One listed failure does not pass (suspended profiles stay public), and the client has four gaps that would become costly once money flows sit on it. All are small. Fix the Critical and the Important findings in the one fix wave, then merge.

Counts: **1 Critical, 10 Important, 13 Minor.**

---

## Critical

### C1. Suspended and deleted members' profiles stay public, with status 200 (plan Review Focus 5 fails)

- **Where:** `skiller-backend/src/modules/users/profiles.service.ts:138-142` (`getByHandle`), `profiles.controller.ts:42-43`, `follows.service.ts:70-71` and `:81-82`.
- **What:** `getByHandle` looks up the profile row and never checks the account status. `GET /v1/profiles/:handle` and both follower lists use it. The web page only calls `notFound()` when the API says 404 (`src/lib/api/server.ts:14`), so it renders the profile.
- **Scenario:** an admin suspends a member for abusive content (`admin-users.service.ts:111`; it changes `users.status` and revokes sessions, and leaves the profile alone). `/u/<handle>` still returns 200 with name, headline, about, experience, portfolio, links and JSON-LD, and stays indexable. The same holds for `DELETED` accounts. Follower lists also keep listing these members.
- **Why the review missed it so far:** Task 8's report says "there is no hide mechanism in the app yet", but account status is that mechanism. Reels and gigs already apply it (`ReelVisibility`, `GigVisibility`, README lines 201 and 226). Spec section 5: "Hidden or removed content returns a real 404 from the server render." The only test is an unknown handle.
- **Fix:** small backend change. Add a public lookup (for example `getVisibleByHandle`) that uses `UserStatusCache` and throws `PROFILE_NOT_FOUND` unless the status is `ACTIVE`. Use it in `GET :handle`, `:handle/followers`, `:handle/following`, and filter non-active members out of list rows. Add a backend e2e, and a web e2e: suspend through the admin API, then assert `/u/<handle>` is 404 and the HTML has no profile text.

---

## Important

### I1. A step-up request made with an expired access token never opens the dialog

- **Where:** `src/lib/api/client.ts:52-59`, `:32`.
- **What:** the 401 branch retries with `globalThis.fetch`, which bypasses the middleware, and returns that response directly. If the retry answers 403 `STEP_UP_REQUIRED`, nothing handles it. Each `onResponse` runs once per call (confirmed in `openapi-fetch/dist/index.mjs`).
- **Scenario:** this is the normal case. Access tokens last 15 minutes, step-up lasts 5. A creator leaves the wallet page open for 20 minutes and taps Withdraw. `POST /v1/wallet/payouts` (`wallet.controller.ts:114-117`, both `@Idempotent` and `@RequireStepUp`) gets 401, refreshes, retries, gets 403. The caller receives "Please verify your email code to continue" and no dialog exists to do that. A second tap works, but a screen that builds a new key per tap is then a new attempt.
- **Fix:** make the response handler a small loop: 401 leads to refresh and retry, the result then passes through the step-up check, each branch at most once. Add a unit test: 401, then 403 `STEP_UP_REQUIRED`, then 200, asserting one key across all three sends. No current test covers the combination.

### I2. `unwrap` reports a failed request with an empty body as success

- **Where:** `src/lib/api/errors.ts:50-55`.
- **What:** for a non-2xx response with `Content-Length: 0`, openapi-fetch returns `{ error: undefined, response }`. `unwrap` only checks `error`, so it returns `undefined` as if the call worked.
- **Scenario:** a gateway answers 502 or 503 with an empty body. A mutation resolves, `setSaved(true)` shows "Saved", and in later phases a payout or refund screen shows success. On `/v1/me`, `load` sets `me` to `undefined` with status `signedIn`, and the shell crashes on `me.profile`.
- **Fix:** branch on the response: `if (result.response.status >= 400) throw apiErrorFrom(result.response.status, result.error)`. Use `status` because unit test mocks only set that field. Add a test with `error: undefined, status: 502`.

### I3. Sign-out says it worked when the server session is still alive

- **Where:** `src/features/auth/auth-provider.tsx:113-118`.
- **What:** `api.POST` does not throw on an error status, so the `try/catch` only sees network failure, and the result is ignored in both cases. The refresh cookie is httpOnly, so only the server can clear it.
- **Scenario:** a member signs out on a shared computer while the API returns 503 (`SessionService.markRevokedOrFail` returns exactly this, with "please retry") or the network drops. The app goes home and looks signed out. The session and the 30-day cookie survive, and the next person to open the site is signed in on page load, because `load(true)` restores the session.
- **Fix:** check the response. On anything except 204, or 401 (already dead), retry once, then keep the member signed in and show "We could not sign you out. Check your connection and try again." If the team prefers always ending locally, at least tell the member the device may still be signed in. Record the choice as a ruling.

### I4. Back after losing a session or signing out leaves a permanent "Taking you to sign in" spinner

- **Where:** `src/features/auth/require-auth.tsx:16`, `auth-provider.tsx:22`, `:71`, `:112`.
- **What:** `sessionLost` and `signedOutFrom` are only cleared by a successful `load`. While either is set, `RequireAuth` does nothing, and it renders `Loading` for `signedOut`.
- **Scenario 1:** the session is revoked on `/settings`, the app replaces it with `/sign-in`, the member presses Back to `/home`. `sessionLost` is still true, so no redirect happens: endless spinner until a hard reload. The same happens in a tab signed out through `BroadcastChannel`.
- **Scenario 2:** sign out on `/settings`, land on `/`, press Back. `signedOutFrom === pathname` is true again, same spinner.
- **Tests:** `RequireAuth` has no unit test (Task 4-5 report). The e2e flows use `page.goto`, a hard load, which resets this state.
- **Fix:** clear both flags when the app reaches a different path (for example in an effect on `pathname`, once the redirect target is reached), so `RequireAuth` redirects normally after that. Add a `RequireAuth` test and one Playwright `goBack()` step.

### I5. Expired and locked codes show a generic error and can dead-end (Review Focus 4)

- **Where:** `src/lib/api/errors.ts:57-69`, `src/features/auth/code-form.tsx:51-53`, `src/features/auth/step-up-dialog.tsx:91-95`, `:145-149`.
- **What:** the backend sends `OTP_EXPIRED` (400) and `OTP_LOCKED` (429) (`otp.service.ts:127-129`). Neither is in `MESSAGES`, so the member sees "Something went wrong. Please try again. Reference: ...". Trying again cannot work: the challenge is dead.
- **Scenario:** after five wrong codes, or after 10 minutes, a member keeps retyping on the sign-in page with Resend possibly still cooling down. In the step-up dialog it is worse: "Send code again" only appears when there is no `challengeId`, so the only way out is Cancel, and the protected action fails.
- **Related:** `RATE_LIMITED` says "wait a moment" although `details.retryAfterSec` can be up to 15 minutes. It is ignored.
- **Fix:** add both codes with "request a new code" wording. On either code, end the Resend cooldown in `CodeForm`, and clear `challengeId` in the dialog so its resend button appears. Use `retryAfterSec` in the rate-limit text. Add unit tests with the real codes and statuses.

### I6. Automatic `Idempotency-Key` per call hides a missing per-attempt key on money routes

- **Where:** `src/lib/api/client.ts:39-41`.
- **What:** spec section 8 wants a key "created once per user attempt, kept across retries". The server enforces presence with `IDEMPOTENCY_KEY_REQUIRED` on exactly the four `@Idempotent` routes. The middleware adds a random key to every mutating call, so a screen that forgets the attempt key passes that check.
- **Scenario:** in phase 3 a payout screen calls `api.POST("/v1/wallet/payouts", { body })` with no header. Everything works in tests. The member double-taps, or retries after a timeout whose request actually landed: two different keys, two payouts requested, and the server has no way to know.
- **Fix:** remove the automatic key, or skip it for the `@Idempotent` routes. The backend then fails loudly in development. Add one small helper for per-attempt keys before phase 2. Non-idempotent routes ignore the header, so nothing else changes (`e2e/support/api.ts` sends its own).

### I7. `publicFetch` will hit per-IP rate limits as one client for all visitors

- **Where:** `src/lib/api/server.ts:8-17`; limits at `catalog.controller.ts:34` (120 per minute), `certificates.controller.ts:40` (60), `gigs.controller.ts:26` (300).
- **What:** the Phase 1 profile routes have no limit, so nothing fails today. Phase 2 renders the catalog through this helper with no cache and no client IP, so the API sees every visitor and crawler as a few Vercel egress addresses. A 429 throws `ApiError` and shows the error page.
- **Scenario:** on launch day, a crawl or a modest traffic burst passes 120 catalog renders in a minute and every visitor gets "Something went wrong" until the window clears. This breaks the first success criterion in the spec, finding a course through Google.
- **Fix:** decide this before phase 2 builds on it. Give `publicFetch` a `next: { revalidate, tags }` option, which is safe because it sends no credentials, and let the web server identify itself to the API (a shared-secret header exempt from these limits, or a trusted forwarded client IP). Add a timeout too, because a hung API currently hangs the render.

### I8. Error text fails AA contrast in both themes, and the check cannot see it

- **Where:** `src/app/globals.css:23`, `:47`, `:39`; `e2e/a11y.spec.ts:6`.
- **What:** computed ratios: light `--destructive` on white is 3.78:1, dark `--destructive` on background is 3.28:1, dark `--primary` on background is 4.12:1. AA needs 4.5:1 for this small text. `text-destructive` is used for every form error, and `text-primary` for profile and portfolio links in dark mode.
- **Scenario:** a member with low vision cannot reliably read "That code is not correct", the most important text on the screen. axe passes because `a11y.spec.ts` fixes the scheme to light and only visits resting pages with no error shown.
- **Fix:** darken light destructive for text (the brand red `#B91C1C` gives about 6.4:1), lighten dark destructive, and use a lighter red for dark-mode link text. Keep filled buttons as they are. Run axe in dark mode and on one page with a validation error showing.

### I9. Two e2e flows test nothing they claim

- **Where:** `e2e/settings.spec.ts:40-56`, `:58-65`.
- **What:** "blocked members and muted creators can be undone" creates and disposes contexts, pushes two literals into an array, and asserts the length is 2. It never opens the app and passes with the feature deleted. "the devices list ... can sign out the others" only checks that the button is absent with one device, so sign-out of others is never exercised. These count among the 34 reported passes.
- **Fix:** use `apiMember` to create targets, block and mute through the API, then unblock and unmute in the UI and assert the rows leave and stay gone after reload. Add a second device for "Sign out other devices". Correct the Task 8 count until then.

### I10. The untyped-operations allowlist is not enforced and can grow

- **Where:** `skiller-backend/.github/workflows/ci.yml:82-85`, `scripts/check-openapi-responses.mjs:1-2`, `:14-21`.
- **What:**
  1. CI runs `test:scripts` (the checker's own unit tests) and `openapi:export`, but never `openapi:check-responses`, so an untyped new route merges with no failure.
  2. The header says the list "can only shrink", but adding an entry passes. There is no baseline or cap.
  3. `isTyped` accepts any non-empty schema, so `{ type: "object" }` counts as typed and an untyped route can pass with a placeholder.
  4. The CLI guard at the end compares `import.meta.url` with `argv[1]`. Through a symlinked path `main()` is skipped and the process exits 0 silently.
- **Fix:** add the step to CI. Compare entries with the merge base, or keep a committed maximum count that may only fall. Require `properties`, `items` or `$ref`. Run `main()` unconditionally from a tiny CLI file.

---

## Minor

1. **Suspended account and refresh failures** (`src/lib/api/refresh.ts:41-47`). Refresh returning 403 `AUTH_ACCOUNT_SUSPENDED` is thrown as "server trouble", and the backend has already cleared the cookie. Mid-session, a suspended member stays "signed in" with `NoAccess` or error pages. After any refresh failure on a public page, `status` stays `loading`, so `FollowButton` stays disabled. Treat suspended as session lost with its own message. Not signing out on 5xx is sensible, but spec section 7 says "any other refresh failure signs the user out", so record that as a ruling.
2. **Step-up dialog state** (`step-up-dialog.tsx:150`, `:118`). Cancel calls `finish(false)` directly, and `onOpenChange` does not fire for a controlled close, so the old error and typed digits reappear next time. On session loss the dialog stays open over `/sign-in` and the pending request never settles: call `finish(false)` from `endSession`. The copy says the code is valid for 5 minutes, but codes last 10; 5 minutes is the step-up window.
3. **Broadcast sign-out on public pages** (`auth-provider.tsx:99-101`). A deliberate sign-out in one tab sends another tab reading `/u/x` to sign-in with "You were signed out". On a public page, clearing the session is enough.
4. **Contract check scope** (`scripts/api-generate.mjs:31-42`). Answer to "is it real?": it proves `schema.gen.ts` matches the committed copy and catches hand edits, but cannot see backend drift. That follows the preflight ruling, and the copy matches the backend today (diff is empty). Cheap upgrade: also compare with `OPENAPI_PATH` when the file exists, and do so in the e2e CI job.
5. **Wrong status in the contract and tests.** A wrong sign-in code is `OTP_INVALID` 400, not 401 (`otp.service.ts:109`). `auth.controller.ts:67` documents 401, the Task 1 report repeats it, `client.ts:29` is commented on it, and `client.test.ts:59-67` and `code-form.test.tsx:43` mock it. `auth.controller.ts:120` says exhausted is 400, but `OTP_LOCKED` is 429. Harmless at runtime; correct the docs and mocks.
6. **Blocked viewers.** The plan expects a 404 for a blocked viewer, but spec section 5 forbids reading the session on the server, and the client `GET` does not apply blocks either. A blocked member sees the page, and Follow returns `FOLLOW_BLOCKED`, which maps to the generic message. Settle this as a ruling and add the code to the map.
7. **`FollowButton` hides a failed read** (`follow-button.tsx:21-22`). If the profile query fails, a member who already follows sees "Follow". Page states are required by spec section 8.
8. **Validation errors in list forms** (`edit-list-form.tsx:147-149`, `:253-254`). `VALIDATION_FAILED` shows "check the highlighted fields" with nothing highlighted, for example a URL that passes the client regex but fails the backend's `.url()`. `onboarding-form.tsx:53-57` returns silently when only other fields failed.
9. **Unsaved edits vanish on tab change** (`settings/profile/page.tsx:30-46`). Radix unmounts inactive tabs, so switching from Experience to Skills drops unsaved rows with no warning.
10. **E2E hook.** It works as ruled: `protectedAction` is in `.next-e2e` and absent from the normal `.next`. It is one env var away from production, though, and writes `hold_days=7`, which would overwrite a changed value. Fail the build when `VERCEL_ENV=production` and the flag is set.
11. **Guards for later phases.** `lib/api/index.ts:7` exports the server helper beside the client, and `features/profile/index.ts` does the same. Nothing leaks today. Add `server-only` to `server.ts` and `client-only` to `token.ts` and `client.ts`, so a server component can never share module-level token state. The boundary rule (`eslint.config.mjs:15-20`) blocks `@/features/*/*` but not relative `../other/x`; there are no violations yet. `src/components/shell` importing `features/auth` also inverts the direction in spec section 6: move the shell or record a ruling. There are no response headers at all yet. CSP is phase 7, but `nosniff` and `frame-ancestors 'none'` could land now.
12. **Mobile shell** (`member-sidebar.tsx:17`). `h-14` plus `pt-[env(safe-area-inset-top)]` eats into a fixed height, unlike `public-header.tsx`, which nests the height correctly. It shows only where the top inset is non-zero, such as an in-app web view. With `viewportFit: "cover"`, no fixed bar applies left and right insets, so a landscape iPhone notch can cover the content. The account button is 32 px and the theme button 36 px. There is no skip link past the sidebar.
13. **No timeouts on the auth path.** `doRefresh` has no timeout, so a hung refresh holds `inFlight` and blocks every waiting request. Use `AbortSignal.timeout`.

---

## Focus-area answers

**1. Auth.** Holds up: token only in memory (no storage use anywhere in `src`), one refresh per tab under parallel 401s, a second in-flight 401 reuses the new token, `REFRESH_RACE` retried twice at 300 ms with no sign-out, one redirect on session loss, same `Idempotency-Key` on replay (the key sits in the cloned request). Guards run before the idempotency interceptor, so a 403 `STEP_UP_REQUIRED` is never stored and replayed. Tabs have no shared lock, which matches the plan; the backend's 10-second race window covers it. Gaps: I1 to I6.

**Open redirect.** `safeNext` is applied at all three consumers. `https://`, `//`, backslash and control-character forms all fall back. `/.//evil.example` stays same-origin. No finding.

**2. Security.** No secrets in the client build; no sensitive data in URLs (the challenge stays in memory, `next` holds only a path). `javascript:` is blocked by `safeHref`, and the backend also rejects non-http URLs. React escapes profile text. The only `dangerouslySetInnerHTML` is JSON-LD with `<` escaped and only public fields. Server pages pass nothing private to the client. `publicFetch` omits credentials and is uncached, and `/u/[handle]` is not in the prerender manifest, so no per-user data can be cached on the server. Gaps: C1, I3, Minor 10 and 11.

**3. Foundation.** Structure, client, query defaults and error model will carry phases 2 to 7. Fix I1, I2, I6 and I7 first, because every later feature inherits them.

**4. 404 under Next 16.** Sound for what the API reports: no `loading.tsx` or streamed boundary on the public path, `cacheComponents` and `partialPrefetching` are off, and the e2e checks the real status for an unknown handle (browser user agent only). Metadata sets canonical URLs and `noindex` for missing profiles. The real defect is upstream: C1.

**5. Mobile and accessibility.** Good base: 16 px inputs, labels, `aria-invalid`, `aria-describedby`, safe-area bottom nav, no horizontal overflow measured. Gaps: I8, Minor 12.

**6. Tests that pass with broken code.** I9 first. Gaps by omission: no test of 401 then step-up (I1), empty-body failure (I2), `RequireAuth` (I4), expired or locked code (I5), or suspended profile (C1). Two-tab races are only simulated by a mocked 409. `step-up.spec.ts` uses a route that is not `@Idempotent`, so key reuse is proven only at unit level.

**The mail flake.** The code does not point to a product bug. `OtpService.request` always enqueues after commit, OTP jobs have no `jobId` so nothing dedupes them, a rate limit is a visible 429 before the "Check your email" heading, and only a hard-bounced address is skipped.

What the code does show is a real race in the test helper. `signIn` calls `latestCode(email)` with no `previous` (`e2e/support/test.ts:39`), and `latestCode` returns the newest mail so far (`mail.ts:22-25`). If the worker has not sent the new mail yet, it returns the first sign-in's used code and the test fails on the code page. This fits a rare failure under parallel load that 16 repeats did not reproduce. It affects device B, the second sign-in in the `?next` test, and the desktop step-up run, which can read the phone run's last code.

One mismatch: as committed, this helper cannot time out for device B, because an older mail is always found. So the "within 20 s" in the report came from an earlier helper or from reading the failure loosely. `test-results/stack/worker.log` is rewritten each run, so that run's log is gone.

Fix: pass the mail count before submitting and wait for a newer mail. Separately, one backend risk is worth a ticket. The mail queue runs at concurrency 1 (`queue-worker.runner.ts:35`, `MailProcessor` sets none) and `HttpResendClient.send` has no timeout, so one hung Resend call delays every sign-in code behind it. In the worst case, retries after failures take about 15 seconds, close to the 20-second poll.

**7. Backend diff.**
- **Schemas:** match the handlers for sessions, lists, profile, blocks, mutes and preferences. The `required` widening is correct. Only the status wording in Minor 5 is off.
- **`RESEND_BASE_URL`:** cannot reach production. Rejected at boot with `NODE_ENV=production`, including an empty value (fails `.url()`), and both API and worker use `loadConfig`; both Dockerfiles set `NODE_ENV=production`. `NODE_ENV` defaults to `development`, so a deployment that bypasses the images would slip past the check.
- **Allowlist:** not sound; see I10.
