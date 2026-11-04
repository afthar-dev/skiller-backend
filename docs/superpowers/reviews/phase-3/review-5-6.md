# Review: Tasks 5 + 6 (38102b8..dc039ce)

## Spec Compliance
Spec compliant. Controller rulings honoured: single `CourseAccessRules.learnAccess/canLearn`; ORG_SEAT also needs a live grant (course-access-rules.ts `learnAccess` / `holdsSeat`); preview viewable by anyone, no progress; `course.review` plays IN_REVIEW/PUBLISHED/flagged without progress; nothing cached in the course layer; watched formula, first heartbeat 0, cap at duration, 90%, 1 per 5 s, floor pct, course.completed guarded by `completedAt IS NULL`.
Cannot verify from diff: (a) Task 7 quiz endpoints must gate on `canLearn` - `LearnService.lesson` returns `quizId` to preview viewers of a QUIZ preview lesson (learn.service.ts lesson()); (b) PermissionService's Redis cache (10 min, epoch bump through outbox) backs `course.manage_any` / `course.review` - revocation lag is bounded by outbox delivery, not zero.

## Strengths
- One decision point, used by playback, learn course, learn lesson, progress. No path to content bypasses it (checked: playback via `CoursePlaybackPolicy`; resource presign only inside `LearnService.lesson` after `learnAccess`; public curriculum exposes asset id only for free-preview VIDEO of PUBLISHED unflagged course, and playback still requires login + rule 3).
- The only other registered policy is `OwnerOrAdminPlaybackPolicy` (asset owner or media.manage_any): no course-lesson grant leaks. An asset is attached to one lesson (attach row-lock), so asset A cannot be used to infer lesson B; `findMany` + loop handles the multi-lesson case safely anyway. Orphaned assets (lesson deleted/replaced) resolve to no lesson -> denied.
- Heartbeat serialised on a `FOR UPDATE` row lock with server-clock rate limit: parallel heartbeats cannot both be credited for the same elapsed time; 429 leaves state untouched (tx rolled back). zod `int().min(0).max(86400)` rejects NaN/negative/huge/fractional; position clamped to duration; watched capped.
- course.completed exactly-once holds: a second concurrent UPDATE re-checks `completedAt IS NULL` after the row lock.
- Cross-course completion, VIDEO via /complete (422), QUIZ via /complete (422), refunded/stranger/preview/author on progress (403) all closed in `trackable`.
- No N+1 on `learn/courses/:slug`: 3 queries (+ access checks) regardless of curriculum size.
- Good e2e coverage of the access matrix; RED evidence present.

## Issues

### Critical
None.

### Important
1. progress.service.ts:130-157 (`markLessonCompleted` -> `refresh`) - lost update: completion of two different lessons by the same learner in parallel (two tabs/requests; the lock is per (user,lesson), not per enrolment). Tx A and B each insert their completed row, then run `UPDATE enrolments SET progressPct = (subquery count)`. Under READ COMMITTED, B waits on A's enrolment row lock; after A commits, B's SET subquery still runs on B's statement snapshot, so it does not see A's row. Final pct is one lesson short. If these were the last two required lessons: pct stays <100, `completedAt` never set, `course.completed` never emitted (certificates later), and a video learner has nothing left to trigger a recompute (heartbeat on a completed lesson never calls refresh; only re-POST /complete heals an ARTICLE). The same snapshot effect lets a learner completion overwrite an author's concurrent `recomputeCourse` with a stale lesson count. Refund eligibility reads that stale pct. Fix: at the start of `markLessonCompleted` take `SELECT 1 FROM enrolments WHERE courseId=... AND userId=... AND revokedAt IS NULL FOR UPDATE` (lock order progress row -> enrolment is already consistent), so later statements get a fresh snapshot; for `recomputeCourse` lock the enrolments before counting. Add Promise.all e2e tests for (a) two last-lesson completions, (b) two parallel heartbeats at the same elapsed time (the report calls it race-free but no test exercises it), (c) two parallel completions of the final lesson emit one event.
2. course-playback.policy.ts:26 / prisma/schema.prisma:1149 - `lessons.videoAssetId` has no index (only `[sectionId, position]`, `[courseId]`); every playback token request does a full `lessons` scan on a hot path. Add `@@index([videoAssetId])` + migration.
3. curriculum.service.ts (createLesson ~L158, deleteLesson ~L202) -> progress.service.ts:146-151 - every lesson create/delete recomputes pct for every active enrolment with a correlated subquery (O(enrolments x lessons)), inside the author's course-lock transaction, even for lessons that cannot change any percentage. A 50k-enrolment course blocks edits and rewrites every enrolment row. Fix: skip when the lesson is not `isRequired` and not QUIZ; add `AND e."progressPct" IS DISTINCT FROM <new>` to avoid no-op rewrites; consider a worker job for large courses.

