# Phase 3 — Courses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Coursera side of Skiller — course studio, curriculum, moderation and publishing, paid and free enrolment through Phase 2 checkout, protected video player, progress, quizzes, certificates, reviews, lesson Q&A, search and creator analytics.

**Architecture:** New `courses` module owning all course tables. It plugs into Phase 2 through a `COURSE` `SellableProvider` (registered in BOTH the API and the worker), a `RefundEligibility` provider (< 30% consumed) and Phase 1's `PlaybackAccessPolicy` (enrolled learners may play lesson video). Media stays in the media module (`MediaService.attach`). Owners are a creator (USER) or an organization (ORG); org instructors author org courses.

**Tech Stack:** As Phases 1–2. Postgres full-text search (`tsvector` + GIN) and `pg_trgm`. `pdfkit` (already present) for certificates.

**Spec:** `docs/superpowers/specs/2026-11-03-skiller-platform-redesign-design.md` §8 (and §7 playback, §11 orders/refunds). Phase 1 and Phase 2 ledgers' rulings still bind.

## Global Constraints

- All money as integer paise, JSON as decimal strings; prices go through Phase 2 checkout only — courses never post ledger entries themselves.
- Course price: `0` (free) or between ₹99 and ₹1,00,000 (`9900`–`10000000` paise).
- Every route has `@RequirePermission` / `@Public` / `@AuthenticatedOnly`; ownership checks in a `CoursePolicy` (owner creator, or org_owner/org_instructor of the owning org, or `course.manage_any`).
- Lifecycle `DRAFT → IN_REVIEW → PUBLISHED → ARCHIVED`; first publish requires moderator approval; later edits to a PUBLISHED course go live directly unless the course is flagged.
- Publishing checks entitlement `max_published_courses` of the owner (Phase 2 `EntitlementsService.check`).
- Lesson video assets are `COURSE_LESSON` media (private, HLS); learners play through `/v1/media/:id/playback` via a course `PlaybackAccessPolicy` (enrolled, or lesson is free preview, or author).
- Enrolment is created only by `onPaid` (paid) or the free-enrol endpoint (free); removed by `onRefunded`.
- Outbox handlers idempotent. Module reads/writes only its own tables.

## Decisions taken for this plan (please confirm)

1. **Org courses:** an organization owns its courses; `org_owner` and `org_instructor` can author; revenue goes to the org wallet. **Org members with `org_learner` get the org's courses free** (seat-based institution use) — checkout is skipped for them.
2. **Moderation:** first publish of every course goes to a moderator queue (`course.review`); moderator approves or rejects with a reason. Re-publishing after rejection goes back to the queue. Moderators can unpublish any course (flag) with a reason.
3. **Certificates:** issued when every required lesson is completed and every quiz in the course is passed. Video counts as completed at ≥ 90% watched; articles/resources on "mark complete". Certificate PDF with public verify URL `/certificates/:code` (code = 10 chars, unambiguous alphabet).
4. **Refunds:** eligible within 7 days of purchase **and** < 30% of the course's lessons completed. Refund removes the enrolment (progress kept for analytics but hidden).
5. **Reviews:** enrolled learners only, one per course, rating 1–5 + optional text (≤ 2,000 chars), editable; creator can reply once per review. Course rating = average, shown when ≥ 3 reviews.
6. **Quizzes:** single- and multiple-choice questions; pass mark per quiz (default 70%); unlimited attempts with 1-minute cooldown; answers not revealed until passed.
7. **Search:** Postgres full-text over title, subtitle, description, tags, creator display name + trigram fuzzy on title; filters category, level (`BEGINNER|INTERMEDIATE|ADVANCED|ALL`), language, price (free/paid/range), rating ≥ n; sort relevance, newest, rating, popularity (enrolments last 30 days). Categories are an admin-managed table (seeded with ~15 starter categories).
8. **Analytics:** enrolments, revenue (from Phase 2 orders), completion rate, average rating for every plan; per-lesson drop-off and watch-time charts only for `analytics_level` `standard`/`advanced`.

## Review Focus

