# Review: Tasks 8 + 9 (payout accounts / KYC, payouts) — 7d26f8f..9dc5abd

Line numbers are file lines in the new files (src/modules/billing/...), derived from the diff (+-2).

## Spec Compliance

- Issues found (see I-1, I-4, I-5). Everything else in the two briefs is implemented and the money paths I traced are sound.
- Cannot verify from diff: RazorpayX payload shapes / `reference_id` list filter / `X-Payout-Idempotency` retention window (unverified against test mode, implementer says so); that `payout.approve` / `wallet.view_any` are granted to finance_admin only (permissions file not in diff); Sentry request-body capture (see M-9); openapi.json (Task 12).

## Strengths

- Balance check is the ledger's `nonNegative` rule evaluated after the update under the balance row locks (ledger.service.ts diff, `nonNegative` block), so two concurrent requests queue and the second fails; a negative AVAILABLE can never pass because min payout > 0. Mutation-tested.
- Payout request: TDS floor-rounded, frozen with `tdsBps` on the row, net > 0 enforced, RazorpayX gets net; account check + payout insert + ledger post in one tx under the same per-owner advisory lock as the account change (payouts.service.ts:124-160) so the account cannot change between check and insert.
- State machine is done right: every transition is a conditional update under `FOR UPDATE` (`lockAndLoad`), ledger keys are (PAYOUT, id, step), approve is idempotent, reject only from REQUESTED, terminal states are never rewritten, late `processed` after REVERSED/FAILED is ignored.
- Ledger exactness: processed (-amount / +net clearing / +tds tax, TAX line omitted when 0), unlock on failed/rejected/reversed-before-paid, reversal-after-paid undoes clearing, tax and credits AVAILABLE by the full amount; each entry sums to 0. `lifetimeWithdrawn` counts PAID only, so a reversal drops out.
- Send: RazorpayX call outside any tx; idempotency key and reference_id = payout id; retries (`attemptsMade>0`), the 5-minute re-drive and webhook-by-reference all adopt instead of re-creating; timeouts/network errors are not 4xx so they retry rather than fail; 4xx is double-checked with a reference lookup before funds are released.
- PII: only IFSC, last4, masked VPA, PAN last4 + keyed HMAC stored; webhook payloads scrubbed before insert (mutation-tested); provider error text is not echoed on the PUT path; audit before/after use the masked view; log redaction to depth 3 (RED evidence); duplicate-PAN alert carries last4 only.
- Webhook route for RazorpayX uses `config.razorpayx.webhookSecret` (webhooks.controller.ts, unchanged lines + diff).

## Issues

### Critical (Must Fix)

None found. I could not construct a path that over-withdraws, pays twice (given RazorpayX honours the idempotency key / reference lookup), or stores a full PAN/account number.

### Important (Should Fix)

**I-1. Destination account is not re-checked at approval/send, and finance cannot see it. (scenario 3)** `payouts.service.ts:252-256` (`send`) loads `payout.payoutAccountId` and pays it without checking `status`; `approve` (183-197) does not look at the account either; `PayoutView` (toPayoutView, ~L50-65) has no account info, so finance approves blind. Snapshot at request is correct, but the snapshotted account may be INACTIVE (owner replaced it, typically because the old one is closed, an org owner left, or it was found compromised) or carry `reviewFlag` DUPLICATE_PAN/NAME_MISMATCH by approval time. Concrete case: org replaces its account on Monday because the old beneficiary left; a REQUESTED payout from Sunday is approved Tuesday and goes to the old (INACTIVE) beneficiary. Fix: in `approve` (under the lock) and in `send`, require the snapshotted account to be non-INACTIVE and VERIFIED (else reject the approval with a clear error; at send, fail-and-unlock or leave APPROVED for finance), and add `payoutAccount` (masked: type, last4/vpaMasked, ifsc, status, reviewFlag) to the admin payout view. Add a test for "account swapped between request and approval".

