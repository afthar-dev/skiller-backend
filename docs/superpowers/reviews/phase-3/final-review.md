# Phase 3 (courses): final whole-branch review

Range `0538715..c429ad6` (18 commits), branch `phase-3-courses`. Reviewer: Opus, read-only. I reviewed it in passes by area: access, money, integrity, user content, boot, tests. Task 11 (d7e13e7, c429ad6) had no task-level review, so I read all of it line by line. Lockfiles and `openapi.json` were not reviewed.

Checks I ran, in addition to reading the code:
- `prisma migrate diff --from-schema-datamodel --to-schema-datamodel --script` (Prisma 6.19.3) on two scratch schemas. This confirmed how Prisma groups changes to one table into a single statement (see Important 1).
- `ts-node` loads of each module barrel loaded first (`courses`, `rbac`, `media`, `users`, `organizations`). All of them load without throwing.
- A deeper check of `design:paramtypes` by load order did not finish in time. No result is claimed from it.

## Strengths

- **One access decision.** `CourseAccessRules.learnAccess` (course-access-rules.ts:58-70) is the single gate for course content. It is used by:
  - the playback policy (course-playback.policy.ts:24-31)
  - the learn course and lesson endpoints
  - progress (`trackable`)
  - quiz view and attempts, with the preview rule forced off (quiz-attempts.service.ts:100)
  - Q&A read and post
  - the review gate

  Nothing is cached. ORG_SEAT access also requires a live `org_learner` grant. Previews never write progress. I found no learner-content path that bypasses it. The author and studio paths are covered separately: `CoursePolicy.loadForRead` admits authors plus `course.review` holders, as ruled.
- **Money integration is narrow and correct.**
  - `CourseSellable` only describes the item and grants or revokes enrolments. Fulfilment ignores later unpublish, flag or archive.
  - `grant` is idempotent: ON CONFLICT plus a row lock. A second, different purchase throws 4xx, which Phase 2 auto-refunds.
  - `revokeForOrder` is scoped to the order id, so a late refund event for an old order cannot take away a newer purchase.
  - `CourseRefundEligibility` composes the platform window with the < 30% rule and is registered in both processes.
  - `BillingReports.sellerRevenueForItem` reads the ledger rather than orders. It counts seller PENDING and AVAILABLE lines of the `sale` and `refund` entries. This matches `postReversal`, which debits AVAILABLE after the hold has been released (refunds.service.ts:267-284). Hold-release entries are excluded by description, so they are not double-counted.
- **Progress, completion and certificates happen exactly once.**
  - All of a learner's progress writes serialise on their enrolment row.
  - The completion UPDATE is guarded (`completedAt IS NULL ... RETURNING`), so `course.completed` is emitted once.
  - Certificates are protected by the partial unique `certificates_live_key`, a re-check under the enrolment lock, and an event-keyed notification.
  - Revocation runs in the same transaction as the end of the enrolment.
- **User content handling.**
  - Markdown is validated and rejected with a real CommonMark parser, including a depth cap and checks on reference definitions.
  - Plain text is sanitised (NFC, controls and bidi removed).
  - Certificates use `PENDING_NAME`, so an email-derived name never reaches a PDF or the public verify page.
  - Catalog cursors are HMAC-signed, the keyset values are range-checked, and Postgres class-22 errors map to 400.
- **Lifecycle.**
  - Edits are locked while a course is in review.
  - Moderators cannot act on their own courses, on both the course and the content paths.
  - The entitlement is checked at submit and again at approval, under an advisory lock per owner.
- **Boot coverage.**
  - Every new event type and job has a deliberate entry in the worker `HANDLED` map.
  - The worker spec checks the COURSE provider, the refund rule and all three maintenance jobs.
  - The API boot test exercises the real route table.
- **Task 11 quality.** The ORG quota change is small and attributable (`orgId` on the asset, purpose and role checks, attach rule tightened on both sides). Analytics are aggregated in SQL and bucketed by IST day, with tests at the IST day boundary.

## Critical

None.

## Important

### 1. The schema-drift guard hides real drift on the `courses` table

- **Where:** scripts/check-schema-drift.mjs:11 and :36
- **What is wrong:** `KNOWN_RAW_COLUMNS = ["ratingShown"]` throws away any diff block that contains `"ratingShown"`. Prisma writes every column change on one table as a single `ALTER TABLE` statement. I confirmed this with Prisma 6.19.3: adding a column and changing `ratingShown` produced:

  ```
  ALTER TABLE "courses" ADD COLUMN "newCol" TEXT,
  ALTER COLUMN "ratingShown" SET DEFAULT 0;
  ```

  as one block.
