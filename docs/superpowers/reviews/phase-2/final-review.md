# Phase 2 (money core): final whole-branch review

Range `365d41d..c700b36` (18 commits) on `phase-2-money`. Reviewer: Opus, final seat. This was a read-only review done in passes, by area: ledger and money, webhooks, checkout and fulfilment, hold and invoices, refunds and credit notes, payout accounts, payouts, reconciliation and finance admin, coupons, wiring and CI. Tasks 10 and 11 had no task-level review, so I read them line by line.

Verification I ran:
- `pnpm test` (unit): 27 suites and 184 tests, all green.
- `scripts/check-schema-drift.mjs` against a fresh throwaway `postgres:16-alpine` container: "schema matches migrations". Prisma ignores the four hand-written partial unique indexes, so CI's drift gate passes.
- I did not run the integration or e2e suites. They need Testcontainers; the Task 10–11 report says they were green, 695 tests.

## Strengths

- **The ledger core is right.** `LedgerService.post` (`src/modules/wallet/ledger.service.ts:45-98`) is the only write path.
  - It rejects unbalanced entries, and its `ON CONFLICT DO NOTHING` journal insert keeps the caller's transaction usable.
  - A duplicate key carrying different lines raises `LEDGER_DUPLICATE_MISMATCH`.
  - Balance rows are locked in sorted order, the closed-account check happens under that lock, and `nonNegative` is checked under the same lock.
  - Every money movement I traced is keyed `(refType, refId, description)`: sale, hold_release, refund, payout_request/reject/settled/failed/reversed, and subscription charge. So no retry, duplicate or out-of-order path can post twice.
- **Every entry I traced is zero-sum and exact:**
  - Sale (`sale-split.ts:49-58`): `-total + seller + feeNet + feeTax - platformDiscount = 0` in both coupon modes. The fee is floored per decision 4.
  - Refund (`refunds.service.ts:267-284`): the exact negation of the stored sale lines, with the seller line moved from PENDING to AVAILABLE when the hold has been released.
  - Hold release reuses the stored PENDING line and never recomputes it.
  - Payout settle and reverse handle TDS symmetrically (`payouts.service.ts:443-447`, `:489-493`).
  - Subscription charge is `-amount / net / tax` via `gstSplit`.
- **Money-out safety holds.**
  - Payout request spends AVAILABLE through `nonNegative` under the balance row lock, so two concurrent requests cannot both pass. A negative AVAILABLE blocks every request (decision 7). Both are tested (`payouts.e2e-spec.ts:199`, `:274`).
  - The payout row snapshots its destination account. Approve and send both re-check it (replaced, unverified, flagged, cooling down) and auto-reject with `PAYOUT_ACCOUNT_CHANGED`.
  - The RazorpayX call happens outside any transaction, with `X-Payout-Idempotency` = `reference_id` = the payout id. The recover path looks the payout up before creating one, and a 4xx is confirmed by lookup before the payout is failed.
  - The approver must differ from the requester.
- **Webhook intake is solid.**
  - Two distinct secrets, enforced at config time (`config.schema.ts:45`).
  - Constant-time HMAC over the raw body. Dedupe on `(provider, eventId)` and on `(provider, bodySha256)` closes the replay-with-fresh-header hole.
  - Payout and fund_account handlers are scoped to `RAZORPAYX`.
  - Bank details in RazorpayX payloads are cut down before storage (but see I-1).
  - Unknown refunds and payouts are retried, then closed with a finance alert. There are no 500 loops.
- **Reconciliation (Task 10) reuses the webhook code.**
  - Stuck payouts and refunds go through `PayoutsService.onProcessed/onReturned` and `RefundsService.onProcessed/onFailed` (`reconciliation.service.ts:157-179`). There is no second implementation that could diverge.
  - IST day windows are correct: India has no DST, `istDayRange` is a half-open window, `previousIstDay` is right for the 02:00 IST cron, and the BullMQ scheduler uses `tz: Asia/Kolkata`.
  - The invariant SQL is set-based and runs in one snapshot per statement: total = 0, balance = SUM(lines) per account (including accounts with no balance row), and unbalanced entries for the day.
  - Books-side misses are looked up with `fetchPayment` before they are reported, which handles the day boundary.
- **Admin surface.** Every new route has `@RequirePermission` or `@AuthenticatedOnly`. Every money mutation has step-up and an audit row. Coupon code, kind and value are immutable, and a used coupon cannot be deleted. Creator coupons are owner-scoped in the WHERE clause.
- **Wiring.**
  - `WorkerModule` schedules all seven new maintenance jobs.
  - `worker.module.int-spec.ts` pins the scheduler keys, the job names per queue and all 16 webhook types.
  - Both Dockerfiles copy `assets/fonts`.
  - CI smoke env gets distinct webhook secrets.
  - The OpenAPI e2e fails if any `*Paise` field is not a string.

