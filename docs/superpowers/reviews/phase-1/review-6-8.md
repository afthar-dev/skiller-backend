# Review: Tasks 6-8 (0675ef3..6577568)

Line refs are new-file lines (derived from diff hunks) unless noted. Checks outside the diff: `src/bootstrap.ts`, `src/app.module.ts`, `src/common/redis/redis.module.ts`, `src/common/config/config.schema.ts`, `src/modules/mail/mail.service.ts`, `src/common/queue/queue.module.ts`, `src/common/errors/error.filter.ts` (one focused check per named risk; no suite re-run).

## Spec Compliance

- ✅ Spec compliant. Every brief file/interface/endpoint has a hunk; all listed test cases exist.
- ⚠️ Cannot verify from diff:
  - Global constraint "Step-up OTP valid 5 minutes": code makes the step-up *grant* last 300 s (`step-up.service.ts:21`, matches Task 8 brief) but the STEP_UP *challenge* uses the shared 10 min TTL (`otp.service.ts:13`, mail says `expiresInMin: 10`, `otp.service.ts:82`). If the constraint means the challenge TTL, this is a miss. Controller to confirm intent.
  - Suspension takes effect immediately only if the (future) suspend path calls `UserStatusCache.bust`; otherwise the 60 s cache (`user-status.cache.ts:20-26`) delays the 403. Check in the task that adds suspension.
  - Deployed proxy topology (see Important 1).
- Unrequested but benign extras: `OtpService.verify` third `expect` param (compatible, justified), sliding session expiry (see Minor 1), `@Global()` IdentityModule, variadic `RateLimit`.

## Strengths

- `OtpService.verify` is genuinely atomic: one `UPDATE ... attempts+1 ... WHERE attempts < 5 AND consumedAt IS NULL AND expiresAt > now [AND purpose AND userId] RETURNING`, then HMAC compare via `timingSafeEqual` on equal-length digests (`otp.service.ts:86-109`), then CAS consume. Purpose/user mismatch burns no attempt. Code from `randomInt`, HMAC keyed by pepper over `challengeId:code`; only the hash stored. Parallel-verify test is real.
- Refresh token: 32 random bytes base64url, stored as SHA-256 (adequate for high-entropy secret), unique index on both hashes; rotation is a compare-and-swap `updateMany` (`session.service.ts:68-79`) with a tested 6-way concurrent case. REFRESH_RACE vs REUSED logic matches the brief exactly, boundary `<= 10 s`.
- JWT: `algorithms: ["HS256"]` and `issuer` pinned on verify, expiry driven by the injected Clock, claims type-checked, all failures mapped to AppError (`token.service.ts:36-48`). Secret min length 32 enforced by config schema.
- Enumeration: `requestOtp` never looks up the user; identical 202 body; per-email key falls back to `invalid:{ip}` for malformed bodies.
- Cookie attributes asserted from raw Set-Cookie; clear uses identical options; session list never returns hashes; ownership enforced on DELETE.
- First-login race handled with `createMany skipDuplicates` and outbox row in the same tx.
- No secrets reach logs in this diff: ErrorFilter logs only >=500 exceptions; worker `failed` logs only `err.message`.

## Issues

### Critical (Must Fix)
None.

### Important (Should Fix)

1. `src/bootstrap.ts:8-17` (+ `test/setup/app.ts:24`): Express `trust proxy` is never configured in production; only the test harness sets it. Behind any proxy/CDN `req.ip` is the proxy address, so the per-IP limits (20 OTP requests/15 min, 20 step-up/15 min, `auth.controller.ts:42-45,89`) become one global bucket: 20 login requests per 15 min for the entire user base, i.e. trivial self-DoS of login, and stored `Session.ip`/`OtpChallenge.ip` are useless. Setting it to `true` instead would let a client spoof XFF and bypass the IP limit. Fix: add a `TRUST_PROXY` config (hop count or CIDR list), apply it in `configureApp`, and have the e2e harness use `configureApp` rather than setting it separately so the production path is what is tested.
2. `session.service.ts:104-105,131-135,137-143`: revocation is DB update followed by Redis write, and `AuthGuard` (`auth.guard.ts:32`) trusts only Redis. If the Redis write fails (or the key is later lost to flush/eviction under an LRU policy) the session is revoked in Postgres but its access token stays valid up to 15 min, violating the "revoked session must be blocked" intent for logout, revoke-others and family revocation. In `revokeFamily` the same failure also turns the intended `401 AUTH_TOKEN_REUSED` into a 500 after the family is already revoked. Fix: write the Redis marker first (idempotent, retry), then the DB update; or have the guard fall back to a DB `revokedAt` check on a cache miss; and make the Redis keyspace non-evictable (`noeviction`/dedicated DB) in deploy docs.
3. `auth.controller.ts:87-91` + `redis.module.ts:13` / `identity.module.ts:28` / `app.module.ts:17`: step-up request is limited only per IP (20/15 min), and because `RateLimitGuard` runs before `AuthGuard` (only by virtue of `RedisModule` being listed before `IdentityModule` in `AppModule.imports`, an implicit, untested ordering) unauthenticated traffic from an IP consumes the same bucket. Effects: (a) any unauthenticated client on a shared IP/NAT can lock legitimate users out of step-up; (b) an authenticated user has no per-user cap (up to 20 mails/15 min to their own address; each call also invalidates their previous step-up code); (c) combined with Important 1, the cap is global. Fix: add a per-user limiter inside `AuthService.requestStepUp` (Redis sliding window keyed by `userId`, e.g. 5/15 min) and keep or drop the IP limit; add an e2e test that step-up throttling is per user.

