# Review: Phase 2 Tasks 1-2 (365d41d..f45714c)

Line refs: `ledger.service.ts` L = file line; `webhooks.controller.ts` L = file line (new files, counted from the diff hunk).

## Spec Compliance

- Spec compliant. Every listed file and interface is present: models and the NULLS NOT DISTINCT index, `money.ts`, `LedgerService.post/balance/balancesFor`, `AccountsService`, platform seed, `user.became_creator` and `org.created` handlers (event enqueued in the same tx in `organizations.service.ts`), Razorpay client + fake, `@Public` webhook routes, `WebhookEvent`, dispatcher, processor, and the five config keys.
- The dedicated `billing` queue with outbox job options is a reasonable reading of "outbox-class queue".
- Cannot verify from the diff:
  - Task 5 handlers must treat webhook payload amounts (stored as JSON numbers) via a safe-integer to bigint conversion. `num()` in `razorpay.client.ts:106` does this for API responses; the webhook payload path has no helper yet.
  - Plan decision 4 ("seller never loses a paisa to rounding against the platform's favour") conflicts with the brief's "round half-up on `part`" (fee). At exact halves, half-up rounds the fee UP, against the seller. The brief wins here; the human should confirm.

## Strengths

- `post()` validates everything (balanced, non-empty, bigint, accounts exist, not closed) before any write.
- The entry insert uses `ON CONFLICT DO NOTHING RETURNING`, so a duplicate never raises and never poisons the caller's tx.
- Balance rows are locked in one `ORDER BY ... FOR UPDATE` statement.
- The balance row backstop insert is sorted, and increments use Prisma's atomic `increment`.
- `money.ts` is small and correct. Everything is bigint, there is no float path, and `fromApi` is strict.
- Webhook verification checks the signature before anything else, over `req.rawBody`, with a constant-time compare.
- Tests are real DB and HTTP tests (10 concurrent same-key posts, opposite-order concurrency, a property test, 3 concurrent webhook duplicates). The mutation check on the signature guard is good evidence.

## Judgement on the named risks

1. **Can `post()` persist an unbalanced entry, partial lines or a duplicate?** No.
   - Sum is checked in bigint at L44-45, before any write. All writes run inside the caller's tx, so any later failure rolls back the whole entry.
   - Same ref raced by two txs: Postgres makes the second `INSERT ... ON CONFLICT` wait for the first tx to end (L56-58).
     - If the first commits, the second gets 0 rows, re-reads the committed row under READ COMMITTED and returns `duplicate: true` (L60-63).
     - If the first rolls back, the second inserts normally.
   - No DB-level backstop exists (see Minor 5).
2. **Deadlock with mixed account order?** Not within one `post()` call. The ids are sorted at L47, and the lock statement is `ORDER BY "accountId" FOR UPDATE` (L70).
   - The backstop insert is also sorted.
   - Across several `post()` calls in one tx, ordering is not global (Minor 1).
3. **Does the duplicate path leave the caller's tx consistent?** Yes.
   - It returns at L63, before lines or balances are touched, and raises nothing.
   - Caveat: it does not check that the duplicate carries the same lines (Important 2).
4. **Money as number or float?** No.
   - Everything in the ledger and `money.ts` is bigint, and the API form is a string.
   - The only conversion to `number` is at the Razorpay boundary: `toApiAmount` (`razorpay.client.ts:97`) rejects negative values and values above MAX_SAFE_INTEGER, and `num()` (`razorpay.client.ts:106`) rejects non-safe integers.
   - No `BigInt.prototype.toJSON` patch exists, and nothing in the diff serialises a bigint row to JSON.
5. **Rounding.** `divRoundHalfUp = floor((2n+d)/(2d))` is correct half-up for n >= 0 and d > 0 (`money.ts:16`).
   - Edges: 0 gives 0; `splitBps(1n,1000)` gives 0/1; 5n gives 1; 15n gives 2; odd values and huge bigints are fine.
   - Worked examples: `gstSplit(10000n,1800)` = 8475/1525. This is correct: 1e8/11800 = 8474.58.
   - ₹999 = 99900 paise: 999,000,000/11800 = 84661.017, so net 84661 and tax 15239. This matches the plan.
   - The ₹999 vector is not in the tests (Minor 7).
6. **Webhook signature.**
   - Raw bytes: `req.rawBody` is passed straight to the HMAC (`webhooks.controller.ts:55`, `signature.ts:16`). JSON is parsed only after verification.
   - Constant-time: `timingSafeEqual` after a length check.
   - Header names: `x-razorpay-signature` and `x-razorpay-event-id` are correct.
   - Oversized bodies: the Express default of 100 kb applies; there is no custom limit in `src`.
   - Replay: see Important 1.
7. **Does the endpoint leak whether an event id exists?** No, not to anyone without the secret.
   - The signature is checked first. A duplicate returns the same 200 `{received:true}` as a first delivery.
   - Only secret holders can reach the event-id branch.