## Issues

### Critical

None.

### Important

**I-1. Full UPI ids of payees are stored in `webhook_events.payload`.**
- Where: `src/modules/billing/webhook-scrub.ts:17`
- What is wrong: RazorpayX fund-account objects describe a VPA as `{ username, handle, address }`; the `fund_account.validation.completed` payload is one example. `scrubPayoutDetails` masks only `address` and copies `username` and `handle` untouched. `username@handle` is the full UPI id. This breaks the Task 8 rule ("stores masked data only") and the PII focus.
- Why the tests miss it:
  - `webhook-scrub.spec.ts:10` builds `vpa: { address }` only.
  - The fake (`razorpayx.fake.ts:24,133`) emits `vpa: { address }` only.
  - So the unit test and the "DB never contains the VPA" e2e pass without the scrub covering the real shape.
- Fix: replace the whole `vpa` object with `{ address: maskVpa(address) }`, dropping every other key. Make the fake and the spec emit `username` and `handle`.

**I-2. Full bank account number and PAN can reach Sentry.**
- Where: `src/common/observability/sentry.ts:6`, together with `src/common/errors/error.filter.ts:39`
- What is wrong:
  - `@sentry/nestjs` `^11.10.0` is initialised with defaults. Its HTTP integration attaches incoming request bodies to error events by default (`maxIncomingRequestBodySize: "medium"`), and `sendDefaultPii: false` does not remove `request.data`.
  - The error filter reports every status of 500 or above.
  - So a `PUT /v1/wallet/payout-account` that ends in `PAYOUT_GATEWAY_ERROR` (502, whenever RazorpayX is down) sends `bank.accountNumber` and `pan` in clear to Sentry.
- This is deferred minor M-9 from review-8-9. The SDK version makes it real, so it should be fixed before merge.
- Fix: `Sentry.init({ ..., integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" })] })`, or a `beforeSend` that deletes `event.request.data`. Then verify with one test event in staging, because the SDK default is from documentation.

**I-3. A platform-scoped `org.manage` grant (super_admin) can redirect any organization's money.**
- Where: `src/modules/billing/wallet.controller.ts:147-156` (PUT org payout account) and `:191-202` (org payout request), together with `src/modules/rbac/permission.service.ts:82` ("A platform grant satisfies any org")
- Failure scenario:
  1. super_admin holds every key, including `org.manage`.
  2. With only their own step-up they replace an organization's payout account with their own bank account. A replacement starts a 24 h cooldown, but no owner is notified (M-7, still deferred).
  3. After the cooldown they request the organization's whole AVAILABLE balance.
  4. A finance_admin approves it in routine review: the approver sees only the account's last 4 digits, and the self-approval rule passes because the requester is a different person.
- Fix:
  - Money-moving org routes should require an org-scoped grant (an actual `org_owner` of that org), not any platform grant, for example `RequirePermission("org.manage", { orgParam, orgScopedOnly: true })`.
  - Notify the owner (USER) or all org owners (ORG) by in-app message and email whenever a payout account is changed.

### Minor (new in this review)

1. **The settlement check practically never fires.** `reconciliation.service.ts:284-294`
   - It compares one day's settled gross with the *all-time* clearing inflow and never subtracts earlier settlements.
   - Fix: compare cumulative settled with cumulative booked, or use Razorpay's settlement-recon API.
   - The implementer called the check "weak"; this is weaker than described.
2. **A manual rerun can find a new mismatch without notifying anyone.** `reconciliation.service.ts:121`
   - The alert dedupe key is `date:status`. A rerun the same day that finds a *different* mismatch sends no notification (Sentry still fires).
   - Fix: put a digest of the mismatch kinds and counts in the key.
3. **The manual reconciliation run is synchronous and a failed run is not audited.** `admin-finance.controller.ts:64-70`
   - It runs inside the HTTP request: up to `MAX_PAGES` Razorpay pages, plus up to 200 sequential provider fetches. That risks a proxy timeout.
   - The audit row is written only after success, so a failed run leaves no trace.
   - Fix: enqueue the run, or audit before running.
4. **`MANUAL_REVIEW` payouts have no way out.**
   - `payouts.service.ts:436`: no endpoint resolves a `MANUAL_REVIEW` payout, so its funds stay in PAYOUT_LOCKED until someone edits the database.
   - `admin-finance.service.ts:88`: the summary's pending payouts leave it out.
   - Fix: add a finance resolve action (settle or unlock, step-up, audit) and count `MANUAL_REVIEW` in the summary.
