# Review: Tasks 6 and 7 (hold release + invoices, refunds), 0239f92..8408a2a

### Spec Compliance
- Spec compliant against the briefs and controller rulings (release = PENDING line posted; reversal = negated sale entry with PENDING->AVAILABLE when released; order row FOR UPDATE in release and refund-processed; Razorpay call outside tx; auto-refund on fulfilment_failed; `SKL/{FY}/{000001}`, April-March IST).
- Cannot verify from diff: brief's "payout blocked INSUFFICIENT_BALANCE" after negative AVAILABLE is deferred to Task 9 (implementer says so; Task 9 must carry the assertion).
- Plan-mandated defect: number format `SKL/2026-27/000001` is 18 characters; GST invoice serial number (Rule 46 / GSTR-1 field) is max 16 characters. See I-2.

### Strengths
- Release/refund mutual exclusion is sound: both take the order row lock, release uses SKIP LOCKED + `status='PAID'`, refund reads "released" under the lock; journal unique key backs both. Lock-mutation check in report is real evidence.
- Reversal is an exact line-by-line negation, so it is zero-sum for platform-funded (negative platform revenue line) and creator-funded coupons by construction, and TAX_PAYABLE / GATEWAY_CLEARING are restored.
- Invoice numbering: counter row UPDATE...RETURNING inside the same tx as the invoice insert; duplicate loses on unique key and rolls back its number; number is only ever consumed together with a row; upload is a separate retryable step with sweeper. FY math at IST boundary is correct (31 Mar 23:59 IST -> prior FY).
- Download authz returns identical 404 for missing/unauthorised; presign is key-scoped, 300 s, attachment name sanitised.
- Refund request: row lock on order, partial unique index backstop, 404 for others' orders, non-PAID rejected, Idempotent.

### Issues

#### Critical
None.

#### Important
1. **Hold release ignores live refunds and undelivered orders.** `hold-release.processor.ts:70` selects every PAID order past the cutoff. A buyer who requests on day 6.9 and finance who decides on day 8 leaves the seller's money AVAILABLE (withdrawable once Task 9 lands) while a REQUESTED/APPROVED/PROCESSING refund exists; same for a fulfilment-failed order whose auto-refund is FAILED (order stays PAID, seller credited for nothing delivered, released 7 days later). Failure: seller withdraws, refund processes, AVAILABLE negative, platform out of pocket. Fix: add `NOT EXISTS (refunds live)` and `fulfilmentFailedAt IS NULL` to the selector and re-check under the lock in `releaseOne` (hold stays until refund resolves; a REJECTED/FAILED refund then releases normally). Add a test.
2. **Invoice number is 18 chars (plan-mandated).** `fiscal-year.ts:14`: `SKL/2026-27/000001` exceeds the 16-char GST serial limit, so GSTR-1 upload rejects every invoice. Use e.g. `SKL/26-27/000001` (16). Needs controller decision since the plan fixed the format.
3. **No GST credit note on refund.** Invoice stays valid and untouched after `refund.processed`; the ledger reverses TAX_PAYABLE but no document reduces the taxable value (CGST s.34 requires a credit note, declared in the return of the month). Effect: Skiller over-reports output tax on every refund (including every auto-refund for failed fulfilment, where an invoice is issued at `invoice-handlers.ts` for an order refunded seconds later). Minimum: issue a numbered credit note (own counter or same gap-free series, referencing original invoice) from the `order.refunded` event; also consider not invoicing orders that are auto-refunded. Implementer already flagged this as "decide with CA"; grading is by effect, not by that note.
4. **Unknown refund webhook closed silently.** `refund-handlers.ts:61` `giveUp` only logs and marks processed. A refund issued from the Razorpay dashboard (or one whose id was never stored) means money left, ledger never reversed, order still PAID, and nobody is told. Raise a `FinanceAlerts` entry (kind e.g. REFUND_UNMATCHED) in `giveUp`. Related: lookup is only by `razorpayRefundId`; also resolve by `notes.refundId` from the payload (the code puts it in the Razorpay call) so a crash between Razorpay success and storing PROCESSING (`refunds.service.ts:98`) cannot strand a refund that Razorpay actually made.
5. **Retry after crash depends on an unverified header, and a 4xx on retry fails a real refund.** `refunds.service.ts:98-116`: if `X-Refund-Idempotency` is not honoured, the retry gets 400 ("amount exceeds / already refunded"), `fail()` marks the refund FAILED, and the later genuine `refund.processed` for an id we never stored is dropped (see 4). `fail()` also matches status PROCESSING (`:134`), so a stale concurrent 4xx can flip an in-flight refund to FAILED. Fix: on 4xx during `start`, only fail when status is still APPROVED with no razorpayRefundId, and before failing, fetch the payment's refunds by `notes.refundId` to adopt an existing one.
6. **Hindi / non-Latin names print as blanks or garbage on a legal invoice.** `invoice-document.ts:68` uses built-in Helvetica (WinAnsi only). No crash, but buyer name, seller name and item title in Devanagari are lost. Embed a Unicode TTF (e.g. Noto Sans + Noto Sans Devanagari) and a fallback; add a test with a Hindi name asserting the render succeeds and text is present. Injection: harmless (pdfkit escapes strings; Content-Disposition is sanitised); long names wrap and add pages (comment says single page).

