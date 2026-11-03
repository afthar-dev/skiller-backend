# Phase 2 — Money Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Razorpay checkout, a double-entry wallet ledger with plan-based commission, hold release, refunds, creator SaaS subscriptions with entitlements, RazorpayX payouts with admin approval, nightly reconciliation, and wallet/finance APIs.

**Architecture:** Two new modules — `billing` (orders, coupons, plans, subscriptions, entitlements, Razorpay client + webhooks, refunds, invoices) and `wallet` (ledger, hold release, payout accounts, payouts, reconciliation). `LedgerService.post()` is the only write path for money. Everything sellable is resolved through a `SellableRegistry` so Phase 3 (courses) plugs in without touching billing. Builds on the Phase 1 foundation (outbox, RBAC, step-up, settings, audit, mail, notifications).

**Tech Stack:** As Phase 1, plus `razorpay` Node SDK (CJS) behind an injectable client interface, `pdfkit` (CJS) for invoices, `fast-check` (dev) for ledger property tests.

**Spec:** `docs/superpowers/specs/2026-11-03-skiller-platform-redesign-design.md` §11, §12 (and §15 idempotency, §16 webhook verification). Phase 1 ledger: `docs/superpowers/plans/2026-11-03-phase-1-foundation-ledger.md` (all its rulings still bind).

## Global Constraints

- Money is integer **paise** (`BigInt` in Prisma, `bigint`/string in JSON — API returns `{ amountPaise: "123400", currency: "INR" }` as decimal strings). No floats anywhere in money code.
- `LedgerService.post(tx, entry)` is the ONLY write path for ledger lines and balances. Every entry sums to 0. `account_balances` updated in the same transaction, rows locked `FOR UPDATE` in a deterministic order (by account id) to avoid deadlocks.
- `Idempotency-Key` header required on `POST /v1/checkout`, `POST /v1/wallet/payouts`, `POST /v1/orders/:id/refund-requests`; stored responses replayed for 24 h (spec §15).
- Razorpay webhooks: raw body signature verified (HMAC-SHA256 with webhook secret), stored in `webhook_events` (unique `(provider, event_id)`), processed by a queue job; processing is idempotent.
- `fulfilOrder()` is called by both client verify and the `payment.captured` webhook; unique `razorpay_payment_id` makes the second a no-op.
- Commission rate (basis points) is snapshotted on the order from the seller's active plan version at checkout. Default Free plan 1000 bps (10%).
- Hold: `hold_days` platform setting (default 7) before PENDING → AVAILABLE.
- Step-up required for payout request, payout-account change, refund approval, plan/commission edits.
- All admin money actions write audit rows; outbox events for cross-module effects (`order.paid`, `order.refunded`, `subscription.changed`, `payout.settled`, `payout.failed`).
- Every route has `@RequirePermission` / `@Public` / `@AuthenticatedOnly`. New permission keys via `definePermissions` registered in `permissions.ts`.
- Outbox handlers idempotent (at-least-once).

## Decisions taken for this plan (controller rulings — confirm with your CA before go-live)

