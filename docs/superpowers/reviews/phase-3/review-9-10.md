# Review: Tasks 9-10 (reviews / Q&A; search / catalog), b86d6b3..afd4c27

Line numbers are lines of the new file (derived from the diff hunks; +-2). Read-only review; the suite was not run.

## Spec Compliance
Verdict: issues found.
- Task 9 and 10 interfaces are all present (models, routes, 3-rating rule, same-tx rating, author reply once/editable, moderator hide/unhide with reason + audit, preview read vs enrol-to-post, batching, tsvector in code, GIN + trigram, ts_rank + 0.3 sim, fts-to-trgm fallback, hourly enrolments30d, keyset cursors).
- Missing: moderators/admins are not barred from moderating content of a course they author. `ModerationService.locked()` (moderation.service.ts:107-116) enforces COURSE_REVIEW_SELF for course decisions; `ContentModerationService` has no equivalent (finding I1).
- Cursor "validated" is only partly true: a well-formed forged cursor still reaches SQL and errors (finding I2).
- Cannot verify from the diff: that `GET /v1/courses?q=%00` returns 500. `ErrorFilter` only maps ZodError and Prisma P2002 (error.filter.ts:52-56), so any other driver error is a 500. Run it once.

## Strengths
- Rating correctness is solid. `recomputeRating` recomputes from scratch (no drift), after `lockCourse` FOR UPDATE, and every writer takes the lock first. Upsert, moderator hide/unhide, revoke and reactivate all do. Under READ COMMITTED each statement after the lock sees the previous writer's commit. Lock order is safe: enrolment row, then course row (grant/revoke), versus course row then non-locking enrolment read (upsert, unhide). No cycle. ROUND(...,2) in numeric is exact and fits Decimal(3,2).
- All three revoke paths (refund, `revokeOrgSeats`, `sweepOrgSeats` via `revokeOrgSeats`) hide the review in the same tx. The system-hide vs moderator-hide distinction (`hiddenBy` null or not) is handled correctly in restore and unhide. The review upsert re-checks the enrolment after taking the lock.
- Authorization of review/Q&A is tight: lesson-to-course is derived from the lesson row (no cross-course posting), preview viewers and moderators read only, strangers 403, authors cannot review (buyerRelation precedence OWN/ORG_AUTHOR before ENROLLED).
- Every catalog path (every sort, filter, mode, cursor) goes through `filters()`, which always adds status = PUBLISHED and flaggedAt IS NULL. `publicPage` and the review list check the same. No leakage found.
- SQL is parameterised throughout. The only interpolated pieces are constants (`SET LOCAL ... = 0.4`, `Prisma.raw` of fixed column aliases and cast names). `websearch_to_tsquery` never raises a syntax error (quotes, `:*`, `!`, `-`, unbalanced input are all fine; punctuation-only gives an empty query plus a NOTICE, then the trigram path).
- The cursor binds sort and a query hash. Descending-only keys with an id tiebreak give stable pages. Scores are rounded to 6 dp so the cursor carries exact values.
- The rename handlers re-read the current name, so duplicate and late deliveries are idempotent. Events are enqueued in the same tx as the rename and only when the name changed.

## Issues

### Critical (Must Fix)
None.

### Important (Should Fix)

**I1. Moderators can hide/unhide reviews, questions and answers of a course they author.** content-moderation.service.ts:27-60 (`hideReview` / `unhideReview`), :61-100 (question/answer variants).
Scenario: a creator who also holds `course.review` (or an org instructor with the role) hides every 1-star review, which raises ratingAvg. It is audited but not prevented. The same rule already exists for course decisions (moderation.service.ts:113).
Fix: load the course (the review/question already gives courseId) and reject with `COURSE_REVIEW_SELF` 403 when `policy.authorIds(course)` or `createdById` contains the actor. Add a test.