**I-2. Payout/fund-account webhook handlers ignore `event.provider`. (scenario 7)** `payout-handlers.ts:46-49`, `payout-account-handlers.ts` (`handle`) register by event type only and `WebhookDispatcher.dispatch` is provider-agnostic. A body carrying `payout.processed` / `payout.reversed` / `fund_account.validation.completed` signed with the plain RAZORPAY webhook secret (route `/v1/webhooks/razorpay`) is stored with provider RAZORPAY and settles payouts / verifies accounts. That defeats the purpose of the separate RazorpayX secret. Nothing in config requires the two secrets to differ either. Fix: handlers return early (or throw Unrecoverable) unless `event.provider === "RAZORPAYX"`; reject identical secrets in `config.schema.ts`; test it.

**I-3. Amount-mismatch `payout.processed` retries then gives up unprocessed (known divergence from controller ruling "alert + stop retrying").** `payouts.service.ts:358-366, 372-381`: after raising the alert it throws `AppError(PAYOUT_AMOUNT_MISMATCH)`, so the job burns all attempts, then `giveUp` (payout-handlers.ts:127) raises a second, differently-keyed alert and leaves the webhook row unprocessed. The money state is safe (nothing settled, funds stay PAYOUT_LOCKED), but it is noise and leaves a permanently "unprocessed" event. Fix: record the mismatch, alert once, return normally (or throw `UnrecoverableError`) and mark the event processed with `lastError`. Note a null `entity.amountPaise` skips the check entirely (358); treat missing amount on `processed` as a mismatch too.

**I-4. First-ever account gets the 24 h cooldown (known divergence; spec says only CHANGES).** `payout-accounts.service.ts:153` sets `cooldownUntil = now + 24h` unconditionally; every creator's first withdrawal is delayed a day on top of validation. Fix: `cooldownUntil = live ? now+24h : now` (and keep carrying over the later of old cooldown if a change happens during an existing cooldown). Existing tests that assert the cooldown on first accounts and the `creatorWithAccount` 24 h clock jump (test/support/payouts.ts:70-77) will need updating, which also removes the global clock advance (see M-8).

**I-5. UPI payouts have no amount cap; mode selection incomplete. (scenario 8)** `payouts.service.ts:148`: any VPA account gets `UPI` regardless of amount. RazorpayX UPI payouts have a per-transaction limit (INR 1 lakh in the docs I know; verify against the live account), so a larger withdrawal is sent, refused with a 4xx, and ends FAILED with funds returned and a finance alert, after the creator waited for approval. Fix: reject (or split nothing, just reject) a UPI payout above the UPI limit at request time with a clear error (`PAYOUT_UPI_LIMIT`), make the limit a setting; test it. IMPS (<= 5,00,000 net) / NEFT switch itself is correct.

