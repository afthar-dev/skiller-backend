# Re-review: tasks 6-8, fix round 1 (6577568..71c1fee)

## Finding Verdicts
1. **trust proxy never set in production** - ADDRESSED. config.schema.ts: TRUST_PROXY int 0-10 default 0 -> config.trustProxy; bootstrap.ts:~11 sets `trust proxy` to the hop count when >0 (default 0 keeps Express default = socket IP); test/setup/app.ts override removed, test env TRUST_PROXY=1 so e2e runs the production path; auth.e2e-spec.ts "TRUST_PROXY=1: different X-Forwarded-For IPs..." proves separate buckets; config spec covers default/parse/reject; .env.example and README document it.
2. **revoke ordering** - ADDRESSED. session.service.ts: revoke()/revokeAllForUser() call markRevokedOrFail() before the DB updateMany; setMarker retries 3 attempts (25/50ms backoff); REVOKED_KEY_TTL_SEC = 16 min (>= 15); any failure -> AppError SERVICE_UNAVAILABLE 503 with DB untouched (int tests assert revokedAt null). revokeFamily: marker failure caught + logged, DB revocation still runs, 401 AUTH_TOKEN_REUSED preserved (int test with failing Redis). README documents `maxmemory-policy noeviction`. Retry-count test present.
3. **step-up limited per IP only / guard-order dependent** - ADDRESSED. auth.service.ts requestStepUp: consumeRateLimit `stepup:user:{id}` 5/15min then `stepup:ip:{ip}` 20/15min, executed inside the service (after AuthGuard); controller @RateLimit removed; shared helper rate-limiter.ts throws RATE_LIMITED 429 with details.retryAfterSec. e2e tests: 6th request from different IPs -> 429 + Retry-After, other user unaffected, unauthenticated traffic does not consume buckets.
4. **plaintext OTP in BullMQ job data** - ADDRESSED. mail.service.ts: for template "otp", `removeOnComplete: true, removeOnFail: { age: 3600 }`. e2e test waits for non-terminal jobs to drain then asserts no job for the recipient in completed/failed/waiting/active/delayed.

Report names covering tests with RED/GREEN output; claims consistent with the diff (not re-run).

## New Breakage in the Fix Diff
None Critical/Important.
Minor:
- auth.service.ts:~46-47: user bucket is consumed before the IP bucket check, so a request rejected by the IP limit still burns a per-user slot.
- session.service.ts:~112-113 (revoke) / ~123-124 (revokeAllForUser): if the DB update fails after the marker is written, session is marked revoked in Redis for 16 min but active in DB (caller gets 500 and can retry; self-heals/retryable).
- bootstrap.ts:~12: TRUST_PROXY is a pure hop count; wrong value in prod (too high) allows XFF spoofing - operational, documented in README only.

## Out-of-Scope Observations
None

## Verdict
**Fix round:** All findings addressed, no new Critical/Important breakage.