### Minor (12)
1. Import-cycle sensitivity (focus 6): not a latent bug for the shipped entry points. main.ts/worker.ts load only `create-app`/`create-worker` -> `app.module.ts` (fixed order: identity, rbac.module, ..., billing barrel, courses barrel) and `worker.module.ts` (billing first); both are exercised by the e2e suite and `worker.module.int-spec`. It is a fragile ordering contract though: `CourseAccessRules` (new `PermissionService` ctor param, course-access-rules.ts:3,32), `PlaybackPolicies` (media/playback-policy.ts) and `CoursePlaybackPolicy` take barrel classes through `design:paramtypes`; if any file imports the rbac/courses barrel before billing, the class is `undefined` and Nest fails at boot with an unresolved-dependency error. An import-sorting tool or a new script reordering app.module.ts would break prod boot. Add a guard comment in app.module.ts and a boot test that imports barrels in the "wrong" order, or break the cycle at the source (billing <-> courses/rbac).
2. enrolments.service.ts:75 reactivation reuses the row; `refresh` only updates active enrolments, so while revoked `progressPct`/`completedAt` go stale (lessons added/deleted meanwhile) and a reactivated enrolment shows the old value until the next completion. Recompute on reactivation.
3. course-access-rules.ts `learnAccess` queries the enrolment twice (directly and in `buyerRelation`) plus role and permission lookups: 4-6 queries per playback token. Reuse the first result.
4. progress.service.ts:~58 LESSON_NOT_VIDEO for "video has no known duration yet" is the wrong code (a 409 like MEDIA_NOT_READY fits).
5. progress.service.ts HEARTBEAT_MIN_INTERVAL_MS strict 5000 vs client jitter: a player sending every 5 s gets frequent spurious 429s (harmless: state untouched, next credit uses the longer gap). Consider ~4500 ms tolerance.
6. Sum-based `watchedSec`: re-watching the same 10% nine times, or running heartbeats on many lessons in parallel (each earns 2x), still reaches 90% in about duration/2 wall-clock. Matches the specified formula; document as a known limit (unique-segment tracking is the fix).
7. progress.service.ts `trackable()` runs outside the tx; a lesson deleted between check and insert yields an FK violation (500) instead of 404. Catch P2003 or re-check inside.
8. course-view.ts `toPublicCourseView` exposes `ownerId` (a user id for USER-owned courses) and `promoVideoAssetId`; confirm intended for an unauthenticated page.
9. learn-errors.ts / learn.service.ts: unknown lesson -> LESSON_NOT_FOUND, draft lesson -> COURSE_NOT_FOUND: tiny existence oracle for lesson ids (uuid v7, low risk).
10. progress.service.ts `markLessonCompleted(_source)` parameter is unused (reserved for Task 7).
11. course-progress.ts line 1 is a stray blank line left after removing the import.
12. `OwnerOrAdminPlaybackPolicy` (Phase 1): an ex-org-instructor keeps playback of lesson videos they uploaded (asset owner). Worth a note for org courses.

## Assessment
**Task quality:** Needs fixes (Important 1-3; access control itself is sound).
**Reasoning:** Access control for focus 1 holds on every path traced; anti-spoofing and exactly-once emission are correct per row. The completion path has a real read-committed lost update that can strand a finished learner below 100% with no course.completed, untested because there are no concurrency tests; plus a missing index on the playback hot path and unnecessary all-enrolment recomputes.