#### Minor
1. `invoice-issuer.ts:117`: subscription invoice date/FY = `clock.now()` at handling time, not the charge time; a charge at 31 Mar 23:59 IST processed after midnight lands in the next FY. Use the charge entry's `createdAt` / payment time.
2. `invoice-issuer.ts:73`: order invoice FY = paidAt, but number allocated at issue time; a delayed issue across 31 Mar issues a number in the closed FY after it may have been reported. Accept or issue within the same FY window.
3. `invoice-issuer.ts:214` / `billing-worker.module.ts`: worker reads `organizations` directly (and bypasses OrganizationsService). Read-only name lookup, but it ties billing to another module's table; export a tiny reader from organizations' index and provide it in the worker (as done for AccountService/ProfilesService).
4. Invoice is titled "TAX INVOICE" with "GSTIN: applied for" and lacks supplier address, place of supply and SAC code; an unregistered supplier cannot issue a tax invoice. Confirm with CA before go-live.
5. FAILED is terminal: `approve` on FAILED returns REFUND_NOT_PENDING, so a refund that failed for e.g. insufficient Razorpay balance can only be redone by the buyer re-requesting; an auto-refund has no re-drive. Consider allowing approve on FAILED (re-start with a new idempotency key).
6. `refund.processed` after `FAILED` with a newer live refund on the same order hits the partial unique index on the status update (`refunds.service.ts:154+`), exhausts retries and is closed. Rare; handle by marking the newer refund REJECTED first or merging.
7. Repeated REJECTED -> re-request loop has no cap within the 7-day window.
8. Release of a zero seller share (commission 100%) posts zero lines every hour if the ledger rejects them (`hold-release.processor.ts` share check is `< 0n`, should skip `<= 0n` and still be marked); unverified.
9. Org-subscription invoices: `buyerUserId` is only `notifyUserId`, other org members cannot download. Org-seller invoices not downloadable by org members (documented).
10. Test gaps: no refund test for platform-funded or creator-funded coupon orders; no FY-boundary test at 31 Mar 23:59 IST vs UTC at issue time; no refund.failed-then-processed test; no test for release skipping an order with a live refund.

### Answers to the ten focus points
1. Double release/refund: not reachable (row lock + journal key). Release-while-refund-pending is the real gap (I-1).
2. Reversal exact and zero-sum including negative platform revenue line; untested for coupon orders (Minor 10).
3. Gap-free and unique: yes. FY boundary correct. Numbers not lost on failed upload: yes (row persists, sweeper). Length violation I-2.
4. Authz correct; URL scoped to key, 300 s.
5. Processed-before-PROCESSING: retried via unknown-id path, ok (but see I-4/I-5). Duplicate: no-op. Failed then processed: reverses correctly, edge Minor 6.
6. Stuck APPROVED recovered by re-approve and 5-min job; 4xx handling risky (I-5).
7. Eligibility: double request, unpaid, others' orders all handled.
8. Module boundary: minor.
9. Credit note: Important (I-3).
10. PDF: no crash, Hindi unreadable (I-6).

### Assessment
**Task quality:** Needs fixes
**Reasoning:** Ledger mechanics, locking and numbering are well built; the blocking items are money/compliance edges: hold released while a refund is live, silent loss of unmatched refund webhooks and fragile retry semantics, 18-char invoice numbers, missing credit note, and unreadable non-Latin names.