8. **Property test.** It really generates balanced random entries (`ledger.service.int-spec.ts:132-155`).
   - 1 to 4 random signed legs, plus a balancing leg on `pool[0]`. It includes duplicate accounts inside an entry, negative amounts and zeros.
   - It runs 20 runs x 10 entries = 200 entries (asserted).
   - It checks `balance == SUM(ledger_lines)` per account and that the whole pool nets to zero.
   - Sequential only, which is fine; concurrency has its own tests.

## Issues

### Critical (Must Fix)
None.

### Important (Should Fix)

1. **`webhooks.controller.ts:62` and `:76`: replay protection hangs on an unsigned header.**
   - The signature covers only the body. The dedupe key `x-razorpay-event-id` is a header and is not covered.
   - Anyone who captures one valid signed body (logs, proxy, a leaked dashboard test event) can re-send it with a fresh event-id header. Each send becomes a new `WebhookEvent` row and a new job, so the handler runs again.
   - Razorpay's signed body has no nonce or timestamp check either.
   - Fix: also dedupe on the body: store `bodyHash = sha256(rawBody)` with `@@unique([provider, bodyHash])`, or on a provider entity id such as `payload.payment.entity.id` plus the event type.
   - A legitimate Razorpay retry has an identical body, so this is safe.
   - Handlers must also stay idempotent on business keys. The plan's unique `razorpay_payment_id` helps; a test for the fresh-event-id replay would lock this in.

2. **`ledger.service.ts:60-63`: a duplicate key with different lines is silently accepted.**
   - Reusing `(refType, refId, description)` with different accounts or amounts, for example a second partial refund reusing the description "refund", returns `{duplicate:true}` and drops the money movement. The caller sees success.
   - Contract-conformant, but the failure is silent and affects money.
   - Fix: on the duplicate path, compare the existing lines as a multiset of (accountId, amount) with the incoming ones and throw `LEDGER_DUPLICATE_MISMATCH` (500) if they differ. Add a test.

### Minor (Nice to Have)

1. **Lock order is per call, not per tx (`ledger.service.ts:70`).** Two txs that post several entries in a different order can deadlock, because balance locks are held to commit. The same applies to waiting on a same-key entry insert. Document "one entry per tx, or a fixed order", or add a batch `postMany` that sorts across entries.
2. **Closed-account TOCTOU (`ledger.service.ts:53`).** `closedAt` is a plain read taken before the balance lock. The implementer flagged this. Cheapest fix: read `closedAt` after the `FOR UPDATE`, and have the future close operation lock the same row.
3. **Validation runs before the dedupe check (`ledger.service.ts:44-54` vs `:56`).** A retry of an already-posted entry throws `LEDGER_ACCOUNT_CLOSED` if an account was closed in between, instead of returning `duplicate:true`.
4. **`webhooks.controller.ts:55-56`: a non-JSON content type with no raw body throws a plain Error.** An unauthenticated caller can trigger a 500 and Sentry noise (the same pattern exists in the Resend controller). Return a 400 `WEBHOOK_SIGNATURE_INVALID` instead.
5. **No DB backstop for "only `post()` writes".** There is no deferred zero-sum constraint trigger and no UPDATE/DELETE-block trigger on `ledger_lines` and `journal_entries`. Worth adding before go-live.
6. **Unbounded magnitude.** `fromApi` (`money.ts:42`) accepts digit strings of any length, and `post()` accepts any bigint. A value above int64 becomes a raw DB overflow (500). Cap at 2^63-1 and bound the string length.
7. **Test gaps.**
   - No ₹999 (99900 -> 84661/15239) vector, and no large-value `gstSplit` test.
   - No test with whitespace or key-order different JSON, to prove the signature is over raw bytes. It only works because the fake signs the exact string.
8. **Zero-amount lines are stored.** Reject them, or filter them, to keep the ledger clean.
9. **Process and hardening.**
   - Task 2 was written implementation-first, with mutation-check evidence substituted for a RED run. Acceptable, but noted.
   - Webhook secrets are only `min(1)`; require a minimum length.
   - The public webhook routes are unthrottled; a per-IP limit would cap HMAC work.
10. **READ COMMITTED is documented but not asserted.** Under REPEATABLE READ or SERIALIZABLE, the duplicate path raises a serialization error instead of returning `duplicate:true`. Consider a guard.
11. **Rounding policy.** Plan decision 4 versus the brief's half-up on the fee; see Spec Compliance. The human should decide.

## Assessment

**Task quality:** Needs fixes (2 Important; both are small and local).

**Reasoning:** The ledger core is sound: validation precedes writes, idempotency is non-poisoning, locking is deterministic within a call, there is no float path, and the rounding matches the plan's worked examples. The two gaps are replay dedupe keyed on an unsigned header, and silent acceptance of a same-key post with different lines.