5. **Review flags are described three different ways.**
   - The DUPLICATE_PAN alert (`payout-accounts.service.ts:176`) says "Payouts are not blocked".
   - `blockReason` (`:215`) blocks them, and the README says flags block them.
   - `payableAccount` (`:196`) ignores `reviewFlag`, so a flagged owner can request a payout and lock funds that approval then auto-rejects.
   - Fix: refuse at request time and correct the alert text.
6. **Provider scoping is one-sided.** `payment.*`, `refund.*` and `subscription.*` handlers (`order-handlers.ts:36`, `refund-handlers.ts:40`, `subscription-handlers.ts`) also accept events that arrive on `/razorpayx`.
   - The risk is low because of the distinct secrets.
   - Fix: scope them to `RAZORPAY`, mirroring the payout side.
7. **Buyer PII stays in stored webhooks.** `webhooks.controller.ts:80` stores Razorpay payment entities (buyer VPA, email, phone) unscrubbed in `webhook_events`.
   - Fix: scrub them too, or set a retention period for `webhook_events`.
8. **A new captured payment on a REFUNDED order is not flagged.** `fulfilment.service.ts:74` answers `ALREADY_PAID` without a `DuplicatePayment` row or an alert. Only the nightly reconciliation catches it, as `UNRECORDED_PAYMENT`.
9. **Segregation of duties is thin.**
   - `payouts.service.ts:218` compares only `requestedBy`. A finance_admin who owns the payee org can approve a payout another member of that org requested.
   - `refund-requests.service.ts:69` has no buyer ≠ approver check.
10. **Platform coupons have no cap (policy).** `coupons-admin.service.ts:95`: one finance_admin can create an uncapped platform-funded coupon for a single item. The seller still gets 90% of list, so platform revenue funds up to list − ₹1 per sale. Two colluding accounts can turn this into withdrawable seller balance.
    - Fix: cap platform-funded discounts at the fee, or require a second person to approve them.
11. **Payout accounts can stay PENDING forever.** An account whose `fund_account.validation.*` webhook was lost is never polled. Add it to reconciliation's stuck section.
12. **The scrub tests do not exercise the real payload shape** (test honesty, the same root as I-1). `webhook-scrub.spec.ts` and the RazorpayX fake model a simpler payload than RazorpayX sends. The tests pass whether or not `username` and `handle` are scrubbed.

Minor count, new in this review: **12**.

## Triage of the deferred minors

| Group | Item | Decision |
| --- | --- | --- |
| 1-2 | Multi-post lock order per tx | Defer. No current transaction posts two entries over overlapping accounts in different orders. Re-check when Phase 3 adds multi-entry flows. |
| 1-2 | No DB zero-sum / immutability trigger | Defer to go-live hardening. The nightly invariant check now detects drift. |
| 1-2 | No int64 cap | Defer. Request schemas cap at 15 digits. |
| 1-2 | Zero-amount lines | Defer. They occur only at 100% commission and are harmless because entries are keyed. |
| 1-2 | Webhook secret `min(1)`, webhook routes unthrottled | Defer to go-live (config hardening). |
| 1-2 | Test gaps (₹999 vector, whitespace raw body) | Defer. |
| 3-4 | Redis `get` without `.catch` in entitlements | Defer. A Redis blip fails checkout entitlement reads; fix in Phase 3. |
| 3-4 | Cancelled at period end with no period end entitled forever; double activated/renewed event; Razorpay call before DB; charge amount unchecked; FREE_FALLBACK id; no CHECK constraints; invite seat race; stale report | Defer all. None moves money wrongly. |
| 5 | Idempotency route not normalised (trailing slash); stale takeover can create a second order | Defer. Two orders, each paid at most once, never double fulfilment. |
| 5 | `onPaid` ordering and lock hold time; alerts after commit; REFUNDED shown as `ALREADY_PAID`; verify logic in the controller; test gaps; purge ≈ 25 h | Defer. |
| 6-7 | Subscription invoice FY from handling time | Resolved: `invoice-issuer.ts` now dates by `entry.createdAt`. |
| 6-7 | Order invoice numbered at issue time but dated `paidAt` | **Needs CA** (see the GST section). Not a merge blocker. |
| 6-7 | Worker reads the `organizations` table | Defer (module boundary). |
| 6-7 | "TAX INVOICE" while unregistered; missing fields | **Needs CA, go-live blocker** (see below). Not a merge blocker. |
| 6-7 | FAILED refund terminal; processed-after-FAILED hits the partial unique; no re-request cap; zero-share release; org-member downloads; non-Devanagari scripts; test gaps | Defer. The processed-after-FAILED case alerts `REFUND_WEBHOOK_FAILED`; nothing silent. |
| 8-9 | M-1 sanitised errors, M-2 four-eyes | Resolved in `1ab4138`. |
| 8-9 | M-3 `createPayout` status ignored / no poll | Resolved by Task 10's stuck-PROCESSING poll (2 h). |
| 8-9 | M-4 `reference_id` filter with `count=10` | Defer. Already on the README go-live checklist. |
| 8-9 | M-5 overlapping re-drive runs | Defer. Safe because of the idempotency key. |
| 8-9 | M-6 short-VPA masking, `KYC_PEPPER` falling back to `OTP_PEPPER` | Defer to go-live. Recommend requiring `KYC_PEPPER` in production. |
| 8-9 | M-7 no NAME_MISMATCH alert; **no notification on payout account change** | **Fix before merge, together with I-3.** The 24 h cooldown only helps if the owner is told. |
| 8-9 | M-8 test clock isolation | Defer. |
| 8-9 | **M-9 Sentry request bodies** | **Fix before merge.** It is I-2. |
| 8-9 | M-10 no per-owner cap on `PUT payout-account` (each call costs a penny-drop) | Defer to go-live. |
| 8-9 | M-11 no `onExhausted` handler for `fund_account.validation.*` | Defer. Fold into new minor 11. |
| 8-9 | M-12 `reject` writes `approvedBy`; M-13 refund after lock (by design) | Defer. |

