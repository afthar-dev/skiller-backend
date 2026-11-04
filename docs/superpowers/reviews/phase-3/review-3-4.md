# Review: Phase 3 Tasks 3 and 4 (b84e441..6f56d49)

Skipped as instructed: `src/modules/courses/markdown*`, lockfile, openapi.json. File:line references below are line numbers inside the new files (for new files) or the diff-file line where noted.

## Spec Compliance

Verdict: Spec compliant, with one gap against the controller brief (authors approving their own course, see Important 1) and two checks that cannot be settled from this diff.

- Task 3: submit (sections, required lesson, VIDEO READY, thumbnail, `max_published_courses`), queue, approve (`publishedAt`, `slugLockedAt`, outbox `course.published`), reject with reason, flag/unflag, archive, audit and author notification are all present. `publicView` hides flagged and non-PUBLISHED courses.
- Task 4: `Enrolment` model and unique key, `CourseSellable` in API and worker, `onPaid` idempotent and 4xx only for a deleted course, `onRefunded` revoke, free/ORG_SEAT enrol endpoint, `org.member_removed` in the same tx, refund rule (7 days AND < 30%) via `COURSE_PROGRESS_READER`, `GET /v1/me/learning`, `enrolmentCount` maintained in the same tx as each change.
- Cannot verify from this diff:
  - Other public course endpoints (detail/catalog) hiding flagged courses: only `CurriculumService.publicView` is touched here; later catalog task must apply the same predicate.
  - Whether content edits made by the author while a course is IN_REVIEW are blocked (Task 2 code, not in diff). Approval re-runs the content checks, but a moderator could approve content that changed after they looked.

## Strengths

- `EnrolmentsService.grant` (enrolments.service.ts:70-92): `createMany skipDuplicates` then `FOR UPDATE` row lock, reactivation of the same row, purchase outranks seat/free, same-order retry is a no-op, different second purchase is a permanent 409 so fulfilment fails and refunds. Counter bumped in the same tx. Race-safe for double enrol and webhook-first plus browser-verify.
- Re-purchase after refund: revoked row is reactivated with the new `orderId`; a late redelivery of the old order's `onRefunded` cannot revoke it because `revokeForOrder` matches on `orderId` (enrolments.service.ts:95-98).
- `org.member_removed` is enqueued inside the role-change transaction in both `removeOrgMember` and `revoke` (roles.service diff lines 1824, 1846). The handler re-reads the current roles, so a late/duplicate event does not harm a learner who came back, and it only touches `source = ORG_SEAT` rows of that org's courses.
- Entitlement race: `lockOwnerPublishing` advisory lock per owner plus the course row lock in `approve` (moderation.service.ts:51-65) serialises approvals; count excludes the course itself; flagged count, archived do not. Tested with concurrent approvals.
- Module boundaries are clean: courses reads rbac through `PlatformRoleDirectory`, media through `MediaService` (`assetStatuses`, `assetInfo`, `attach`), billing through its index (`EntitlementsService`, registries). No direct reads of billing/rbac/org/media tables. Worker module wiring is minimal and covered by a boot test.
- Notifications are best effort after commit; audit rows are written inside the tx.

## Check results for the focus areas

1. **Checkout reorder (billing/checkout.service.ts, diff 252-257).** No bypass found. `purchasable=false` rejects before the guard, so every path that reaches the guard is a purchasable item and the guard still runs for it unchanged: USER-sold items compare `sellerOwnerId === buyerId`; ORG-sold items use `roles.isOrgMember` (any role, incl. org_owner/org_instructor). For COURSE, authors and org learners are non-purchasable earlier with a specific reason; org members with any other role are purchasable in `describe` and caught by the guard (`CHECKOUT_SELF_PURCHASE`). A non-COURSE sellable that says `purchasable: true` for its own seller is still blocked. The only behavioural change is the error code for own non-purchasable items (ITEM_NOT_PURCHASABLE instead of CHECKOUT_SELF_PURCHASE). Not covered by a test for the "other org role" case (Minor 5).
2. **Enrol endpoint (self-enrolment.service.ts).** Non-org user on a paid course: 402. Ex-member: `roleKeysInOrg` is read live and honours `expiresAt`, so a removed learner gets 402. DRAFT / IN_REVIEW / ARCHIVED / flagged: 404 unless already actively enrolled (existing rows are returned unchanged, which is right). Authors: 409 `COURSE_OWN`. Double enrol race: handled by `grant`; second caller gets `created:false`. Free course (price 0) of an org gives FREE, which survives removal from the org by design.
3. **Webhook-first (course.sellable.ts:62-67, courses-worker.module.ts).** Provider, clock, role directory and refund rule are registered in the worker; worker boot test asserts it; `onPaid` is idempotent per order. Deleted course throws 404, other states enrol. Good.
4. **org.member_removed:** verified above. Gap: grants that expire (`expiresAt`) produce no event (Minor 1).
5. **Moderation authz:** all five admin routes require `course.review`; `course.manage_any` alone cannot moderate (policy.canModerate is not used here, consistent with the ruling). No author/actor separation exists (Important 1).
6. **COURSE_PROMO:** purpose is public bucket, creator-only, 500 MB, 300 s, same HLS/poster URL branch as REEL (media.service.ts diff 1733), transcoder takes the static 300 s cap (transcode.processor.ts:100) and deletes the source. Attach goes through `CourseMedia`, so the asset purpose must be exactly COURSE_PROMO and the owner must be the course owner / an org author. A REEL is refused. See Minor 7 on exposure.
7. **Boundaries:** see Strengths.

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