- **How it fails:** a later change adds or alters any `courses` column in `schema.prisma` but forgets the migration. The real `ADD COLUMN` sits in the same block as the expected `ratingShown` noise, so the whole block is filtered and CI reports "schema matches migrations". Production then misses the column, and Prisma queries fail at runtime.
- **Fix:** filter at clause level, not block level.
  1. Split each `ALTER TABLE` block into its comma-separated clauses.
  2. Drop only clauses that match the exact expected `ALTER COLUMN "ratingShown" ...` text.
  3. Fail if anything is left.

  Apply the same treatment to the index list: match the exact `DROP INDEX "<name>";` / `CREATE INDEX "<name>" ...` statements, not `includes`. Add a unit test that feeds a combined block like the one above and expects a failure.
- **This answers the brief's question:** yes, the drift script can hide real drift.

## Minor

1. **Lock-order deadlock between a refund or seat revocation and an inline progress recompute.**
   - Where: enrolments.service.ts:98-100 and 117-119; curriculum.service.ts:98-127, 138-165, 176-198; progress.service.ts:139.
   - Failure:
     - Curriculum edits take the course row lock first, then lock active enrolments (`recomputeCourse` → `lockEnrolments`).
     - `revokeForOrder` and `revokeOrgSeats` do the reverse. They update the enrolment row first, then `bump` takes the course row.
     - A refund webhook landing while an author adds, removes or toggles a required lesson on a course with ≤ 500 learners gives a Postgres `40P01`. Either the author gets a 500, or the refund webhook job fails and is retried.
     - It self-heals, but it is avoidable.
   - Fix: call `lockCourse(tx, courseId)` before touching the enrolment in `revokeForOrder`, `revokeOrgSeats` and the reactivation branch of `grant`. That gives course → enrolment order everywhere.
2. **Analytics enrolment counts are not faithful to the range.**
   - Where: analytics.service.ts:107-123.
   - Failure:
     - Rows are bucketed by `enrolments.createdAt` with the *current* `source`, and revoked rows are included.
     - A row reactivated by a re-purchase keeps its original `createdAt`. A FREE row upgraded to PURCHASE moves to PURCHASE on its original free date.
     - A refund-then-rebuy inside the range shows no new enrolment, and refunded enrolments still count as enrolled.
   - Fix: document that the figures are "first enrolment per learner, current source", or exclude revoked rows / add a `reactivatedAt`.
3. **The revenue query is driven from the platform-wide journal.**
   - Where: billing-reports.ts:28-43.
   - Failure: with these predicates the planner scans every ORDER `sale`/`refund` entry in the range, platform-wide, and semi-joins `order_items`. Each studio analytics call is O(platform sales in range).
   - Fix: drive the query from `order_items (itemType, itemId)` → `orders` → `journal_entries (refType, refId, description)` using the existing unique index, and keep the `createdAt` filter.
4. **Revenue test gap.**
   - Where: test/e2e/course-analytics.e2e-spec.ts:249-281.
   - Gap: Task 11's TDD names "PENDING+AVAILABLE postings", but only a refund *inside* the hold is tested. The AVAILABLE branch (refund after hold release) has no test.
   - Fix: add a test that runs `holds.release` before the refund.
5. **The webhook-first test does not exercise the worker process.**
   - Where: course-enrolment.e2e-spec.ts:152-166.
   - Gap: the webhook is processed by the API test app's in-process queue, which uses the API's `SellableRegistry`. The worker path is only covered by "provider registered" (worker.module.int-spec.ts).
   - Fix: acceptable, since Phase 2 used the same harness. Note it in the test name or a comment.
6. **An org-counted thumbnail can be attached to personal targets.**
   - Where: media.service.ts `attach` (:231-241).
   - Failure: it checks `ownerId`, purpose and status but not `orgId`. A `THUMBNAIL` uploaded with `orgId` (counted against the org) can be attached to the uploader's personal targets. Impact is images ≤ 10 MB.
   - Fix: pass an expected `orgId` (null for personal) into `attach`.
7. **Course, section and lesson titles and subtitles are not plain-text sanitised.**
   - Where: studio-courses.controller.ts:14-15; curriculum.controller.ts:12,15.
   - Failure: they are shown on public pages and the catalog, so bidi and zero-width characters pass (titles are sanitised only for certificates).
   - Fix: run `sanitizePlainText` (single line) on these fields.
8. **An expired ORG_SEAT blocks the learner for up to 24 hours.**
   - Where: course-access-rules.ts:45 (`buyerRelation`).
   - Failure: before the daily sweep runs, an expired seat still reads as `ENROLLED`.
     - Checkout refuses with `COURSE_ALREADY_ENROLLED`.
     - Self-enrol returns the stale enrolment with 200, although `learnAccess` already refuses it.
   - Fix: apply `holdsSeat` in `buyerRelation` for ORG_SEAT rows, or revoke lazily on detection.