1. **Lesson video access without enrolment** (direct playback call, enrolment refunded, course unpublished after purchase) — expected: only enrolled learners, free-preview lessons, authors and `course.manage_any` can get a playback token; refunded learners lose access immediately; learners who bought keep access to an unpublished/archived course. Test in Task 5.
2. **Webhook-first purchase** (Razorpay `payment.captured` reaches the worker before the browser verifies) — expected: enrolment created by the worker-side `COURSE` provider exactly once. Test in Task 4.
3. **Price or curriculum changed between checkout and payment** — expected: buyer pays the price snapshotted at checkout and gets the course as it is at fulfilment; deleting all lessons doesn't break fulfilment. Test in Task 4.
4. **Progress spoofing** (client posts 100% watch instantly, or completes a lesson of a course they don't own) — expected: completion requires enrolment and plausible watch progress (position updates must not jump more than 2× real elapsed time); certificate cannot be forced. Test in Task 6.
5. **Org learner vs paid buyer** (an org_learner tries checkout, or loses org membership) — expected: org_learner enrols free without checkout; removal from the org revokes free-access enrolments (but not paid ones). Test in Task 4.

---

## File Structure

```
src/modules/courses/
  course.policy.ts            # ownership / authoring / moderation checks
  categories.service.ts
  courses.service.ts          # course CRUD, lifecycle, publish checks
  curriculum.service.ts       # sections, lessons, ordering, media attach
  moderation.service.ts
  enrolments.service.ts
  course.sellable.ts          # COURSE SellableProvider + RefundEligibility
  course-playback.policy.ts   # PlaybackAccessPolicy
  progress.service.ts
  quizzes.service.ts
  certificates.service.ts  certificate.processor.ts
  reviews.service.ts  qa.service.ts
  search.service.ts
  analytics.service.ts
  controllers/                # studio, catalog, learn, admin
  permissions.ts  courses.module.ts  courses-worker.module.ts  index.ts
```

---

### Task 1: Course model, categories, studio CRUD and policy

**Interfaces — produces:**
- Models: `Category(id, slug @unique, name, position, isActive)`; `Course(id, ownerType USER|ORG, ownerId, slug @unique, title, subtitle?, description, categoryId, level, language (ISO 639-1), tags String[], pricePaise BigInt, thumbnailAssetId?, promoVideoAssetId?, status DRAFT|IN_REVIEW|PUBLISHED|ARCHIVED, flaggedAt?, flagReason?, publishedAt?, createdById, createdAt, updatedAt, ratingAvg?, ratingCount Int @default(0), enrolmentCount Int @default(0))`.
- `CoursePolicy.canAuthor(user, course)`, `canCreateFor(user, ownerType, ownerId)` (creator for USER — `isCreator`; org_owner/org_instructor for ORG via exported RBAC lookups), `canModerate(user)`.
- Studio endpoints: `POST /v1/studio/courses` (`course.create`), `GET /v1/studio/courses` (mine + my orgs), `GET/PATCH/DELETE /v1/studio/courses/:id` (DELETE only DRAFT never-published), thumbnail/promo via `MediaService.attach`.
- Price validation per Global Constraints → `COURSE_PRICE_INVALID`. Slug generated from title, unique, immutable after first publish.
- Categories: seeded; admin CRUD `course.categories.manage`.
- Permissions: `course.create`, `course.review`, `course.manage_any`, `course.categories.manage` — creator role gets `course.create`; org_owner/org_instructor get org-scoped authoring via policy; moderator gets `course.review`.
- [ ] TDD: creator creates/edits own course; non-creator `CREATOR_REQUIRED`; org_instructor edits org course, org_learner cannot; price ₹50 rejected, ₹0 and ₹99 accepted; another creator → 404.
- [ ] Commit `feat: course studio and categories`.

### Task 2: Curriculum

**Interfaces — produces:**
- Models: `CourseSection(id, courseId, title, position)`; `Lesson(id, courseId, sectionId, title, type VIDEO|ARTICLE|QUIZ|RESOURCE, position, isFreePreview, isRequired @default(true), videoAssetId?, durationSec?, articleBody? (sanitised Markdown ≤ 50k), resourceAssetId?, quizId?)`.
- Endpoints under `/v1/studio/courses/:id/sections` and `/lessons`: create/update/delete, `PUT .../order` (full ordering in one call, positions dense 0..n).
- Video lessons attach READY `COURSE_LESSON` assets owned by the course owner (org: owned by any org author — ruling: asset owner must be an author of the course); `durationSec` copied from media.
- Article Markdown sanitised server-side (allowlist; no raw HTML, no `javascript:` links).
- Curriculum view for authors (everything) vs public (titles, durations, free-preview flags only).
- [ ] TDD: reorder consistency; attaching another user's asset → `MEDIA_NOT_USABLE`; XSS in article stripped; public view hides video asset ids of non-preview lessons.
- [ ] Commit `feat: course curriculum`.

### Task 3: Moderation and publishing

**Interfaces — produces:**
- `POST /v1/studio/courses/:id/submit` → IN_REVIEW (requires ≥ 1 section, ≥ 1 required lesson, every VIDEO lesson READY, thumbnail set, `max_published_courses` entitlement check counting PUBLISHED courses of the owner) else `COURSE_NOT_PUBLISHABLE` with `details.reasons[]`.
- Moderator queue `GET /v1/admin/courses/review-queue` (`course.review`), `POST .../:id/approve` → PUBLISHED (+ `publishedAt`, outbox `course.published`), `POST .../:id/reject { reason }` → DRAFT with reason; audit; notify authors.
- Already-published courses: edits apply live; `POST /v1/admin/courses/:id/flag { reason }` → hidden from catalog (existing learners keep access); `unflag`.
- `POST /v1/studio/courses/:id/archive` → ARCHIVED (hidden from catalog, enrolled keep access, no new sales).
- [ ] TDD: submit incomplete course → reasons; Free plan 4th publish → `ENTITLEMENT_LIMIT_REACHED`; reject → DRAFT with reason, resubmit → queue; flagged course not purchasable but enrolled learner still learns.
- [ ] Commit `feat: course moderation and publishing`.

### Task 4: Sellable, enrolment, org free access, refund eligibility

**Interfaces — produces:**
- Model `Enrolment(id, courseId, userId, source PURCHASE|FREE|ORG_SEAT, orderId?, createdAt, revokedAt?, completedAt?, progressPct Int @default(0)) @@unique([courseId, userId])` (revoked rows reactivated on re-purchase).
- `CourseSellable` (`type: "COURSE"`) registered in BOTH API and worker modules: `describe` → title, price, seller owner, `purchasable` (PUBLISHED, not flagged/archived, price > 0, buyer not enrolled, buyer not an author/org member of the seller org); `onPaid` → enrolment (idempotent; course unpublished meanwhile still enrols); `onRefunded` → revoke.
- `POST /v1/courses/:slug/enrol` for free courses and org learners (`ORG_SEAT`): org_learner of the owning org enrols without checkout regardless of price. Org membership removal (outbox from orgs — add `org.member_removed` event if missing) → revoke `ORG_SEAT` enrolments only.
- `CourseRefundEligibility`: within 7 days AND completed required lessons < 30% → eligible, else `REFUND_NOT_ELIGIBLE` with reason.
- `GET /v1/me/learning` (my enrolments with progress), course `enrolmentCount` maintained.
- [ ] TDD (Review Focus 2, 3, 5): webhook-first fulfilment in the worker enrols once; price changed after checkout → order keeps snapshot; author can't buy own; org_learner free enrol; removal revokes ORG_SEAT only; 35% completed → refund not eligible.
- [ ] Commit `feat: course enrolment and sellable`.

### Task 5: Learner player access

**Interfaces — produces:**
- `CoursePlaybackPolicy` registered into `PLAYBACK_ACCESS_POLICY`: allows playback of a lesson's `videoAssetId` when the user is enrolled (not revoked), or the lesson is free preview of a PUBLISHED course, or the user is an author/`course.manage_any`.
- `GET /v1/learn/courses/:slug` → full curriculum + my progress; `GET /v1/learn/lessons/:id` → lesson content (article body, resource download URL — presigned 5 min, video asset id for the playback endpoint); non-enrolled → 403 `COURSE_NOT_ENROLLED` (free preview allowed).
- Public catalog page `GET /v1/courses/:slug` (PUBLISHED, not flagged).
- [ ] TDD (Review Focus 1): non-enrolled playback 403; free preview OK; refunded learner 403 immediately (no cache); archived course still playable by enrolled.
- [ ] Commit `feat: course learner access`.

### Task 6: Progress

**Interfaces — produces:**
- Model `LessonProgress(userId, lessonId, courseId, positionSec, watchedSec, completedAt?, updatedAt) @@id([userId, lessonId])`.
- `PUT /v1/learn/lessons/:id/progress { positionSec }` (heartbeat, rate limit 1/5 s per lesson): `watchedSec` increases by at most `min(Δposition, 2 × Δwallclock)`; completion at `watchedSec ≥ 0.9 × durationSec`; `POST .../complete` for ARTICLE/RESOURCE.
- Course `progressPct` = completed required lessons / required lessons, recomputed on change; `enrolment.completedAt` when 100% and all quizzes passed → outbox `course.completed`.
- [ ] TDD (Review Focus 4): jumping position to the end doesn't complete; real-time heartbeats do; non-enrolled → 403; progress resume position returned.
- [ ] Commit `feat: course progress`.

### Task 7: Quizzes

**Interfaces — produces:**
- Models `Quiz(id, courseId, passPct @default(70))`, `QuizQuestion(id, quizId, prompt, kind SINGLE|MULTIPLE, options Json, correct Json (never returned to learners), position)`, `QuizAttempt(id, quizId, userId, answers Json, scorePct, passed, createdAt)`.
- Studio CRUD for quizzes inside QUIZ lessons. Learner `GET` returns questions without `correct`; `POST /v1/learn/quizzes/:id/attempts { answers }` → score, passed; 1-minute cooldown (`QUIZ_COOLDOWN`); correct answers revealed only after passing; passing marks the QUIZ lesson completed.
- [ ] TDD: correct answers never in learner responses before passing; scoring for multiple-choice requires exact set; cooldown; pass completes lesson.
- [ ] Commit `feat: course quizzes`.

### Task 8: Certificates

**Interfaces — produces:**
- Model `Certificate(id, code @unique, courseId, userId, issuedAt, objectKey, revokedAt?)`.
- On `course.completed` (idempotent) → certificate with code (10 chars from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`), PDF (learner display name — Noto fonts incl. Devanagari, course title, creator/org name, issue date, verify URL) to R2 private; `GET /v1/me/certificates`, `GET /v1/certificates/:code` (`@Public`, verify view: name, course, date, valid/revoked — no email), `GET /v1/certificates/:code/download` (owner → presigned).
- Refund after completion revokes the certificate.
- [ ] TDD: completion issues exactly one certificate; verify page public and without PII beyond name; refund revokes.
- [ ] Commit `feat: course certificates`.

### Task 9: Reviews and Q&A

**Interfaces — produces:**
- `Review(id, courseId, userId, rating 1-5, body?, createdAt, updatedAt, reply?, repliedAt?, hiddenAt?) @@unique([courseId, userId])`; enrolled (active) only; edit own; author reply once (edit allowed); `course.ratingAvg/Count` maintained in the same tx; shown only when count ≥ 3 (API returns `ratingAvg: null` below that).
- `Question(id, lessonId, courseId, userId, body, createdAt, hiddenAt?)`, `Answer(id, questionId, userId, body, isInstructor, createdAt, hiddenAt?)`; enrolled or authors only; report → Phase 1 moderation? (no reports module yet — add `hiddenAt` + moderator hide endpoint `course.review`).
- Notifications: author on new review/question; learner on reply/answer.
- [ ] TDD: non-enrolled review 403; second review → update not duplicate; rating hidden below 3; author reply; moderator hide.
- [ ] Commit `feat: course reviews and q&a`.

### Task 10: Search and catalog

**Interfaces — produces:**
- Generated `searchVector tsvector` column (title A, subtitle B, tags B, description C, owner display name C — owner name denormalised on the course and refreshed on profile/org rename events) with GIN; `pg_trgm` GIN on title.
- `GET /v1/courses?q=&category=&level=&language=&price=free|paid&minPrice=&maxPrice=&minRating=&sort=relevance|newest|rating|popular&cursor=&limit=` (`@Public`) — PUBLISHED, not flagged; relevance = `ts_rank` + trigram similarity fallback when `q` has no lexeme matches; popularity = enrolments in last 30 days (materialised counter refreshed hourly).
- `GET /v1/categories` public.
- [ ] TDD: typo query "javascrpt" finds "JavaScript"; filters combine; flagged/draft never returned; cursor pagination stable across sorts.
- [ ] Commit `feat: course search and catalog`.

### Task 11: Creator analytics, wiring, docs

**Interfaces — produces:**
- `GET /v1/studio/courses/:id/analytics?from&to` — enrolments, revenue (sum of PAID order seller share for this course from Phase 2 via an exported billing query), completion rate, rating; per-lesson drop-off and watch-time only if owner's `analytics_level` ≠ `basic` (else omitted with `upgradeRequired: true`).
- Worker boot test lists new handlers; API boot test; openapi regenerated; README Phase 3 section; storage quota for ORG-owned course media now enforced (Phase 2 deferral).
- [ ] TDD: basic plan hides drop-off; revenue equals seller PENDING+AVAILABLE postings for the course's orders.
- [ ] Commit `chore: course analytics, wiring, docs`.

## Phase 3 exit check

- [ ] Creator builds a course with a video lesson, article and quiz → submit → moderator approves → published.
- [ ] Learner buys it in Razorpay test mode → plays the lesson through the edge gate → completes → certificate verifies publicly.
- [ ] Refund inside the window with < 30% progress works; after 30% it's refused.
