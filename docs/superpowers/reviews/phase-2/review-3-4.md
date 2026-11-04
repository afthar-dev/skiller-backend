# Review: Tasks 3-4 (ae21fb3..6a42ddf), plans/entitlements + creator subscriptions

## Spec Compliance
Verdict: ISSUES FOUND (3 controller-ruling deviations).

Ruling check:
- Org seats exclude owner: DIFFERS. `organizations.service.ts:173-176` seatsUsed = countOrgMembers (owner included, `roles.service.ts:125`) + pending; check(seats+1). Org Starter allows 9 invites, the 10th is refused. Test `plans-entitlements.e2e-spec.ts:133` ("owner + 9 = 10 seats") encodes the old semantics.
- Permission sync additive on existing DBs: DIFFERS. `permission-sync.ts:49-66` seedSystemRoles still `continue`s on an existing role; the diff does not touch permission-sync.ts. finance_admin gets the 5 new keys (`default-roles.ts:27-31`) only on fresh DBs (report admits it).
- charged for CANCELLED/EXPIRED reactivates: DIFFERS. `subscriptions.service.ts:230,255-256` only logs a warning; status and currentPeriodEnd are left unchanged.
- Invoices deferred: OK (paymentId is carried on the subscription.changed event).

Brief check: everything else is present (seed values exact, planFor/limit/check, admin routes with step-up and audit, media + org hooks, Free rows, checkout, webhooks, grace, maintenance, cancel/change/me). Extras, reasonable: GET /v1/plans, updateSubscription client method, INCOMPLETE status, UsageRegistry.
Cannot verify from diff: org-owned media storage. Media is USER-owned; storage_gb for ORG owners is never enforced and the UsageRegistry returns null for ORG. Controller to confirm this is intended until Phase 3.

## Strengths
- Entitlement cache epoch design is correct: epoch read before the DB, a write that races a change lands on an old-epoch key nobody reads; epoch keys have no TTL; value TTL clamped to grace/period end (`entitlements.service.ts:59-77`).
- Every status transition is a conditional updateMany under a FOR UPDATE row lock; ledger keyed by Razorpay payment id so duplicates are no-ops; amount parsed through fromGatewayAmount (`subscriptions.service.ts:205`); GST split via gstSplit with the gst_bps setting.
- Owner scoping: `owned()` filters by ownerType+ownerId, so a USER route cannot touch an ORG subscription and vice versa (404). Org routes need org.manage via orgParam; audience mismatch rejected both ways.
- Plan versions immutable; checkout accepts only the newest version per interval; partial unique index makes Free-row creation concurrency-safe.
- Good e2e coverage of the brief scenarios, including grace boundary +-1 s and idempotent maintenance runs.

## Test-would-it-fail judgement (no RED evidence)
1. Commission snapshot incl. PAST_DUE grace: WOULD FAIL if PAST_DUE were dropped from ENTITLED_STATUSES or grace ignored. Caveat: only planFor is exercised (no order exists until Task 5, which must re-test with a real order), and every read is preceded by a manual `ent.invalidate`.
2. Duplicate charged: WOULD FAIL (journal entry count === 1) if idempotency broke.
3. 84661/15239: WOULD FAIL (exact per-kind amounts incl. clearing -99900).
4. halted -> PAST_DUE -> Free: WOULD FAIL; checks grace = now+3d exactly, second failure notice does not extend it, +-1 s boundary, Free row recreated, repeat maintenance is a no-op.
5. Downgrade scheduled: WOULD FAIL if applied immediately (asserts business/500 bps before period end, pro after maintenance). The webhook path `applyScheduled` (`subscriptions.service.ts:233-240`) is NOT tested.
6. New version vs existing subscriber: WOULD FAIL if resolution used the newest version.
7. storage_gb: WOULD FAIL (600+600 MB on a 1 GB plan, then 400 MB passes; PENDING counted, unit conversion proven). org_seats: would fail if the check were removed, but it asserts the superseded owner-included semantics.
Not covered: epoch stale-write race; concurrent first checkouts (`subscriptions.e2e-spec.ts:89` is sequential and `<= 1`, so it cannot fail on a race); cancelled-then-charged; stale activated/charged after halted; Redis failure; production-side cache invalidation (I7).

## Issues

### Critical
None.

