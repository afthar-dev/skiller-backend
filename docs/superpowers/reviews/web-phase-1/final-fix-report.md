# Final fix wave: web Phase 1 foundation

Branches: web `phase-1-foundation`, backend `web-phase-1`. Nothing pushed.

## Commits

Backend (`D:\skiller\skiller-backend`):
- `cf6af33` fix: suspended and deleted accounts have no public profile or follower-list rows (C1)
- `87faf41` fix: untyped-response allowlist gets a ceiling, a stricter typed test, a CI step and an unconditional CLI; Resend calls time out (I10, mail-flake ruling)
- `00aa635` fix: worker modules that build ProfilesService provide UserStatusCache (found by the full suite: without it the production worker fails at boot)
- `6e98e39` test: profiles int-spec provides a UserStatusCache stand-in
- `e20f754` test: campaigns skip test waits for every recipient to settle

Web (`D:\skiller\skiller-web`):
- `946c44a` step-up after a token refresh, unwrap on empty failures, dead-code copy and resend, no automatic idempotency key, cached and bounded public fetch (I1, I2, I5, I6, I7)
- `e0b8075` sign-out only succeeds when the server ended the session; Back after sign-out or a lost session redirects (I3, I4)
- `d0e19d5` AA contrast for error and link text, real e2e flows, suspended-profile e2e, mail helper by count (I8, I9, C1 web e2e, mail-flake ruling)
- `f924480` an edit expires the server's cached public profile at once (follow-up to I7, see below)
- `83bc899` test: wait up to 40 s for a code mail

## Per finding

