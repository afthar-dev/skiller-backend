# Final review: Web Phase 2 (courses, learning, checkout)

Scope: skiller-web `git diff main...phase-2-courses` (lockfile, `schema.gen.ts` and `contract/` skipped) and backend `backend-review.diff` (branch `web-phase-2`). I checked the claims against the backend source on `web-phase-2`, including `fulfilment.service.ts`, `orders.service.ts`, `idempotency.interceptor.ts`, `entitlements.service.ts`, `course-access-rules.ts` and the edge gate.

**Verdict: merge with fixes.** 0 Critical, 1 Important, 9 Minor.

---

## Important

### I1. Checkout tells a paying buyer "you have not been charged" and lets them pay the same Razorpay order again
`skiller-web/src/features/checkout/use-checkout.ts:199` (`waitForPayment`), with `:133-135`.

`waitForPayment` treats an order status of `FAILED` (or `EXPIRED`) as final. It then returns to `idle` with the message "The payment did not go through. You have not been charged. You can try again." The same attempt key is kept.

The backend does not treat `FAILED` as final:
- `OrdersService.markFailedByRazorpayOrder` (orders.service.ts) sets the order to `FAILED` on any `payment.failed` webhook, and its comment says "the buyer may retry on the same Razorpay order, so a later capture still fulfils it".
- `FULFILLABLE = ["CREATED", "FAILED", "EXPIRED"]` (fulfilment.service.ts:19).

Failure scenario:
1. Inside the Razorpay window the buyer's card is declined. The webhook sets the order to `FAILED`.
2. The buyer retries with UPI in the same window and pays. The handler fires with a valid proof.
3. Verify returns 202 because the payment is still `authorized`, not yet captured. The hook starts polling.
4. The first poll sees `FAILED`, so the buyer reads "You have not been charged".
5. The buyer taps Pay again. The same Idempotency-Key replays the same order, and Razorpay opens on the same Razorpay order, which still accepts payments while the first payment is only authorized.
6. Both payments are captured. `recordDuplicate` only raises an alert: "Refund it manually."

Result: the buyer is charged twice, and the second charge is refunded only if someone acts on the alert. The first payment still fulfils the order, so the course unlocks later, after the buyer was told the payment failed.

Fix: once the handler has returned a payment proof, treat `FAILED` and `EXPIRED` as "not yet".
- Poll `POST /v1/checkout/verify` with the same body (it fulfils on capture without waiting for the webhook), alongside or instead of `GET /v1/orders/{id}`.
- Keep going until `PAID` or the 60 s limit. On the limit, go to `confirming`.
- Set `finished.current = true` as soon as a proof exists, so this hook can never start another payment.
- Add a test: verify 202, then the order poll returns `FAILED`, then `PAID`. The expected result is no "not charged" message and a single order.

---

## Minor

### M1. Closing Razorpay after paying returns to a payable sheet
`use-checkout.ts:117-120`. On `dismissed` the hook goes straight to `idle` without checking the order.

Scenario: with UPI collect or intent, the buyer approves the payment on their phone and closes the modal before the handler fires. The sheet invites Pay again on the same Razorpay order. If the first payment is not yet captured, this can lead to a duplicate payment that needs a manual refund (the I1 path).

Fix: after a dismissal, `GET /v1/orders/{id}` once. If the order is `PAID`, show success. Otherwise say "If you completed the payment, it will appear in Orders".

### M2. After "undeliverable" the sheet offers Pay again
`use-checkout.ts:125-128`. The payment is booked and a refund follows, but `finished` stays false. Pay replays the PAID order and opens Razorpay on an order that is already paid. Razorpay should refuse it, but the buyer is confused.

Fix: set `finished.current = true` and show a link to Orders.

### M3. Unauthenticated server action can expire course cache tags at will
`skiller-web/src/features/reviews/refresh-course.ts:7`. `refreshCoursePage(slug)` is a public endpoint with no check.

Course page reads go through `publicFetch` with the SSR secret and no client IP. The API's `RateLimitGuard.isPublicRead` skips every limit for those reads (rate-limit.guard.ts:643).

Scenario: an attacker alternates action calls and page loads. Each page load then makes 3 uncached API reads that no rate limit counts.

Fix: rate-limit the action, for example per IP inside the action. Or send `visitorIp()` as `clientIp` on reads that follow a tag expiry. Or drop the action and rely on the 60 s window.

### M4. Certificate verification is cached 60 s, but the API says `no-store`
`skiller-web/src/app/(public)/certificates/[code]/page.tsx:13-14`. The page uses the default `revalidate: 60`, while the API sets `Cache-Control: no-store` on this route (certificates.controller.ts). A certificate revoked by a refund still verifies as "valid" for up to 60 s. Plan Review Focus 5 expects the page to show revoked.

Fix: `revalidate: 0`, with the visitor's `clientIp` so the per-IP limit of 60/min applies to the visitor.

### M5. Heartbeat gap has no margin over the server's 5 s minimum
`skiller-web/src/features/learn/use-heartbeat.ts:10,57`. The client measures the 5000 ms gap at send time. The server measures it at processing time, after taking row locks (progress.service.ts:82-87).