**I2. Forged cursors produce 500s (and the "hash" is not integrity protection).** catalog.service.ts:35-37 (regexes), :45-47 (schema), :173-176 (`hashOf`), :184-191 (`decode`), :159-170 (`pageSql`).
- `h` is `sha256(public query parts)[0:12]`, so anyone can compute it; it only ties a cursor to a query, it does not authenticate it.
- `INT = /^\d{1,10}$/` lets `9999999999` through, and it is cast `::int`, giving "value out of range" (22003) and a 500. `TS` accepts `9999-99-99 99:99:99`, giving a date/time range error and a 500. Both are reachable with a self-made cursor and the correct hash. The e2e "forged" case only uses a wrong hash (course-catalog.e2e-spec.ts ~2550), so it never reaches SQL.
- A forged `m` is also trusted. `m:"none"` with a `q` runs the `<%` branch outside the `SET LOCAL` transaction, so the threshold is the default 0.6 (wrong results, not an error).
- No injection: values are bound parameters.
Fix: sign cursors (HMAC with a server secret over the JSON), or at least validate ranges (INT <= 2147483647, `new Date()` round-trip for timestamps, NUM bounds) and reject `m` that is inconsistent with `q`. Also map Postgres 22xxx errors in `run()` to the existing `badCursor()` 400. Add a test with a correct hash and an overflowing key.

**I3. `OutboxService` is `@Optional()` in `ProfilesService`: a missing provider silently drops rename events.** profiles.service.ts:~101 (ctor) and :~195 (`this.outbox?.enqueue`).
- Today the API (UsersModule, OutboxModule global in AppModule) and the worker (`WorkerModule` imports OutboxModule) both resolve it, and the e2e proves the API emits. But `ProfilesService` is also hand-provided in `UsersWorkerModule`, `BillingWorkerModule`, `CoursesWorkerModule` and `profiles.service.int-spec.ts`. Any module or test context that lacks OutboxModule gets `undefined` and the course search vectors go stale with no error and no log. This is silent data drift.
- Right fix: drop `@Optional()` and make the dependency required. Nest then fails at boot if it is missing. Update `profiles.service.spec.ts:14` to pass a stub (`{ enqueue: jest.fn() }`) and let `profiles.service.int-spec.ts` import `OutboxModule`. If the unit spec must stay light, keep one explicit test that asserts `update()` calls `enqueue`.
- Add a boot assertion for the app and the worker (`app.get(ProfilesService)` has a defined outbox), next to the `HANDLED` map in worker.module.int-spec.ts.

**I4. The "GIN used for every sort" guarantee covers only the selective-`q` case; browse and the default sort full-scan.** catalog.service.ts:159-170, 133-157; course-search.int-spec.ts:1072-1085.
- With no `q` (the default `relevance` becomes `popular`) or a common word, `pageSql` wraps a subquery that computes the sort expressions for every PUBLISHED row, sorts them all, and applies the keyset predicate as a row comparison on computed columns. No index can serve it. `coalesce(publishedAt, createdAt)` also defeats the existing `(status, publishedAt)` index. Each page, including deep ones, is O(published courses), on a public endpoint allowed 120/min/IP.
- The test only EXPLAINs a unique word (3 rows of 2,000) and never the no-`q` path, filters, the trigram path, or `matchesFullText`.
- Fix: partial indexes such as `(enrolments30d DESC, "enrolmentCount" DESC, id DESC) WHERE status='PUBLISHED' AND "flaggedAt" IS NULL`, similar for newest (use `publishedAt`, which is non-null when published) and rating. Push the keyset predicate into the same SELECT as the ORDER BY so it can use them. Otherwise state the limit and add a plan test for the no-`q` case.

**I5. `GET /v1/courses?q=<NUL>` (and `category=<NUL>`) is likely a 500.** catalog.controller.ts:~12 and 21, catalog.service.ts:98-112.
- `q` and `category` are only trimmed and length-limited, so a NUL (`%00`) reaches Postgres as a text parameter ("invalid byte sequence 0x00"), an unmapped error. The Q&A and review paths are safe because `sanitizePlainText` strips `\p{C}`.
- Fix: run `q` through the shared sanitiser (also NFC-normalise it, see M3) and give `category` a slug regex. Add a test with `%00`.