### C1. Suspended and deleted profiles stay public
- Change: `ProfilesService.getByHandle` now answers `PROFILE_NOT_FOUND` (404) unless `UserStatusCache` says the account is ACTIVE (per the ruling, the method itself, not a new name). Follower and following lists use it for the target and skip non-active members in rows (batched status lookup, reading further batches so a hidden member never leaves a short or empty page). New `getByHandleAnyStatus` (raw lookup) is used by unblock and unmute, so a blocker can still undo a block on someone suspended afterwards, and by the gigs, reels and messaging lookups, whose existing contracts are deliberate and tested (empty list for a hidden seller or creator, 403 `MESSAGING_NOT_ALLOWED` for a suspended recipient). `follow`, `unfollow`, `block` and `mute` of a hidden member are 404.
- Backend tests (`test/e2e/profile.e2e-spec.ts`): SUSPENDED and DELETED each: profile, followers and following are 404 `PROFILE_NOT_FOUND`, follow is 404, other members' follower and following lists no longer show them; SUSPENDED then ACTIVE brings everything back at once. Pagination test: a suspended middle follower with `limit=1` yields two full pages. Unblock and unmute after suspension still 200.
- Red before the fix: 2 failed (`Expected: 404, Received: 200`), 30 pass after.
- Web e2e (`e2e/step-up.spec.ts`, second test, serial after the step-up test and reusing that admin session's step-up window): a member made through the API, profile checked on the API (200), suspended through the real admin route `POST /v1/admin/users/:id/suspend`, API now 404; then the web page is requested for the first time and must answer status 404 with the not-found heading and neither the headline nor the display name in the HTML. ISR: the web app caches public fetches for 60 s (I7), so the test never loads the page before the suspension and checks the "was public" state on the API instead. Red before the fix on the old backend build: `Expected: 404, Received: 200`.

### I1. Step-up after an expired access token
- `client.ts` `onResponse` is a loop: 401 refreshes and retries, the result then goes through the step-up check, each branch at most once, any order, same request every time.
- Tests (`client.test.ts`): 401, then 403 STEP_UP_REQUIRED, then 200 with one `Idempotency-Key` on all three sends and one refresh; each recovery runs once. Red: the combined test failed before the fix.

### I2. `unwrap` on an empty failure body
- `unwrap` decides on `response.status >= 400` (or an error body). Tests: `error: undefined` with status 400, 502, 503 throws `ApiError` (`UNKNOWN` code); 204 still returns undefined. Red before.

### I3. Sign-out when the server session survives
- Per ruling: `signOut` succeeds only on 2xx or 401 from `/v1/auth/logout`; any other status or a thrown network error is retried once; if it still fails the member stays signed in, nothing is broadcast, flags are restored and a toast says "We could not sign you out. Check your connection and try again." `signOut()` now resolves a boolean.
- Tests (`auth-provider.test.tsx`): 503 twice stays signed in, told, two calls, no redirect, no broadcast; network error then 204 signs out. Existing "server already ended the session (401)" test still passes. Red before.

### I4. Stuck "Taking you to sign in" after Back
- The provider keeps the page a session was lost on and the page signed out from, and ends both flags on the first render on a different page (state adjusted during render; an effect trips the `set-state-in-effect` lint rule). `RequireAuth` then redirects normally on Back.
- Tests: new `require-auth.test.tsx` (4 tests: visitor redirect, signed-in render, Back after a lost session, Back after sign-out) plus two flag tests in `auth-provider.test.tsx`. Playwright: `goBack()` step at the end of "session revoked on another device" asserts the browser ends on `/sign-in?next=%2Fsettings`. Red before (6 unit failures).

### I5. Expired and locked codes
- `OTP_EXPIRED` and `OTP_LOCKED` have "request a new code" copy; `RATE_LIMITED` uses `details.retryAfterSec` ("in 14 minutes", "in 45 seconds"); new `isDeadCode`. `CodeForm` ends the Resend cooldown on a dead code; `StepUpDialog` drops the challenge so "Send code again" shows, and Cancel or Send again clear the old error and digits (the same cancel-leaves-error problem listed as Minor 2, fixed because the state is the same).
- Tests: errors, code-form (both codes), step-up-dialog (both codes, resend gives a fresh challenge and clears the alert, reopen after cancel is clean). Red before.

### I6. Automatic Idempotency-Key
- Removed from the middleware. Added `newIdempotencyKey()` (exported from `@/lib/api`) as the per-attempt helper. Tests: no key is added when the caller gives none; a caller key is sent unchanged and survives refresh and step-up replays. The step-up unit test now passes an explicit key.

### I7. `publicFetch`
- Now `next: { revalidate: 60 }` by default (overridable, with tags), and `AbortSignal.timeout(5000)`. Tests assert both. Trusted server identity for rate limits is not done, per the ruling; it goes in the Phase 2 plan before catalog pages. Concern: a hidden profile can stay visible for up to 60 s.

### I8. Contrast
- New tokens `--error` and `--link` (light `#B91C1C`-equivalent 6.4:1 on white, 5.9:1 on the muted panel; dark `0 91% 71%`, 7.2:1 on the page, 6.0:1 on muted), used by every `text-destructive` and text-colour `text-primary` in `src` (filled buttons keep `--primary` and `--destructive`). Axe now runs in light and dark, plus sign-in with a validation error visible and a wrong-code error visible, in both schemes. Red before: the 4 error-state tests failed in each of the two viewports (8 failures).

### I9. Real e2e flows
- "blocked members and muted creators show in the lists and can be undone": two real members made through the API, blocked and muted through the API with the signed-in member's token, both appear in the right section on `/settings/privacy`, unblock and unmute in the UI, rows leave and stay gone after reload, API lists empty.
- "signing out the other devices ends a second session for real": a second browser context signs in as the same member, `Sign out other devices` in the first, the list drops to one, this device survives a reload, and the second device's next load goes to `/sign-in`. The old one-device test was renamed to what it checks.

### I10. Allowlist
- CI runs `pnpm openapi:check-responses` after the OpenAPI export check. New `scripts/openapi-untyped-ceiling.json` (`max: 180`): the check fails when the allowlist is longer than the ceiling and also when it is shorter (so the ceiling falls in the same change). Typed now means 204 or a JSON schema with `properties`, `items` or `$ref`. The CLI is a three-line file that always calls `main()` (logic moved to `check-openapi-responses-lib.mjs`). Tests added for the placeholder schema, the ceiling both ways, and a symlinked CLI (skipped on this Windows machine because symlinks are not permitted; the change is that no "am I main" test exists any more). The current contract passes with the stricter test, nothing newly untyped.

### Mail flake
- `latestCode(email, previous)` is gone. `mailCount(email)` before the step that sends a code and `codeAfter(email, count)` returns the code of the first mail beyond that count, so a late mail can no longer be read as the previous one. Used by `signIn`, `apiMember`, the wrong-code test, the step-up test and a11y.
- Backend: `HttpResendClient` aborts a call after 10 s (`timeoutMs`, constructor parameter); the thrown timeout is retried by the mail job, the `Idempotency-Key` keeps that safe. Unit test with a local server that never answers (red before: test timed out), and a normal send still works.

## Results

Backend, after the last backend edit (`e20f754`):
- `pnpm openapi:export`: no diff to `openapi.json` (204 paths); `pnpm openapi:check-responses`: ok (180 allowlisted, ceiling 180); `pnpm typecheck` and `pnpm lint`: clean; `pnpm test:scripts`: 12 pass, 1 skipped (symlink test, symlinks not permitted here).
- Full suite `npx jest --runInBand --forceExit`: 122 suites, 1363 tests, all pass (unit 344).
Web, after the last edit (`83bc899`): `pnpm typecheck`, `pnpm lint`, `pnpm test` (22 files, 135 tests), `pnpm build`, `pnpm api:check` (contract unchanged, `pnpm api:generate` produced no diff) and `E2E_BUILD_BACKEND=1 pnpm e2e`: 48 passed (2.9 m), phone and desktop. The e2e run used alternative ports (see concerns).

## Things found on the way

1. Worker boot: `ProfilesService` is also constructed by the billing, courses and users worker modules, which have no `UserStatusCache`. The first full run died in `worker.module.int-spec` (Nest cannot resolve it, `process.exit(1)`). Fixed in `00aa635`; the real worker would have failed to start.
2. Public-profile cache and own edits (follow-up to the I7 ruling): the 60 s cache also held a profile that the owner had just edited (the account menu's link prefetches `/u/<handle>`), which failed the existing "edit profile and see it on the public page" e2e. The profile fetch is now tagged `profile:<handle>`; saving basics or a list calls a server action that does `updateTag` for that tag (best effort, a failure never fails the save). Unit tests for the tag and for both save paths. Moderator-hidden profiles still can show for up to 60 s, as ruled.
3. `campaigns.e2e-spec` "skips, with a reason ..." failed in every full run in which jest placed it first, also on the untouched base commit `ecc0d1f` (reproduced in a throwaway worktree). It asserted right after the third SENT, but skips come off the same queue. It now waits for all five recipients to settle. It passed alone before and after.
4. The mail flake still shows rarely: 2 of 8 e2e runs had a second sign-in for the same address (device B) whose mail did not reach the fake Resend within 20 s, with the app showing "Check your email" and no worker error logged; 6 later runs (3 with a kept stack, 1 final) passed. It is not a code mix-up any more (the helper counts mails), so I could not tie it to a bug; the suspicion is one mail worker at concurrency 1 plus a cold start under four browsers. The wait is now 40 s. If it returns, run the stack with `LOG_LEVEL=info` and look at the mail queue.

## Concerns

- `getByHandle` is strict (404 for suspended or deleted), as ruled, but I kept the gigs, reels and messaging lookups on the any-status method (`getByHandleAnyStatus`) because their existing tests pin other behaviour (empty lists, 403 `MESSAGING_NOT_ALLOWED`). Say so if you want those to 404 as well.
- Four node processes (`dist/main.js`, `dist/worker.js`, `next start`, started 13:31 local, parents gone) from an earlier e2e run, not mine, still hold ports 4300 and 3000 (pids 9872, 8508, 24468, 10212). They made my runs fail with EADDRINUSE and talk to a stale API. I did not stop them (not started by me); I ran e2e on other ports (`E2E_API_PORT=4401 E2E_WEB_PORT=3101 E2E_RESEND_PORT=4411 E2E_PG_PORT=55442 E2E_REDIS_PORT=56389 E2E_MINIO_PORT=59010`). Worth killing them. Note that an old worker there could also consume jobs if it can reach a Redis on 56379.
- While removing a throwaway worktree I used a node_modules junction, and `git worktree remove --force` followed it and deleted part of `skiller-backend/node_modules`. Restored with `pnpm install --frozen-lockfile --offline --force` and `prisma generate`; typecheck, lint and the unit suite pass and the full suite passed afterwards. No source or lockfile changed.
- The symlink test for the CLI is skipped on this machine; the fix (no "am I main" guard) does not depend on it.
- I7 trusted server identity stays for the Phase 2 plan; stale hidden content up to 60 s is accepted.
- Minors untouched, apart from the step-up dialog's cancel-state reset, which came with I5.