1. **An author with `course.review` can approve (or reject) their own course.** moderation.service.ts:51-65 (`approve`), :70-77 (`reject`) never compare `meta.actorId` with the course's authors. Scenario: a platform admin who is also a creator (or an `org_instructor` who also holds `course.review`) submits a course and approves it themselves, defeating the "first publish requires moderator approval" constraint and the controller ruling. Fix: in `approve`/`reject`, after loading the course in the tx, deny with 403 (for example `COURSE_SELF_REVIEW`) when `actorId === course.createdById` or `actorId` is in `policy.authorIds(course)` (the policy method already exists; call it with the tx-less client before the tx or add a tx-aware variant). Add an e2e test: creator-with-`course.review` approving own USER course and an org instructor-with-`course.review` approving an org course both get 403 and the status stays IN_REVIEW.
2. **Duplicated "who may not buy / may take a seat" decision in two places.** course.sellable.ts:48-53 and self-enrolment.service.ts:33-39 repeat the same block (USER owner equals user, else org roles, author-role intersection, `COURSE_OWN`, learner role lookup). The two decisions must agree (checkout says "use the seat" while enrol says "pay", or the reverse, if one drifts). Fix: extract one helper next to `org-roles.ts` (for example `resolveBuyerRelation(roles, course, userId): { relation: "OWN" | "ORG_LEARNER" | "OTHER", roleKeys }`) and use it in both.

### Minor (Nice to Have)

1. enrolments.service.ts:98-111 / roles expiry: `roleKeysInOrg` ignores expired grants, but nothing emits an event or runs a job when an `org_learner` grant expires, so an ORG_SEAT enrolment outlives its role. Task 5's playback policy should either re-check the live role for `ORG_SEAT` rows or a maintenance sweep should revoke them.
2. course-refund-eligibility.ts:19-22 resolves `registry.forType("COURSE")` in the constructor, before its own `register` in `onModuleInit`; correct today only because nothing else registers COURSE and instances are constructed once. Resolve the default lazily or take the default rule directly.
3. worker.module.int-spec.ts:diff 1915-1916 asserts `rule.constructor.name` strings; brittle under minification/renames. Prefer `toBeInstanceOf`.
4. enrolments.service.ts:123-130 `learning()` pages by enrolment id; a reactivated row keeps its old id, so "newest first" does not reflect a re-purchase. Acceptable if documented; otherwise order by a reactivation timestamp.
5. Missing tests: checkout with a third org role (neither author nor learner) returning `CHECKOUT_SELF_PURCHASE` after the reorder; submit with `max_published_courses` race is covered, but reject-then-different-actor and self-review are not (see Important 1).
6. enrolments.service.ts:101-108 `revokeOrgSeats` checks roles outside the revoking transaction; a learner re-added between the check and the update loses the seat until they enrol again. Negligible window, endpoint recovers it.
7. A COURSE_PROMO asset lives in the public bucket from READY on, so a draft, in-review, rejected or flagged course's trailer is reachable by anyone holding the (unguessable) HLS URL, and flagging a course does not take the promo down. Inherent to the ruling; record it so the catalog task never exposes the URL of unpublished/flagged courses.
8. grant (enrolments.service.ts:87-88): if a PURCHASE overwrites an ORG_SEAT/FREE row (only reachable by a checkout race), a later refund revokes the whole enrolment even though the seat would still entitle the learner. Edge case, not worth code today.
9. `describe` returns a distinct reason for a draft course id (`COURSE_NOT_AVAILABLE`) versus 404 for an unknown id, which lets an authenticated user probe for existence of unpublished course ids. Ids are random, so low impact.

Minor count: 9.

## Assessment

**Task quality:** Needs fixes

**Reasoning:** The money-adjacent paths (reordered checkout guard, webhook-first fulfilment, refund/re-purchase, seat revocation and its transactional event) are sound and well tested; the one real hole is that moderation does not separate author from reviewer, plus a duplicated own/seat decision that should be unified before Task 5 builds on it.
