# Review: Task 5 (sellables, coupons, checkout, fulfilment) — 7d54ee0..f1b1f04

Line references are file lines in the new (HEAD) versions; billing.controller.ts lines are approximate (hunk-derived).

### Spec Compliance

- ✅ Spec compliant with the brief and the controller rulings (floor commission, platform-funded coupon paid on LIST price, fulfil accepts CREATED|FAILED|EXPIRED, 4xx idempotent responses stored and replayed).
- Documented deviations, all justified: `describe(itemId, { buyerId })` (needed for "already owned"); extra `DuplicatePayment` model/alert (not in brief, but a second captured payment would otherwise be unhandled money); `splitSale` / `saleLines` extracted.
- ⚠️ Cannot verify from diff: `LedgerService.post` uniqueness on `(refType, refId, description)` (relied on as the second line of defence against double posting; the e2e test uses that unique key so it exists); `RazorpayClient.verifyPaymentSignature` is constant-time and `createOrder` defaults currency to INR and `RazorpayApiError.message` carries no secret (Task 2); `commissionSplit` / `gstSplit` / `splitBps` rounding in money.ts (unit random test passes zero-sum).

### Strengths

- Fulfilment is correctly serialised: pre-checks outside the tx, then `SELECT ... FOR UPDATE` on the order plus a conditional `UPDATE ... WHERE status IN (...)`; the loser of a verify/webhook race sees PAID and returns `already` or `duplicate` (fulfilment.service.ts:94-109). Ledger post, coupon redemption, `provider.onPaid` and outbox enqueue are all in the same tx, so any throw rolls everything back (tested).
- Razorpay cross-checks run in the shared `fulfil()` so they apply to BOTH verify and webhook: payment.order_id must equal the stored razorpayOrderId (:61-63), status captured (:72-74), amount and currency equal (:75). Verify additionally binds the signature to (razorpayOrderId, paymentId) and to the stored order id. No client amount is read anywhere (checkout body is parsed to itemType/itemId/couponCode only).
- authorized vs captured handled correctly (202 / queue retry) and tested.
- Exact-paise worked examples verified by hand: 100000 @1000bps -> 90000 / 8475 / 1525 (clearing -100000); platform 20% -> clearing -80000, seller 90000, revenue 8475 and -20000, tax 1525 (sum 0); creator 20% Pro -> fee 5600 = 4746 + 854, seller 74400. Zero-sum holds by construction (sale-split.ts:44-58). Rs 1 sale (100 paise, 1000 bps): fee 10 = 8 + 2, seller 90. Totals below 100 paise are rejected before an order exists (99-paise coupon cases cannot reach the ledger).
- Idempotency: atomic `INSERT .. ON CONFLICT DO NOTHING` claim, body hash over key-sorted JSON (stable-json.ts), key scoped to (user, route), compare-and-set on `startedAt` for takeover so a slow original can never overwrite the new attempt's result (interceptor:99-101, 124).
- Authorization: verify and `GET /orders/:id` look up with `buyerId`; strangers get 404 (tested). No secrets/signatures in logs or responses (only public keyId).

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

1. **A 4xx thrown from `provider.onPaid` (or any 4xx inside the tx) is swallowed by the webhook path: money captured, order stays CREATED, nothing retried, nothing alerted.** order-handlers.ts:86-89 treats every `AppError` with status < 500 as "final and already alerted", but only the mismatch path alerts. Scenario: buyer pays, the course was unpublished/deleted between checkout and payment (Phase 3 `onPaid` throws `404 COURSE_NOT_FOUND`) or enrolment hits an already-enrolled 409 from two parallel checkouts that both passed `describe`. The webhook returns normally, `webhook_events.processedAt` is set, the order sits CREATED (then EXPIRED in 24 h) with the buyer's money in Razorpay and no finance_admin notification; the verify path returns the same 4xx to the browser. The same hole exists for 5xx: after the queue exhausts retries nothing alerts finance. Fix: in `fulfilInTx` wrap `provider.onPaid` errors in a 500-class `AppError("FULFILMENT_FAILED")` (so they are retried, never swallowed), and raise a `FULFILMENT_FAILED` finance alert (outside the tx) on failure / on the last attempt; restrict the swallow list in `onCaptured` to the explicit codes (`PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_ORDER_MISMATCH`, `PAYMENT_NOT_CAPTURED`, `PAYMENT_NOT_FOUND`). Add a test where `onPaid` throws a 4xx `AppError` through the webhook.