9. **A course can become uncompletable after publication.**
   - Where: progress.service.ts:209-212 and curriculum.service.ts:185.
   - Failure: the publish check requires ≥ 1 required lesson, but after publication an author can make every lesson optional. Then `r.n = 0` → pct 0 for everyone, and nobody can complete or get a certificate.
   - Fix: refuse removing the last required lesson on a live course, as the quiz lockout already does.
10. **NUL guard depth cap.**
    - Where: nul-guard.middleware.ts:10-13.
    - Failure: past depth 32 the guard returns "no NUL". The strict zod schemas make this practically unreachable.
    - Fix: return `true` (reject) above the cap.
11. **Heartbeat access check runs outside the transaction.**
    - Where: progress.service.ts:68-75.
    - Failure: a refund committing between `trackable()` and the transaction still writes one `lesson_progress` update. `lockEnrolments` finds no active row and carries on. It cannot complete the course, because `refresh` only touches active enrolments.
    - Fix: use `lockLearner` and refuse when it returns false, as quiz attempts already do.
12. **Import-order sensitivity is still documented only in test comments.**
    - Where: test/e2e/course-*.e2e-spec.ts:3-5.
    - Detail: production entry points are covered by the boot tests, and every barrel loads cleanly first under ts-node. The Nest-level failure the comments guard against is not pinned by a test.
    - Fix: add one unit test that compiles `CoursesModule` with billing imported *after* courses, or move the shared providers so the cycle disappears.

**Minor count: 12.**

## Deferred-minor triage (ledger `minor (deferred)` lines)

### Task 1-2 (review-1-2.md, rereview-1-2.md)

| Deferred minor | Ruling | Reason |
|---|---|---|
| Unbounded `startsWith` slug lookup | Defer | Performance only |
| Cross-course id / ex-member e2e | Defer | Code is correct |
| Concurrent delete returns 500 | Defer | |
| Reserved slugs | Defer | No static `/v1/courses/<word>` routes exist today |
| Redundant ternary | Moot | The sanitiser file is gone |
| `assetInfo` read outside the transaction | Defer | `attach` re-checks under lock |
| `publicView` and `flaggedAt` | Fixed | curriculum.service.ts:252 |
| Reviewers can read flagged drafts | Accept | Matches the course.review ruling |
| `REVOKED_DEFAULT_GRANTS` reapplied on every seed | Accept | Targeted and logged through `changedRoleIds` |
| Protocol-relative links accepted | Defer, but fix soon | `//evil.example` passes as "relative"; one regex in `isSafeLinkDestination` |
| Unterminated tags read as text; `List<String>` false positive; thematic break with > 20 markers | Defer | False positives only, safe direction |

### Task 3-4 (review-3-4.md)

| Deferred minor | Ruling | Reason |
|---|---|---|
| `forType` in constructor | Defer | |
| `constructor.name` assertions | Defer | |
| `learning()` order after reactivation | Defer, document | |
| Third org role checkout test | Defer | Code path checked: such a role gets `CHECKOUT_SELF_PURCHASE` after the reorder, so it is not weakened |
| Seat-check race in `revokeOrgSeats` | Defer | |
| Public promo of draft or flagged courses | Accept | Inherent to the ruling |
| PURCHASE overwriting a seat | Defer | |
| `describe` existence probe | Defer | |
| Seat expiry | Fixed | Sweep plus `holdsSeat` |

### Task 5-6 (review-5-6.md)

| Deferred minor | Ruling | Reason |
|---|---|---|
| Duplicate queries in `learnAccess` | Defer | Performance |
| Duration error code | Defer | |
| 5000 ms strictness | Defer | |
| Replay / parallel watch time | Accept | Per the spec formula |
| P2003 500 | Defer | |
| `ownerId` exposure on public views | Defer | Product call; a creator's user id is not secret given public profiles |
| Lesson-id oracle | Defer | |
| Ex-instructor playback through asset ownership | Defer | Real but narrow; Phase 1 `OwnerOrAdminPlaybackPolicy` |
| Import-cycle guard | See Minor 12 | |
| Stale percentage during a running recompute job | Defer | |

### Task 7-8 (review-7-8.md)

| Deferred minor | Ruling | Reason |
|---|---|---|
| Orphan PDFs | Defer | Storage cost only |
| Verify `Cache-Control: no-store` | Recommend before launch | A cached VALID after a refund-revoke is a correctness issue on a public endpoint; one-line fix. Not a merge blocker, since no CDN is configured for the API today |
| IPv6 /64 rate-limit bucketing | Defer | |
| Answers from the current quiz version | Defer | |
| Failed-score leak | Accept | |
| ZWJ/ZWNJ and other Indic scripts | Defer | Track before non-Hindi Indian launch |
| Test gaps; FK / retention | Defer | |
| Late ORG_SEAT certificate | Fixed | `holdsFinishedCourse` checks `hasLiveSeat` |

