# Review: Tasks 3, 4, 5 (7b25d93..06925d9)

### Spec Compliance

- ✅ Spec compliant. Every listed file and interface in the three briefs has a corresponding hunk. The `Retry-After` header requirement is met outside this diff: `src/common/errors/error.filter.ts:38-39` sets it from `details.retryAfterSec`, and `error.filter.spec.ts:64` covers it. I checked that file only for that named risk.
- ⚠️ Cannot verify from diff: `@RateLimit` + `APP_GUARD` wiring is never exercised through an HTTP route (no route uses the decorator yet). Controller should confirm when the first rate-limited route (Phase 1 auth) lands.
- Extras, all justified and small: `idempotencyKey` on `ResendMessage` (resend.client.ts:8), `UnrecoverableError` on 4xx, `jobNames` routing in `JobProcessor`, `svix` pinned to 1.45.1, `rawBody: true` in main.ts and the test harness.

### Strengths

- Rate limit: atomic Lua sliding window on Redis TIME, unique members, and `retryAfterSec` clamped to [1, windowSec] (rate-limit.guard.ts:7-25, 60).
- Outbox: the transaction boundary is correct. `enqueue` takes a `tx`, the relay uses `FOR UPDATE SKIP LOCKED`, and the BullMQ `jobId` equals the event id.
- Mail rules are implemented exactly and each has a test:
  - Transactional mail skips only `bounced` (mail.processor.ts:38).
  - Promotional mail skips any suppression.
  - Lookup is case-insensitive.
  - The webhook never downgrades a bounce to a complaint (resend-webhook.controller.ts:52), with an e2e test.
- Webhook signature is verified against the raw body, with a forged-signature test that asserts nothing is written.
- Resend errors are classified: 5xx/429/network retry, other 4xx are unrecoverable.
- `/v1/ready` has a degraded-Redis test.

### Task 4 test-strength analysis (the implementer's no-red-run concern)

| Test | Would it fail against a broken implementation? |
|---|---|
| Rolled-back tx never relayed (outbox.int-spec.ts:60-74) | Yes. An enqueue that bypasses `tx` leaves a row, so the `rows == 0` assertion at :73 fails. |
| Retries when a handler fails (:90-97) | Yes. With no retry, `waitFor` times out. |
| Relays automatically once scheduled (:99-106) | Yes. |
| Exactly once with concurrent relays (:76-88) | **No, not for the claimed property.** See Important #1. |

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)

1. `src/common/outbox/outbox.int-spec.ts:80` (concurrency test). It does not prove the relay is concurrency-safe.
   - Duplicate delivery is prevented by the BullMQ `jobId` dedupe (outbox.relay.ts:66), not by the row locking.
   - Delete `FOR UPDATE SKIP LOCKED` at outbox.relay.ts:62 and both relays read the row and call `add` with the same `jobId`. BullMQ drops the second add, the handler still runs once, and the test stays green.
   - `FOR UPDATE` without `SKIP LOCKED` also passes. The second relay blocks, then re-evaluates `publishedAt IS NULL` and gets zero rows.
   - The test only fails if both the lock and the `jobId` are removed. That is a pass-by-accident for the task's headline requirement, and it is the cost of having no observed red run.
   - Fix: spy on `outboxQueue.add` and assert it is called exactly once across `Promise.all([relayOnce(), relayOnce()])`. Better, also assert the two return values sum to 1. Then confirm the test turns red when the locking is removed.
   - Optionally add a second case where the `jobId` is removed but the lock is kept.

#### Minor (Nice to Have)

1. `mail.processor.spec.ts:93`. `expect(client.sent).toHaveLength(0)` is vacuous, because `MailService` is constructed with only the queue and holds no reference to `client`. The remaining `added` assertions are the real test.
2. Retry policy (5 attempts, exponential) is configured at queue.module.ts:13 but never asserted. The retry test passes with any attempts >= 2.
3. `queue-worker.runner.ts:27`. A job whose name matches no processor completes silently and is dropped. Consider failing or logging it.
4. `outbox.relay.ts:70`. `attempts` is incremented at publish time, so it counts relay publishes, not delivery attempts. The naming is misleading.
5. Delivery is at-least-once, not strictly exactly-once. `jobId` dedupe holds only while the job record exists (`removeOnComplete` age 3600, queue.module.ts:21). The window is tiny and the handler contract documents idempotency (event-bus.ts:5), but it differs from the literal "exactly once" wording.
6. `rate-limit.guard.ts:49`. The guard fails closed: a Redis outage returns 500 for every `@RateLimit` route, including login. This is a deliberate-looking but undocumented policy. `/v1/ready` (health.controller.ts:~23) also has no timeout on `ping`/`$queryRaw`, so a hung Redis can hang the probe instead of returning 503.
7. OTP codes sit in plaintext in BullMQ job data (retained 1 h on completion, 7 days on failure, queue.module.ts:21). They are expired after 10 min, but consider `removeOnComplete: true` for the mail queue or the otp job.
8. No test covers `APP_GUARD` registration via HTTP, and `/v1/ready` has no database-down case.
9. The webhook endpoint has no rate limit (the implementer flagged this); the signature is the only gate.

### Assessment

**Task quality:** Needs fixes

**Reasoning:** The implementation is sound and meets every brief and global constraint. The one blocker is that the Task 4 concurrency test passes even with the row locking removed, because `jobId` dedupe masks it. A spy on `queue.add` call count closes the gap in a few lines.