### Minor (Nice to Have)

1. `session.service.ts:77`: rotation slides `expiresAt` to now+30 d forever with no absolute cap; a continuously used (or stolen-and-used) session never expires. Brief does not request sliding. Consider an absolute lifetime from `createdAt` (e.g. 90 d). Human decision.
2. `mail.service.ts:15` / `queue.module.ts:21`: plaintext OTP is in BullMQ job data (kept 1 h on complete, 7 d on fail). Harmless after the 10 min TTL but contradicts "stored hashed" in spirit; consider shorter `removeOnComplete`/`removeOnFail` for the mail queue.
3. `test/e2e/auth.e2e-spec.ts:26`: `expect(t.mail.sent.length).toBeGreaterThanOrEqual(before)` is vacuous.
4. No negative tests for `verifyAccess` (alg `none`, HS512, wrong secret, wrong issuer, missing `sid`); `token.service.ts:36-48` pinning could be deleted with all tests still green (only `"not.a.jwt"` is tested).
5. `session.service.int-spec.ts`: shared `FakeClock` is advanced (+30 d, +11 s) and never reset, so later tests are order-dependent (the otp spec restores it).
6. No rate limit on `POST /auth/otp/verify` or `/auth/refresh` (OTP is bounded to 5 attempts per challenge and 5 challenges/15 min/email, about 25 guesses per window, acceptable; add per-IP throttles anyway).
7. `user-status.cache.ts:20-26`: read-through has the classic get/bust race (stale ACTIVE can be re-cached for 60 s after a concurrent bust); the 60 s staleness also applies to `AuthService.refresh` (`auth.service.ts:59-64`).
8. `otp.service.ts:62-82`: concurrent `request()` calls for one email+purpose can leave two live challenges (read-committed, no lock); mail enqueue happens after commit, so an enqueue failure leaves an unusable challenge (user can re-request).
9. `session.service.ts:73,88`: only the immediately previous hash is retained, so a token two rotations old yields `AUTH_SESSION_EXPIRED` with no family revocation. Matches the brief's algorithm.
10. `auth.service.ts:34-47`: session creation is outside the user-creating transaction; a failure leaves a registered user whose retry reports `isNew:false`.
11. `auth.controller.ts:42-45`: email bucket is consumed before the IP bucket is checked, so IP-blocked requests still burn the email budget; inherent related tradeoff: anyone can exhaust a victim's 5/15 min email budget or invalidate a pending code by requesting (`otp.service.ts:62`).
12. `auth.controller.ts:81`: logout requires an unexpired access token, so a client whose access token expired cannot revoke server-side without refreshing first.
13. Step-up challenge TTL (see Spec ⚠️) has no test pinning either interpretation.

## Named risks: verdicts

- Guard ordering / step-up per IP only: real weakness, Important 3.
- `trust proxy`: real deployment bug masked by the harness, Important 1.
- Redis revocation after DB update: real, Important 2.
- Sliding 30-day expiry: Minor 1.
- Timing-safe compare: correct. Refresh token entropy/hash: correct. JWT algorithm pinning: correct in code, untested (Minor 4).
- Tests passing without the code: step-up 300 s test relies on the Clock value check (fine, TTL separately asserted); the one vacuous assertion is Minor 3; trust-proxy-dependent rate-limit e2e tests pass only because the harness sets what production lacks.

## Assessment

**Spec verdict:** ✅ (with the ⚠️ above)
**Task quality:** Needs fixes
**Reasoning:** Core OTP, rotation and JWT mechanics are sound and well tested, but three Important issues (production `trust proxy`, non-durable session revocation, step-up limiter design) should be fixed before this is relied on as a security boundary.