Scenario: a tick is delayed in transit or on the lock, and the pause heartbeat sent 5.0 s later arrives first. The server answers 429, the error is swallowed, and the resume position is lost.

Fix: use a gap of about 6 s. On a 429 with `retryAfterSec`, retry once.

### M6. Each token refresh rebuilds the player
`skiller-web/src/features/learn/video-player.tsx:55-126`. A new `manifestUrl` about every 9 minutes destroys the hls.js instance and builds a new one. The buffer is dropped, which causes a short stall and a jump back of up to 250 ms (the `timeupdate` granularity). Plan Review Focus 3 asks for playback to continue across refreshes.

Fix: keep one hls instance. Put the token in an `xhrSetup` / `loader` hook, or swap with `hls.loadSource` without `destroy`. Native Safari has to reload, which is acceptable.

### M7. `visitorIp()` trusts the first X-Forwarded-For entry
`skiller-web/src/lib/api/server.ts:43-51`. This is safe on Vercel, which overwrites the header. On any other host the client chooses the address that the API rate-limits, and so can escape the catalog's 120/min limit.

Fix: prefer `x-real-ip` / the platform's own header, and document that this relies on Vercel.

### M8. The free-preview page is never a real 404
`skiller-web/src/app/(public)/courses/[slug]/preview/[lessonId]/page.tsx`. The page renders on the client. For an unknown, hidden or flagged course, or for a lesson that is not a preview, it answers HTTP 200 and shows a sign-in or no-access state.

It is `noindex`, so the impact is small. It still breaks the spec rule "Hidden or removed content returns a real 404 from the server render".

Fix: call `getCourse(slug)` on the server and `notFound()` when it returns null.

### M9. Tests that pass with the money logic broken
- `use-checkout.test.tsx` has no case for a failed attempt followed by a successful one (I1). A test "poll sees FAILED -> idle with 'not charged'" would pass against the current, wrong code.
- No test covers dismissal after the payment was made (M1).
- `pool-checkout-coupon.e2e-spec.ts` forces plan reads to the database by mocking `redis.get` for `ent:` keys. This works, but it depends on the cache key prefix; if the prefix is renamed, the test passes without exercising the database path.

---

## Checked and sound

**Pool-starvation fixes (9).** Every fix reads the limit or setting before the transaction and enforces it inside (`EntitlementsService.enforce`), or threads `db`/`tx` through.
- Limit semantics are unchanged: `planFor(...).limits.creator_coupons` is the same value `limit()` returned.
- Advisory locks are unchanged.
- `ensureRazorpayPlan` now runs outside the per-owner lock but keeps its own per-version lock and conditional store, so crash safety is unchanged.
- `authorIds` runs its queries one after another, which is correct for a transaction client.
- The approval path returns an unlimited limit for a missing course, but the course is refused inside the transaction anyway.

**Trusted-server identity.**
- The secret is compared with `timingSafeEqual` over SHA-256 digests, so lengths are equal and the comparison is constant-time.
- A wrong or absent secret means both headers are ignored.
- The client IP is checked with `isIP`.
- The secret is optional with a minimum of 32 characters.
- `RAZORPAY_BASE_URL` is refused in production.
- On the web side the secret is non-`NEXT_PUBLIC_`, read by a getter, and only used in `server-only` `publicFetch`.

**Optional auth.**
- A request with no header is a visitor. Any header that is sent is validated in full (401, suspended, revoked), so a bad token never degrades to visitor.
- Visitor access is exactly rule 3 of `learnAccess` (free-preview lesson, PUBLISHED, unflagged).
- Visitor playback goes through `canPlayAnonymously` only.
- Refusals match those of non-enrolled users (`denied()`).
- `anonymousOnly` limits are skipped when a header is present, but such requests are then authenticated or refused.

**Anonymous playback tokens.** `u: "anonymous"` is consumed only by the edge gate, which checks `typeof u === "string"` and the asset id. Nothing else parses the claims. The rate limit and watermark branches handle a null user.

**Idempotency on the web.**
- The key is kept on network errors, 5xx and `IDEMPOTENCY_IN_PROGRESS`, and renewed on other 4xx and on a coupon change. This matches the interceptor (4xx stored, 5xx released, a different body gives 409).
- Double-tap is blocked by `busy`.
- A refresh after a 401 resends the identical request.

**Razorpay amount.** The amount is the API's paise string converted to a safe integer at the boundary. The order and key are the API's.

**Markdown and plain text.**
- markdown-it runs with `html: false` and no linkify, with a scheme allow-list.
- Entity-encoded and control-character schemes are normalised or encoded before `validateLink`.
- Reference links and autolinks are validated.
- JSON-LD escapes `<`.
- Q&A, reviews and quiz text are rendered as React text.

**Cached public pages** carry no per-user data. Session-dependent parts (CTA, ReviewForm) are client islands, and `publicFetch` omits credentials.

**404s.** A course that is hidden, flagged, unpublished or unknown returns a 404 from the API, then `null`, then `notFound()`. Unknown categories and certificate codes get a real 404 as well. Next does not cache non-OK fetches.

**Order `refund` field.** It covers live refunds only. Duplicate-payment refunds are not Refund rows, so they cannot mislabel an order.