## GST and compliance (needs CA, policy rather than code defects)

- **"TAX INVOICE" without a GSTIN.** `invoice-document.ts:50-53` prints "TAX INVOICE" with "GSTIN: applied for" while `platform_gstin` is empty. An unregistered supplier cannot issue a tax invoice (Rule 46). A CA would reject this until the GSTIN is filled; the README go-live checklist covers filling it.
- **One GST line instead of the CGST/SGST or IGST split.** The invoice prints a single "GST (18%)" line. Rule 46 wants the CGST + SGST split for intra-state supplies and IGST for inter-state ones.
- **Place of supply.** It falls back to the platform's own state, because the buyer's state is never collected.
- **One document for two suppliers.** The invoice bills the buyer the full course price, names the seller under "Sold by", and taxes only the platform fee. A CA may require two documents: the platform's fee invoice, and the seller's own invoice or bill of supply.
- **GST TCS under section 52.** E-commerce operators must collect 1% TCS on sellers' net taxable supplies. Nothing in the plan or the code does this, and it is not on the README CA checklist; add it to the checklist.
- **TDS under 194-O.** It is computed on the payout amount (`payouts.service.ts:158`). Section 194-O is levied on the gross amount of sales, at credit or payment, whichever comes first. The CA should confirm the base, not only the rate.
- **Numbering order.** An invoice is dated `paidAt` but numbered when it is issued, so a delayed issue can produce numbers that are not in date order.
- **Already on the checklist.** The credit-note series `SKC/yy-yy/nnnnnn` and the SAC `998439` are already listed for CA confirmation.

## Declined to judge

- Per-settlement matching of settlements against sales. The ruling defers it; I only noted (Minor 1) that the aggregate check is weaker than described.
- Whether GMV should include REFUNDED orders. The implementer ruled PAID-only, and the summary documents it.
- No proration on plan upgrades. Plan ruling (Task 4).
- The first payout account has no cooldown. Controller ruling (Task 8-9). I-3 is a separate path.
- Refunds after release taking AVAILABLE negative, and a payout already locked still being paid. Decision 7, approved by the user.
- The real RazorpayX and Razorpay response and webhook shapes. Unverifiable from the code, and already a README go-live item.
- The `super_admin` "holds every key" model itself (Phase 1 design). I-3 covers only its effect on org money routes.
- Org-subscription and org-seller invoice downloads by other org members. Documented Phase 2 limitation.

## Merge verdict

**With fixes.** The money core is correct end to end: zero-sum, keyed, race-safe, with no over-withdrawal and no double send found. What blocks the merge is the three Important items, all PII or money-out authorisation:
1. **I-1:** full UPI ids in stored webhooks.
2. **I-2:** bank account numbers and PANs reaching Sentry (= M-9).
3. **I-3:** super_admin redirecting org payouts, plus the payout-account-change notification (M-7).

Each is a small, local change. The GST items are go-live blockers for the CA, not merge blockers.