### Important
1. `organizations.service.ts:173-176`, `roles.service.ts:125-130`, test `plans-entitlements.e2e-spec.ts:133`: seats include the owner; contradicts the ruling (Org Starter = 10 invitable, 11th refused). Exclude the owner from the count; update the test (10 ok, 11th refused). countOrgMembers also loads every row to count; use a grouped count.
2. `permission-sync.ts:49-66` (unchanged) with `default-roles.ts:27-31`: existing databases never receive finance_admin's new permissions. Ruling requires an additive grant of default system-role permissions on existing DBs (insert missing role_permissions only, never revoke admin edits). Add the sync step and a test.
3. `subscriptions.service.ts:230,255-256`: a charge for CANCELLED/EXPIRED does not reactivate (ruling) and does not advance currentPeriodEnd, so a paid period is lost. Implement CANCELLED/EXPIRED -> ACTIVE (clear cancelAtPeriodEnd/grace, set period end, supersede other entitled rows, emit event) as a conditional update; test cancelled-then-charged and expired-then-charged.
4. `subscriptions.service.ts:230-251`: PAST_DUE/INCOMPLETE become ACTIVE on ANY activated/charged event, even one with no new payment and no period advance (activated carries no payment). A late or reordered event after `halted` un-halts a failed subscription and clears graceEndsAt, giving paid access with no payment. Require freshness for PAST_DUE -> ACTIVE: a new ledger entry (`postedNew`) or `periodEnd > row.currentPeriodEnd`. Add an out-of-order test (charged, halted, then activated).
5. `subscriptions.service.ts:532-544` (ensureRazorpayPlan) and test `subscriptions.e2e-spec.ts:89`: plan creation is not idempotent. Two concurrent first checkouts of the same paid version both call Razorpay createPlan; the loser leaves a permanent orphan plan (Razorpay has no idempotency key). Serialize per version (SELECT ... FOR UPDATE on the plan_versions row, or an advisory lock, around read-create-store) and make the test concurrent (Promise.all, expect exactly one createPlan call). Same non-atomic reuse window in `startCheckout` (:510-515): a double click can create two Razorpay subscriptions and two INCOMPLETE rows, both payable.
6. `subscriptions.service.ts:406-409`: billing reads the `organizations` table directly (prisma.organization), violating the module boundary. Use OrganizationsService or a small port registered like UsageRegistry (note BillingWorkerModule does not import OrganizationsModule), or carry the owner id in the event payload (`org.created` already has ownerId).
7. Tests never verify production invalidation: every e2e read does `ent.invalidate(...)` first (throughout `subscriptions.e2e-spec.ts`, and `plans-entitlements.e2e-spec.ts:145-146`). If SubscriptionsService stopped invalidating after writes, everything still passes while users see stale plans for up to 60 s. Add a test that warms the cache via planFor, applies a webhook/cancel, then reads again with no manual invalidate.

### Minor (9)
- `entitlements.service.ts:61`: `redis.get(epochKey)` has no `.catch` while the other Redis calls do; a Redis blip fails every limit check instead of falling back to the DB.
- `entitlements.service.ts:135`: ACTIVE with cancelAtPeriodEnd but null currentPeriodEnd is entitled forever.
- `subscriptions.service.ts:249-251`: when `activated` lands before `charged`, the first payment emits "activated" then "renewed" (double event; the invoice keys on the second).
- `subscriptions.service.ts:156-166`: Razorpay updateSubscription runs before the DB booking (a lost race leaves Razorpay scheduled but DB not; retry heals); change on a cancelAtPeriodEnd subscription calls Razorpay on an already-cancelling sub and may surface as a 500.
- `subscriptions.service.ts:205`: payment currency and amount are not checked against the plan price (webhook is signed; low risk).
- `plan-catalog.ts` FREE_FALLBACK `versionId: "free-default"` is not a real FK id; Task 5 must tolerate it when snapshotting commission.
- Migration has no CHECK for commissionBps 0..10000 or pricePaise >= 0; schema.prisma also carries an unrelated whitespace reformat of OutboxEvent.
- `organizations.service.ts:149-155`: invite rate-limit token is consumed before the seat check, and the seat check is not atomic with invite creation (same class as the acknowledged storage race).
- Report is stale on seats (says owner counts, 9 invites) and says Task 4 service code shipped in the Task 3 commit (commit split not clean).

## Assessment
**Task quality:** Needs fixes

**Reasoning:** Core money paths (ledger split, idempotency, conditional transitions, grace, epoch cache, owner scoping) are sound and well tested, but three controller rulings are not implemented (seats, additive permission sync, reactivation), a stale activated/charged event can resurrect a halted subscription, Razorpay plan creation is racy, and billing reads the organizations table directly.