1. **GST:** list prices are GST-inclusive for buyers. On a course sale, GST (18%) applies to the platform fee only: `fee = round(net × commission_bps / 10000)`; `platform_revenue = round(fee × 100 / 118)`; `tax_payable = fee − platform_revenue`; seller gets `net − fee`. Subscriptions: whole price is platform revenue incl. 18% GST, split the same way. Rate stored as setting `gst_bps` (default 1800).
2. **TDS:** setting `tds_bps` default 0 (Section 194-O may require 1% — set once your CA confirms); when > 0, payout posts TDS to `TAX_PAYABLE` and pays the remainder.
3. **Seed plans (admin-editable):** Free ₹0, 1000 bps, limits basic; Pro ₹999/month, 700 bps; Business ₹2,999/month, 500 bps. ORG plans: Org Starter ₹4,999/month, 700 bps, 10 seats; Org Growth ₹14,999/month, 500 bps, 50 seats. Yearly versions at 10× monthly.
4. **Rounding:** all splits round half-up at the paise level; any remainder goes to the seller line (seller never loses a paisa to rounding against the platform's favour).
5. **Refund window:** 7 days and < 30% of course consumed (consumption check is a `RefundEligibility` provider registered by Phase 3; Phase 2 default allows within 7 days).
6. **Minimum payout:** setting `min_payout_paise` default 50000 (₹500).
7. **Negative balance:** refunds after release may take AVAILABLE negative; payouts blocked while AVAILABLE ≤ 0.

## Review Focus

1. **Webhook arrives before client verify, or twice, or out of order** (`payment.captured` before `order.paid` handler, `refund.processed` for an unknown refund) — expected: single fulfilment, unknown references stored and retried later, never 500 loops. Test in Task 5.
2. **Two concurrent payout requests draining the same balance** — expected: only funds actually available lock; second gets `INSUFFICIENT_BALANCE`. Test in Task 9.
3. **Refund requested after funds were released and paid out** — expected: AVAILABLE goes negative, next payouts blocked until positive; ledger still sums to 0. Test in Task 7.
4. **Plan downgrade mid-period / payment failure** — expected: downgrade takes effect at period end; `PAST_DUE` keeps access 3 days then falls back to Free; commission for new orders uses the plan active at checkout. Test in Task 4.
5. **Amount tampering** — client-sent amounts are ignored; price recomputed server-side; Razorpay order amount must equal `total_paise` on verify (mismatch → `PAYMENT_AMOUNT_MISMATCH`, order FAILED, alert). Test in Task 5.

---

## File Structure

```
src/modules/
  billing/
    money.ts                 # Paise helpers: add, sub, splitBps, toApi, fromApi
    razorpay.client.ts       # interface + real impl (orders, payments, refunds, subscriptions, plans)
    razorpay.fake.ts         # test fake (in-memory, emits webhook payloads)
    webhooks.controller.ts   # POST /v1/webhooks/razorpay (raw body, signature)
    webhook.processor.ts     # queue job: dispatch stored webhook_events
    sellable.registry.ts     # SellableProvider interface + registry
    coupons.service.ts
    checkout.service.ts      # create order + Razorpay order
    fulfilment.service.ts    # fulfilOrder(), ledger posting, outbox order.paid
    refunds.service.ts
    plans.service.ts  subscriptions.service.ts  entitlements.service.ts
    invoices.processor.ts    # pdfkit → R2 private
    billing.controller.ts  admin-billing.controller.ts
    permissions.ts  billing.module.ts  billing-worker.module.ts  index.ts
  wallet/
    ledger.service.ts        # post(), balances, accounts
    accounts.service.ts      # ensureSellerAccounts(), platform accounts
    hold-release.processor.ts
    payout-accounts.service.ts  razorpayx.client.ts  razorpayx.fake.ts
    payouts.service.ts  payout.processor.ts
    reconciliation.processor.ts
    wallet.controller.ts  admin-wallet.controller.ts
    permissions.ts  wallet.module.ts  wallet-worker.module.ts  index.ts
```

---

### Task 1: Money primitives and ledger

**Files:** `src/modules/billing/money.ts`, `src/modules/wallet/ledger.service.ts`, `accounts.service.ts`, `wallet.module.ts`, `index.ts`; schema models; tests `money.spec.ts`, `ledger.service.int-spec.ts`.

**Interfaces — produces:**
- Models (spec §12): `LedgerAccount(id, ownerType USER|ORG|PLATFORM, ownerId?, kind AVAILABLE|PENDING|PAYOUT_LOCKED|GATEWAY_CLEARING|PLATFORM_REVENUE|TAX_PAYABLE|REFUNDS, currency "INR", closedAt?) @@unique([ownerType, ownerId, kind])` (NULLS NOT DISTINCT), `JournalEntry(id, refType, refId, description, createdAt) @@unique([refType, refId, description])`, `LedgerLine(id, entryId, accountId, amountPaise BigInt)`, `AccountBalance(accountId @id, balancePaise BigInt, updatedAt)`.
- `money.ts`: `type Paise = bigint`; `splitBps(amount: Paise, bps: number): { part: Paise; rest: Paise }` (round half-up on `part`); `gstSplit(fee: Paise, gstBps: number): { net: Paise; tax: Paise }` (net = round(fee × 10000 / (10000 + gstBps))); `toApi(p: Paise): string`; `fromApi(s: string): Paise` (rejects non-integer, negative where noted).
- `LedgerService.post(tx, { refType, refId, description, lines: { accountId, amountPaise }[] }): Promise<{ entryId; duplicate: boolean }>` — rejects sum ≠ 0 (`LEDGER_UNBALANCED`), empty lines, closed accounts (`LEDGER_ACCOUNT_CLOSED`); duplicate `(refType, refId, description)` → returns existing entry with `duplicate: true` and changes nothing (idempotency); locks balance rows `FOR UPDATE` ordered by account id.
- `LedgerService.balance(accountId)`, `balancesFor(ownerType, ownerId): Record<kind, Paise>`.
- `AccountsService.ensureSellerAccounts(tx, ownerType, ownerId)` (AVAILABLE, PENDING, PAYOUT_LOCKED), `platformAccount(kind)`; platform accounts seeded.
- Handlers: `user.became_creator` → ensureSellerAccounts(USER); `org.created` (add event in organizations create, same tx) → ensureSellerAccounts(ORG). Idempotent.

- [ ] **Step 1: Failing tests:** `splitBps(100000n, 1000)` → part 10000n; `splitBps(1n, 1000)` → part 0n rest 1n; `gstSplit(10000n, 1800)` → net 8475n tax 1525n; `fromApi("1.5")` throws. Ledger: unbalanced → `LEDGER_UNBALANCED`; same ref posted twice → one entry, second `duplicate: true`; balances equal sum of lines after 200 random balanced entries (fast-check property, 20 runs); 20 concurrent posts touching the same two accounts → balances exact, no deadlock.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: double-entry ledger and money primitives`.

---

### Task 2: Razorpay client and webhook intake

**Files:** `razorpay.client.ts`, `razorpay.fake.ts`, `webhooks.controller.ts`, `webhook.processor.ts`; model `WebhookEvent(id, provider RAZORPAY|RAZORPAYX, eventId, type, payload Json, receivedAt, processedAt?, attempts, lastError?) @@unique([provider, eventId])`; config `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAYX_ACCOUNT_NUMBER`, `RAZORPAYX_WEBHOOK_SECRET`.

**Interfaces — produces:**
- `RazorpayClient` (DI token `RAZORPAY_CLIENT`): `createOrder({ amountPaise, receipt, notes })`, `fetchPayment(id)`, `createRefund(paymentId, { amountPaise, notes })`, `createPlan(...)`, `createSubscription(...)`, `cancelSubscription(id, atCycleEnd)`, `verifyPaymentSignature({ orderId, paymentId, signature }): boolean` (HMAC-SHA256 `orderId|paymentId` with key secret, constant-time).
- `POST /v1/webhooks/razorpay` and `/v1/webhooks/razorpayx` (`@Public`): verify `X-Razorpay-Signature` over raw body (constant-time) → 400 `WEBHOOK_SIGNATURE_INVALID`; event id from `x-razorpay-event-id` header; insert `WebhookEvent` (duplicate → 200 no-op); enqueue `webhook.process` job (`jobId = webhookEvent.id`) on `outbox`-class queue; respond 200 fast.
- `WebhookDispatcher.on(type, handler)` registry; processor marks `processedAt`, increments attempts, stores `lastError`; unknown types acknowledged and marked processed.
- Fake client records calls and builds signed webhook payloads for tests (`fake.webhook(type, payload) → { body, headers }`).
- [ ] **Step 1: Failing tests:** valid signature stored + job enqueued; bad signature 400 and nothing stored; same event id twice → one row; dispatcher handler failure → retried, `lastError` set; verifyPaymentSignature true/false vectors.
- [ ] **Step 2–4.** **Step 5:** Commit `feat: razorpay client and webhook intake`.

---

### Task 3: Plans, plan versions, entitlements

**Files:** `plans.service.ts`, `entitlements.service.ts`, `admin-billing.controller.ts` (plans part), seed additions; models `Plan`, `PlanVersion` (spec §11.2).

**Interfaces — produces:**
- Seed plans exactly as "Decisions §3"; `PlanVersion.limits` JSON keys: `max_published_courses`, `storage_gb`, `reels_per_day`, `analytics_level` (`basic|standard|advanced`), `creator_coupons` (bool), `org_seats`. Free: 3 / 5 / 3 / basic / false / 0. Pro: 50 / 100 / 20 / standard / true / 0. Business: unlimited (`null`) / 500 / 50 / advanced / true / 0. Org Starter: null / 500 / 50 / standard / true / 10. Org Growth: null / 2000 / 100 / advanced / true / 50.
- `EntitlementsService.planFor(ownerType, ownerId): { planKey, versionId, commissionBps, limits }` (Free fallback if no ACTIVE/TRIALING/grace subscription); `limit(owner, key)`, `check(owner, key, currentUsage): void` → `ENTITLEMENT_LIMIT_REACHED` 403 with `details { key, limit }`; cached in Redis 60 s, busted on subscription change.
- Admin: `GET/POST /v1/admin/plans`, `POST /v1/admin/plans/:id/versions` (new version; never mutate an existing one) — `billing.plans.manage` + step-up + audit.
- Wire Phase 1 hooks: media `createUpload` checks `storage_gb` against owner's used bytes (sum of READY + in-flight declared sizes); org invite checks `org_seats`.
- [ ] **Step 1: Failing tests:** creator with no subscription → Free, 1000 bps; new version doesn't change existing subscriber's commission; upload exceeding storage_gb → `ENTITLEMENT_LIMIT_REACHED`; 11th org invite on Org Starter → `ENTITLEMENT_LIMIT_REACHED`.
- [ ] **Step 2–4.** **Step 5:** Commit `feat: plans and entitlements`.

---

### Task 4: Creator subscriptions (Razorpay Subscriptions)

**Files:** `subscriptions.service.ts`, `billing.controller.ts` (subscription routes), webhook handlers; model `Subscription` (spec §11.2) plus `graceEndsAt?`, `scheduledPlanVersionId?`.

**Interfaces — produces:**
- `user.became_creator` / `org.created` → Free subscription row (ACTIVE, no Razorpay id). Idempotent.
- `POST /v1/subscriptions/checkout { planVersionId }` (creator or org_owner via `orgParam`) → creates Razorpay subscription → returns `{ subscriptionId, razorpaySubscriptionId, keyId }`. Upgrade from Free takes effect on first `subscription.charged`.
- Webhooks: `subscription.activated`/`charged` → ACTIVE, `current_period_end` from payload, ledger entry (clearing → PLATFORM_REVENUE + TAX_PAYABLE per gstSplit), invoice job, outbox `subscription.changed`; `subscription.halted`/`pending` → PAST_DUE, `graceEndsAt = now + 3 days`; `subscription.cancelled`/`completed` → CANCELLED/EXPIRED at period end; grace expiry job moves PAST_DUE → EXPIRED → Free.
- `POST /v1/subscriptions/:id/cancel` → `cancel_at_period_end`; `POST /v1/subscriptions/:id/change { planVersionId }` → upgrade immediately (new Razorpay subscription, old cancelled at cycle end, no proration in Phase 2 — ruling), downgrade scheduled for period end (`scheduledPlanVersionId`).
- `GET /v1/subscriptions/me` → current plan, status, period end, limits and usage.
- [ ] **Step 1: Failing tests (Review Focus 4):** charged webhook activates Pro and posts ledger split (₹999 → revenue 84661 paise, tax 15239 paise); halted → PAST_DUE with access for 3 days, then Free; downgrade scheduled not immediate; order created during PAST_DUE grace uses Pro's 700 bps; duplicate charged webhook → one ledger entry.
- [ ] **Step 2–4.** **Step 5:** Commit `feat: creator subscriptions`.

---

### Task 5: Sellables, coupons, checkout, fulfilment

**Files:** `sellable.registry.ts`, `coupons.service.ts`, `checkout.service.ts`, `fulfilment.service.ts`, `billing.controller.ts` (checkout routes); models `Order`, `OrderItem`, `Coupon`, `CouponRedemption`, `IdempotencyRecord(key, userId, route, requestHash, response Json, status, createdAt) @@unique([userId, route, key])`.

**Interfaces — produces:**
- `SellableProvider { type: string; describe(itemId): Promise<{ title; pricePaise; sellerOwnerType; sellerOwnerId; purchasable: boolean; reason? }>; onPaid(tx, order): Promise<void>; onRefunded(tx, order): Promise<void> }`; `SellableRegistry.register(provider)`. Phase 2 registers a test-only `TEST_ITEM` provider in tests; Phase 3 registers `COURSE`.
- `@Idempotent()` interceptor: requires `Idempotency-Key` (400 `IDEMPOTENCY_KEY_REQUIRED`), same key + same body hash → replay stored response; same key + different body → 409 `IDEMPOTENCY_KEY_REUSED`; in-flight → 409 `IDEMPOTENCY_IN_PROGRESS`; 24 h retention.
- Coupons: `PERCENT|FLAT`, `funded_by CREATOR|PLATFORM`, `max_uses`, `expires_at`, scope (`ALL|SELLER|ITEM`); creator coupons need entitlement `creator_coupons`; redemption counted on fulfilment, not checkout.
- `POST /v1/checkout { itemType, itemId, couponCode? }` (`@Idempotent`) → server-side price → order CREATED with `commission_bps` snapshot (Entitlements.planFor seller) and `gst_bps` snapshot → Razorpay order (`amount = total_paise`, `receipt = order.id`) → `{ orderId, razorpayOrderId, amountPaise, currency, keyId }`. Buying own item → `CHECKOUT_SELF_PURCHASE`; already owned → provider's reason.
- `POST /v1/checkout/verify { orderId, razorpayOrderId, razorpayPaymentId, signature }` and webhook `payment.captured` → `FulfilmentService.fulfil(orderId, paymentId)`: verify Razorpay payment amount == `total_paise` and status captured (else `PAYMENT_AMOUNT_MISMATCH`, order FAILED, Sentry + notify finance_admin); in one tx: order PAID (conditional `WHERE status='CREATED'`), coupon redemption, ledger entry, `provider.onPaid`, outbox `order.paid`; second call → returns PAID no-op.
- Ledger lines for course sale (net = total incl. creator-funded discount applied; platform-funded discount handled per spec §12): `GATEWAY_CLEARING −total`, seller `PENDING +sellerShare`, `PLATFORM_REVENUE +feeNet`, `TAX_PAYABLE +feeTax` (+ `PLATFORM_REVENUE −platformDiscount` / seller `+platformDiscount` when platform-funded coupon). Seller share computed on list price for platform-funded coupons (seller still gets 90% of list).
- `payment.failed` webhook → order FAILED (if CREATED). Orders CREATED > 24 h → EXPIRED by maintenance job.
- `GET /v1/orders` (buyer), `GET /v1/orders/:id`.
- [ ] **Step 1: Failing tests (Review Focus 1, 5):** ₹1,000 sale at 1000 bps → seller PENDING 90000, revenue 8475, tax 1525, clearing −100000; webhook before verify → one fulfilment; verify after webhook → 200 PAID; amount mismatch → FAILED + no ledger; client-supplied amount ignored; idempotency replay returns same orderId; reused key with different body → 409; platform-funded 20% coupon on ₹1,000 → buyer pays 80000, seller still 90000; self-purchase blocked.
- [ ] **Step 2–4.** **Step 5:** Commit `feat: checkout, coupons and fulfilment`.

---

### Task 6: Hold release and invoices

**Files:** `hold-release.processor.ts`, `invoices.processor.ts`; model `Invoice(id, orderId?, subscriptionId?, number @unique, objectKey, totalPaise, taxPaise, issuedAt)`.

**Interfaces — produces:**
- Hourly job: for each PAID order with `paidAt ≤ now − hold_days` and no `released` entry → ledger entry `refType=ORDER refId=id description=hold_release`: seller PENDING −share / AVAILABLE +share. Idempotent via journal unique key. Notification "Earnings available".
- Invoice job on `order.paid` / subscription charge: sequential number `SKL/{FY}/{000001}` (per financial year April–March, gap-free via a counter row locked FOR UPDATE), PDF (seller, buyer, item, GST breakup on platform fee) to R2 private `invoices/{id}.pdf`; `GET /v1/invoices/:id/download` → short-lived signed URL (buyer, seller, `billing.view_any`).
- [ ] **Step 1: Failing tests:** release only after hold_days (FakeClock); changing `hold_days` setting applies to not-yet-released orders; run twice → one entry; invoice numbers sequential across concurrent orders, reset in new FY; other user cannot download → 404.
- [ ] **Step 2–4.** **Step 5:** Commit `feat: hold release and invoices`.

---

### Task 7: Refunds

**Files:** `refunds.service.ts`, routes; model `Refund(id, orderId, amountPaise, status REQUESTED|APPROVED|PROCESSING|PROCESSED|REJECTED|FAILED, reason, requestedBy, decidedBy?, razorpayRefundId?, createdAt)`.

**Interfaces — produces:**
- `RefundEligibility` provider per sellable type (Phase 2 default: within 7 days of paidAt).
- `POST /v1/orders/:id/refund-requests { reason }` (`@Idempotent`, buyer) → REQUESTED or `REFUND_NOT_ELIGIBLE`.
- `POST /v1/admin/refunds/:id/approve|reject` (`billing.refund` + step-up + audit) → approve: Razorpay refund → PROCESSING; webhook `refund.processed` → PROCESSED: reversal ledger entry (from PENDING if not released, else from AVAILABLE — may go negative), `provider.onRefunded`, order REFUNDED, outbox `order.refunded`; `refund.failed` → FAILED, notify finance.
- Full refunds only in Phase 2 (ruling).
- [ ] **Step 1: Failing tests (Review Focus 3):** refund before release reverses PENDING; refund after release + payout → AVAILABLE negative, ledger balanced, payout request blocked `INSUFFICIENT_BALANCE`; duplicate `refund.processed` → one reversal; unknown refund id in webhook → stored, retried, no crash.
- [ ] **Step 2–4.** **Step 5:** Commit `feat: refunds`.

---

### Task 8: Payout accounts and KYC

**Files:** `payout-accounts.service.ts`, `razorpayx.client.ts`, `razorpayx.fake.ts`; model `PayoutAccount` (spec §12.1) + `panLast4`, `panNameMatch`, `status PENDING|VERIFIED|FAILED`.

**Interfaces — produces:**
- `RazorpayXClient`: `createContact`, `createFundAccount(bank|vpa)`, `validateFundAccount` (penny drop / VPA validation), `createPayout({ fundAccountId, amountPaise, mode IMPS|UPI|NEFT, referenceId, idempotencyKey })`, `fetchPayout`.
- `PUT /v1/wallet/payout-account { type, bank: { ifsc, accountNumber, holderName } | upi: { vpa }, pan }` (creator/org_owner, step-up, audit) → stores masked data only (account last 4, IFSC, VPA masked, PAN last 4); full numbers sent to RazorpayX only; validation result via webhook `fund_account.validation.completed`.
- PAN required before first payout; changing payout account resets VERIFIED and blocks payouts 24 h (`PAYOUT_ACCOUNT_COOLDOWN`) — anti-fraud.
- [ ] **Step 1: Failing tests:** DB never contains full account number or PAN (assert on raw row); validation webhook → VERIFIED; change → cooldown enforced; non-creator → 403.
- [ ] **Step 2–4.** **Step 5:** Commit `feat: payout accounts`.

---

### Task 9: Payouts

**Files:** `payouts.service.ts`, `payout.processor.ts`, `wallet.controller.ts`, `admin-wallet.controller.ts`; model `Payout` (spec §12.1) + `tdsPaise`, `mode`.

**Interfaces — produces:**
- `POST /v1/wallet/payouts { amountPaise }` (`@Idempotent`, step-up) → requires VERIFIED account, no cooldown, `amount ≥ min_payout_paise`, `amount ≤ AVAILABLE` checked under the balance row lock → ledger AVAILABLE −amount / PAYOUT_LOCKED +amount → REQUESTED; notify finance_admin.
- `POST /v1/admin/payouts/:id/approve|reject` (`payout.approve` + step-up + audit) → reject unlocks (reverse entry); approve → APPROVED → `payout.send` job → RazorpayX payout (`referenceId = payout.id`, idempotency key = payout.id) → PROCESSING.
- Webhooks `payout.processed` → PAID: entry PAYOUT_LOCKED −amount / GATEWAY_CLEARING +(amount − tds) / TAX_PAYABLE +tds; outbox `payout.settled`, notify creator; `payout.reversed|failed|rejected` → REVERSED/FAILED: PAYOUT_LOCKED −amount / AVAILABLE +amount; notify.
- `GET /v1/wallet/me` (balances per kind as strings, lifetime earned/withdrawn), `GET /v1/wallet/ledger` (paginated lines with refType/description), `GET /v1/wallet/payouts`.
- [ ] **Step 1: Failing tests (Review Focus 2):** two concurrent payouts for the full balance → one REQUESTED, other `INSUFFICIENT_BALANCE`; below minimum → `PAYOUT_BELOW_MINIMUM`; reject unlocks; processed with tds_bps 100 on ₹1,000 → TAX 1000 paise; reversed returns funds; duplicate processed webhook → one entry; approve twice → one RazorpayX call.
- [ ] **Step 2–4.** **Step 5:** Commit `feat: payouts`.

---

### Task 10: Reconciliation and finance admin

**Files:** `reconciliation.processor.ts`, `admin-wallet.controller.ts` (reports), `admin-billing.controller.ts` (orders, coupons).

**Interfaces — produces:**
- Nightly job (02:00 IST): fetch Razorpay settlements + payments for the previous day; compare captured payments to PAID orders/charged subscriptions and settlement amounts to GATEWAY_CLEARING movements; record `ReconciliationRun(id, date, status OK|MISMATCH, details Json)`; mismatch → Sentry + notification to `finance_admin` holders.
- Invariant check in the same job: total of all ledger lines == 0 and `account_balances` == sum of lines per account (alert on drift).
- Admin: `GET /v1/admin/finance/summary?from&to` (GMV, platform revenue, tax payable, payouts paid, pending payouts, active paid subscribers) — `finance.view`; `GET /v1/admin/orders`, `GET /v1/admin/payouts`, `GET /v1/admin/refunds` (filters, paginated); coupons CRUD for platform coupons (`billing.coupons.manage`, audit).
- [ ] **Step 1: Failing tests:** seeded mismatch (payment captured in fake, no PAID order) → MISMATCH run + notification; drifted balance row → alert; summary numbers equal ledger sums for a seeded dataset.
- [ ] **Step 2–4.** **Step 5:** Commit `feat: reconciliation and finance admin`.

---

### Task 11: Wiring, OpenAPI, README

**Files:** `permissions.ts` registrations, worker modules, boot tests, `openapi.json`, README (Razorpay/RazorpayX setup, webhook URLs, GST/TDS settings, CA checklist), `.env.example`.

- [ ] **Step 1: Failing tests:** worker boot test lists new handlers (webhook dispatcher, hold release, invoices, payouts, reconciliation, grace expiry); API boot test passes; openapi contains `/v1/checkout`, `/v1/wallet/me`, money fields documented as string.
- [ ] **Step 2–4.** **Step 5:** Commit `chore: phase 2 wiring, openapi, docs`.

## Phase 2 exit check

- [ ] Razorpay test mode: buy a TEST_ITEM, see seller PENDING 90%, hold release at +7 days (setting lowered to 0 for the check), payout via RazorpayX test mode reaches PAID.
- [ ] Subscribe to Pro in test mode; next sale uses 700 bps.
- [ ] Reconciliation run OK for the day.