### Minor (Nice to Have) - count: 9
1. **Late rename window at create.** courses.service.ts:68 reads `ownerName` before the tx. A rename committed between that read and the insert, with the handler running before the insert is visible, leaves a stale name and vector until the next rename. Fix: read the name inside the tx, or derive it in SQL in `refreshCourseSearch`.
2. **popularity job.** course-popularity.ts:21-27 scans `enrolments` by `createdAt` with no index (enrolments has only `userId,id`, `orderId`). It is a self-join of `courses` and rewrites only changed rows (good). Fine at today's size. Add a `(createdAt) WHERE revokedAt IS NULL` index before enrolments reach the millions. The `FROM "courses" c2 ... WHERE c.id = c2.id` self-join is redundant.
3. **No NFC for `q` or the indexed text.** A decomposed Devanagari or accented query will not match composed stored text. Normalise both.
4. **VACUUM question.** The `VACUUM (ANALYZE)` in course-search.int-spec.ts:~1057 is legitimate: the GIN pending list (fastupdate) and stale stats skew the plan. In production correctness is unaffected, and the pending list flushes at `gin_pending_list_limit` (4 MB) or on autovacuum/analyze, so reads scan at most that. Autovacuum on a low-write `courses` table fires rarely, so planner stats lag. Cheap hardening: create `courses_search_vector_idx` `WITH (fastupdate = off)` (the table is read-heavy) and keep autoanalyze defaults.
5. **Review seat check.** reviews.service.ts:~118 re-checks only `revokedAt: null`; an ORG_SEAT learner whose org_learner grant expired (before the daily sweep) can still review for up to 24 h. `learnAccess` before the tx does check the seat; repeat it in the tx or accept it.
6. **`course.manage_any` holders can post Q&A** (`learnAccess` returns via AUTHOR) and their answers are marked `isInstructor`. Brief says "enrolled or authors only". Decide and document.
7. **Reply response** (reviews.service.ts `reply`, `toPublic(updated, undefined)`) returns the replying instructor-side review with author "Learner"; return the real author or omit it.
8. **A moderator-hidden review can still be edited by its author**, and a later unhide shows the edited text unreviewed. Consider re-queuing, or blocking edits while hidden.
9. **Hygiene.** The `BIDI_CONTROLS` regex literal holds raw invisible characters (use `\u` escapes). certificate-document.ts leaves a stray double blank line. RED output for Task 10 was not captured. Each answer notifies the asker, so one asker can receive up to 60/h per answerer. Question and answer rows cascade-delete when a lesson is deleted. `toCatalogCard` loads full descriptions only to drop them (select columns instead).

## Checks run (named risks)
- Concurrency of rating: traced `upsert`, `hide/unhide`, `revokeForOrder`, `revokeOrgSeats`, `grant` reactivation for lock order and snapshot visibility. No drift or deadlock found. There is no concurrent-upsert test in the suite; add one (N parallel PUTs, and PUT racing a revoke).
- Search leakage: checked all `filters()` call sites, `publicPage`, the review list, the Q&A `learnAccess` with `lesson` hint. No draft/in-review/archived/flagged leak.
- Optional outbox: traced who provides `ProfilesService` (UsersModule, UsersWorkerModule, BillingWorkerModule, CoursesWorkerModule, int-spec) and that `OutboxModule` is @Global.
- Module boundaries: courses only writes its own tables. It reads users and organizations through `ProfilesService` and `OrganizationDirectory` (both exported), and users/orgs emit generic events. No violation. `CourseSearchHandlers` is in `COURSES_CORE_PROVIDERS`, so API and worker both register it.

## Assessment
**Task quality:** Needs fixes

**Reasoning:** Rating consistency, authorization and catalog visibility are well built and well tested. The remaining gaps are a missing moderator-self guard (I1), cursor and `q` inputs that reach Postgres unvalidated and can 500 (I2, I5), a silent `@Optional` dependency that can stop search freshness (I3), and a performance guarantee that is only true for selective queries (I4).