**I-6. Missing tests for the highest-risk scenarios you listed.**
- No test that a payout goes to the snapshotted account, nor of an account swap between request and approval (ties to I-1).
- No test for concurrent approve x2 (only sequential), nor for the job racing the 5-minute re-drive, nor for webhook-processed racing the send (the fake supports lost responses, so this is feasible with `Promise.all`).
- No test for a provider-mismatched webhook (I-2).
- No test that org A's owner cannot read/request on org B's wallet (only "stranger" on the org's own slug), nor that admin payout endpoints reject finance without step-up on reject specifically beyond the combined test.
Hence the risky races rest on code reading only.

### Minor (Nice to Have)

M-1. `payouts.service.ts:296-310` (`failUnsent`) stores raw provider `err.message` in `failureReason` and it is sent to the creator in the `payout.failed` notification (`payout-handlers.ts` payout.failed handler). Provider text can be internal ("insufficient balance in account", account hints). Store a code + generic line for the creator; keep the raw text in the finance alert only.
M-2. No four-eyes: `approve` does not forbid `actorId === payout.requestedBy` (a finance_admin who is also a creator can approve their own payout). Not required by the plan; consider it for money-out.
M-3. `createPayout` response status is ignored (`send`, ~L286): a synchronous `failed`/`rejected`/`cancelled` is stored as PROCESSING and relies on a webhook. `fetchPayout` is never used; there is no poll for PROCESSING payouts whose terminal webhook was lost (and no `payout.cancelled`/`creation_failed` handling). Funds stay safely locked, but it needs the Task 11 reconciliation to cover PROCESSING older than N hours. Confirm that task has it.
M-4. `findPayoutByReference` (razorpayx.client.ts:192) uses `count=10` and filters client side; if the provider ignores the `reference_id` filter the match can fall off the page, returning null and (after a 4xx on create) failing a payout that exists. Low likelihood (needs a 4xx on create AND the payout to exist), but it is the path that could cause a double payment; verify the filter in RazorpayX test mode before go-live.
M-5. `redriveStuck` sends up to 50 payouts sequentially, each up to ~3 x 15 s during an outage; runs every 5 min with `attempts: 1`, so runs can overlap (safe because of the idempotency key/lookup, but wasteful). Add a lock or process with limited concurrency.
M-6. `maskVpa` (kyc.ts) keeps the whole local part when it is 2 characters or fewer; use a minimum of one hidden char. `KYC_PEPPER` falling back to `OTP_PEPPER` couples two secrets, and rotating either silently breaks duplicate-PAN detection (old hashes); require KYC_PEPPER in production or document it.
M-7. `NAME_MISMATCH` sets `reviewFlag` but raises no finance alert and does not hold approval (only DUPLICATE_PAN alerts); `panNameMatch` actually compares bank-registered name vs declared holder name, not PAN name (documented by the implementer; the column name misleads). Account change sends no "your payout account changed" notification/email to the owner, which is the main anti-takeover signal.
M-8. Test isolation: `creatorWithAccount` advances the shared fake clock by 24 h + 1 s per call (test/support/payouts.ts:70-77), expiring every other session in the file, and `finance()` re-logs in by comparing elapsed fake time. Tests are order- and call-count-sensitive (a token fetched before a `ready()` call is dead after it). Jest isolates files, so impact is within `payouts.e2e-spec.ts` / `payout-accounts.e2e-spec.ts` only. Goes away with I-4 for the first-account case.
M-9. Sentry: `reportException` captures the exception only; if the SDK's default request-data integration attaches request bodies for 5xx (`PAYOUT_GATEWAY_ERROR` is a 502 on `PUT payout-account`), the raw account number and PAN could reach Sentry. Cannot verify from the diff; add a `beforeSend` that drops `request.data` or confirm the SDK version does not capture bodies.
M-10. `PUT payout-account` is not rate limited beyond the global throttler and each call creates a RazorpayX contact, fund account and a 1 INR penny-drop; a hijacked session (step-up needed) can burn money. Add a per-owner daily cap. Not `@Idempotent` (known; double submit makes two rows, tested).
M-11. `onValidation` throws a plain Error for an unknown fund account (orphans left when the DB tx fails after RazorpayX succeeded) and no `onExhausted` handler is registered for `fund_account.validation.*`, so exhausted events are silent.
M-12. `reject` writes `approvedBy/approvedAt` on a rejected payout; use separate decidedBy/decidedAt or null them to avoid confusing the re-drive filter (currently safe because it filters on status APPROVED).
M-13. By design (plan decision 7) a refund after a payout request is locked still lets the payout go out, so the platform can be left holding a negative AVAILABLE with the money already paid; flagging only because scenario (1) asked about it.

## Assessment

**Task quality:** Needs fixes

**Reasoning:** The money core is carefully built and I found no path to over-withdraw, double-send (assuming RazorpayX honours its idempotency key / reference lookup) or persist full PAN/account numbers; ledger entries for processed/failed/reversed (including TDS and reversed-after-paid) are exact. It needs fixes before merge for the unchecked destination account at approval/send, provider-agnostic payout webhook handlers, the two known divergences (first-account cooldown, mismatch retry loop), the missing UPI limit, and tests for the account-swap and race scenarios.