### Task 9-10 (review-9-10.md)

| Deferred minor | Ruling | Reason |
|---|---|---|
| Create-time rename window | Defer | |
| No NFC on `q` | Fixed | `q` is normalised (catalog.service.ts:148); indexed text is not, so only half fixed |
| ORG_SEAT recheck inside the review transaction | Defer | The `learnAccess` pre-check covers it; same family as Minor 8 |
| `manage_any` posting Q&A as instructor | Accept, document | |
| Reply author shown as "Learner" | Defer, cosmetic | |
| Edits to a hidden review | Defer | |
| `toCatalogCard` select | Defer | |
| `migrate dev` stripping raw indexes / `ratingShown` drift | Covered by README | But see Important 1 for the guard |

**Deferred minors that must be fixed before merge: none.** Fix protocol-relative links and verify `Cache-Control` before real traffic.

## Review Focus (plan), checked one by one

1. **Lesson video without enrolment.**
   - Only enrolled learners, free previews of a PUBLISHED, unflagged course, authors and `course.manage_any` get a token.
   - Also allowed, both by ruling: `course.review` holders on reviewable courses, and `media.manage_any` holders through the Phase 1 policy.
   - Refunded learners lose access on the next token request.
   - Archived or flagged courses stay playable for buyers. Tested at course-learning.e2e-spec.ts:87-170.
   - **Pass.**
2. **Webhook-first purchase.** Enrolment is idempotent and the COURSE provider is registered in the worker. The test runs through the API-harness queue (Minor 5). **Pass.**
3. **Price or curriculum changed between checkout and payment.** The order snapshot is kept; `onPaid` only needs the course row. **Pass.**
4. **Progress spoofing.** Credit is at most `min(Δposition, 2·Δwallclock)` on the server clock, with completion at 90%. Writes need an enrolment, and certificates require `completedAt`. **Pass.**
5. **Org learner vs paid buyer.**
   - ORG_SEAT is granted without checkout.
   - `org.member_removed` from both revoke paths, plus the daily sweep, revokes ORG_SEAT only.
   - **Pass.** Minor 8 is a UX gap.

## Brief priorities, summarised

- **Access control.** No bypass of `canLearn` found.
  - Moderators can read and play every published course's paid content. This is by ruling (`course.review` plus `media.manage_any`); worth a product sign-off.
  - Ex-org instructors keep playback of videos they uploaded (deferred).
- **Money.**
  - COURSE is handled in the API and the worker.
  - `onPaid` and `onRefunded` are correct and order-scoped.
  - Refund eligibility is "7 days AND < 30%".
  - Analytics revenue is correct for a refund before and after hold release; only the before case is tested.
  - The self-purchase and org guards still apply after the checkout reorder.
- **Integrity.**
  - Exactly-once holds for completion, events and certificates.
  - Ratings are recomputed under the course lock.
  - Reactivation refreshes progress and re-emits completion.
  - The README list of hand-written database objects is complete against the migrations (I listed every `WHERE` / `USING` / `GENERATED` / `EXTENSION` / `WITH` statement in the 12 new migrations).
  - The drift guard hides drift (Important 1). The deadlock is Minor 1.
- **User content.** Sound; see Minor 7 and the protocol-relative link item.
- **Boot.** Handlers and jobs are registered and asserted. See Minor 12.
- **Test honesty.** Tests drive real HTTP, the database and the ledger. Shortcuts are state written straight to tables in analytics and enrolment fixtures (moderation is owned elsewhere), plus Minors 4 and 5.

## Declined to judge

- **Moderators playing paid content and reading quiz answers on any published course.** A product/security trade-off already ruled by the controller (Task 1-2, Task 5-6); I only flag it for sign-off.
- **Public reviews and Q&A show the reviewer's `displayName` and handle**, which may still be derived from their email. This is Phase 1's public profile model; Phase 3 adds no new exposure.
- **Org instructors (not just `org_owner`) see the org course's revenue in analytics.** The plan gives analytics to authors; whether instructors should see money is a product question.
- **`OrganizationDirectory.nameOf` throws for a missing org,** so invoices and certificates retry forever if an org were ever hard-deleted. This was ruled; orgs are not deletable today.
- **Analytics completion, drop-off and watch time are live rather than range-bounded.** Ruled and documented in the README.
- **Whether the API should also register the outbox and job handlers** (`COURSES_CORE_PROVIDERS` in both processes). This is the established Phase 2 pattern; not re-litigated.

## Merge verdict

**Ready to merge: with fixes.** Fix Important 1 (the drift guard filtering by clause instead of by block, plus a test) before merge. Everything else can follow. Minors 1, 8 and 9 are the most worthwhile follow-ups.