2. **Per-user-once and `max_uses` are not enforced under concurrency or parallel open orders; they only raise an after-the-fact alert** (coupons.service.ts:111,114 check committed redemptions only; fulfilment.service.ts:135-157 inserts with `skipDuplicates` and still fulfils). Scenario: a buyer calls `POST /v1/checkout` ten times (distinct Idempotency-Keys, or ten different items) with the same single-use coupon before paying any; every `evaluate` passes because nothing is redeemed yet; they pay all ten; each is fulfilled at the discount, nine `COUPON_REDEMPTION_CONFLICT` alerts are sent. Same for `max_uses=1` and N buyers (the test at checkout.e2e-spec.ts:2755 encodes exactly this leak). For creator-funded coupons the seller silently bears the extra discounts; for platform coupons it is direct revenue loss, and an attacker needs no race, just patience. Counting at fulfilment is the ruling, but the ruling does not require allowing this. Minimal fix: in `evaluate` also reject when the same buyer already has a non-expired CREATED order carrying that coupon (per-user rule becomes effectively enforced at checkout), and make `max_uses` count `redemptions + open CREATED orders with the coupon`, or reserve a `PENDING` redemption at checkout and release it on expiry/failure. Keep the fulfilment-time fallback + alert as the last line.

#### Minor (Nice to Have)

1. checkout.service.ts:58 — self-purchase only blocks `sellerOwnerType === "USER"`; an ORG member/owner buying their own org's item is not blocked (fee leakage and wash sales). Needs an org-membership check via the provider or a helper.
2. fulfilment.service.ts:67 and billing.controller.ts:~177 — a REFUNDED / PARTIALLY_REFUNDED order returns outcome `ALREADY_PAID` and verify answers 202 with `status: "REFUNDED"`; misleading outcome name, and 202 means "keep polling".
3. billing.controller.ts:~168-179 — `verify` does DB lookup, signature check and order-id comparison in the controller (and injects PrismaService and the Razorpay client there); move into a `CheckoutService.verify` to keep controllers thin and unit-testable.
4. idempotency.interceptor.ts:82 — route is `req.originalUrl` minus query; `/v1/checkout/` vs `/v1/checkout` (Express non-strict routing) or case variants are different routes, so one key reaches the handler twice with two orders. Normalise (strip trailing slash, lowercase).
5. idempotency.interceptor.ts:99-101 — stale takeover while the slow original is still running creates a second order and Razorpay order; the original client got order A, the stored/replayed response is order B, and both orders can be paid. Not a double-fulfilment (different orders) but the buyer can pay twice; consider making the stale window configurable and longer than the gateway timeout, and log the takeover.
6. fulfilment.service.ts:111-112 — `provider.onPaid` runs after `postSale`, so the three platform account rows (clearing/revenue/tax, locked `FOR UPDATE` by the ledger) are held for the whole of `onPaid` (Phase 3 enrolment, possibly several queries); every sale on the platform serialises on them. Call `onPaid` before `postSale` to shorten the hold. The interactive transaction also uses Prisma's default 5 s timeout; set an explicit `{ timeout, maxWait }` so contention does not turn a valid payment into a P2028 retry loop.
7. fulfilment.service.ts:77-80 — finance alerts are raised after commit and swallowed on failure; a crash between commit and alert loses the COUPON_* alert. Acceptable, but consider writing the anomaly into the outbox in the tx.
8. Tests: no concurrent test of per-user coupon rule, of the idempotency stale takeover racing a slow original, of two different captured payments racing on one order, or of `onPaid` throwing a 4xx through the webhook (see Important 1); checkout.e2e-spec.ts:2546/2559 `spy.mockRestore()` is not in a `finally`, so a failing assertion leaks the spy into later tests.
9. Idempotency purge (idempotency.cleanup.ts) runs hourly on createdAt, so a record up to ~25 h old still replays; harmless but the "24 h retention" is approximate. Also `COUPON_OVER_LIMIT` and `COUPON_REDEMPTION_CONFLICT` can both fire for one order (fulfilment.service.ts:142-155).

### Per-focus verdicts

1. Double post / double fulfil: safe. Verify+webhook, two webhooks, verify retried all serialise on the order row lock and conditional UPDATE; different payment ids go to `DuplicatePayment`, never the ledger. Ledger unique key is a second guard.
2. Amount tampering: safe. Server price only; amount, currency, order id and status are checked from the gateway fetch on both paths; a payment captured for a different Razorpay order gets `PAYMENT_ORDER_MISMATCH` (tested), and a forged signature cannot bind to another order id.
3. authorized/captured: correct.
4. Coupon counting: counted at fulfilment under a coupon row lock, no double count; the per-user and max-uses rules leak (Important 2).
5. Idempotency interceptor: correct canonicalisation and scoping; takeover CAS is sound; only Minor 4 and 5.
6. Zero-sum / exact paise: verified for the three worked examples and odd amounts.
7. Self-purchase / already-owned: USER sellers fine; ORG gap (Minor 1); already-owned relies on the provider at checkout only, so Phase 3 `onPaid` must be idempotent (see Important 1).
8. onPaid in the tx: yes, rollback and retry tested for a plain Error; broken for 4xx AppErrors via webhook (Important 1).
9. PII/secret leakage: none found.
10. Authorization: correct (buyerId-scoped, 404 for strangers).

### Assessment

**Task quality:** Needs fixes

**Reasoning:** The core ledger/fulfilment/idempotency design is sound and well tested, but the webhook swallow of 4xx fulfilment failures (money taken, no retry, no alert) and the unenforced coupon limits are real money-path defects that should be fixed before Phase 3 plugs in a real provider.
