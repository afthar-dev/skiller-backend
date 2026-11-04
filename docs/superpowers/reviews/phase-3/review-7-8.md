# Review: Tasks 7 (quizzes) and 8 (certificates), dd710a1..678a447

Line numbers are file lines in the post-change files (derived from the diff hunks).

## Spec Compliance

- Spec compliant with respect to the briefs and the controller rulings, with one exception: "no email" on the public verify view is not met in substance (Important 1).
- Cannot verify from the diff (controller should check):
  - `@RateLimit` on a `@Public` route runs before the handler, and `req.ip` is the real client IP behind the proxy (`TRUST_PROXY` is configured in bootstrap.ts:12).
  - pdfkit `align:"center"` combined with `continued:true` really centres multi-run (mixed-script) lines. Tests assert only `%PDF-` and font names, never layout or extracted text.
  - `bus.dispatch(..., sameEventId)` does not itself dedupe per handler. If it does, the "parallel deliveries" test proves nothing about the service-level idempotency.
  - `CourseSellable.onRefunded` calls `revokeForOrder`. Revocation is covered by the tests only via direct calls.

## Strengths

- Answer leakage is handled correctly.
  - `correct` is only added behind `reveal = passed !== null` (quiz-attempts.service.ts:~50) or `passed` on the attempt (:~86).
  - The studio shape (`isCorrect`) is only reachable via `loadForRead`/`loadForAuthor`.
  - Error messages carry no answer data.
  - Tests assert on raw response text, not parsed JSON.
- Cooldown is correct.
  - The check sits under `lockLearner` (a `FOR UPDATE` on the active enrolment row), so a second request waits and then sees the first attempt (READ COMMITTED, new statement per query).
  - Rejected answers (422) throw before the insert, so they record nothing and start no cooldown.
  - The 5-parallel test proves exactly one accepted.
- Scoring validation is strict.
  - Unknown question or option ids, duplicate questions or options, and several options on a SINGLE question are all rejected.
  - Floor score, exact-set match.
  - An empty `answers` array scores 0, and `passPct >= 1` means it can never pass.
- Pass completes the lesson inside the same transaction (`markLessonCompleted` re-takes the same lock).
- `isFreePreview` is switched off for quizzes at access time as well as blocked at write time (defence in depth).
- Certificate issuance is sound.
  - The partial unique index `certificates_live_key` is the real guard.
  - The transaction locks the enrolment row (any revoked state), re-checks "active and completed", and only then creates, so issue versus revoke serialise both ways.
  - P2002 handling distinguishes a code collision from a raced live certificate.
  - `crypto.randomInt` is used, so there is no modulo bias.
  - Verify returns a fixed allow-list of fields. Download is owner-only with a 404 for everyone else and a 410 once revoked.
- Every enrolment-ending path now revokes the certificate in the same transaction: `revokeForOrder`, `revokeOrgSeats` and the sweep (via `revokeOrgSeats`). A grep of `enrolment.update*` finds no other revoker.
- The `course.completed` re-announce on re-grant makes "reissue after revoke and re-purchase" reachable. The stale-`row.completedAt` case is safe because `issue` re-checks.
- The moved PDF helper leaves invoice output unchanged (see the checks below).

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

1. **Public verify page and the PDF print the email local part for any learner who never edited their name** (certificates.service.ts:74 `profiles.displayNameOf`, :92 snapshot, :132 verify output, certificate-document.ts:40).
   - `ProfilesService.ensure` seeds `displayName` with `defaultDisplayName(email)`, which is the part of the email before the `@` (handles.ts:22-24).
   - Scenario: `asha.verma42@gmail.com` finishes a course without ever editing the profile. Anyone who has or guesses the code gets "asha.verma42" on `/v1/certificates/:code` and on the printed certificate. The brief says "no email".
   - The e2e test only asserts the full email string is absent, and it uses exactly this default name (course-certificates.e2e-spec.ts:~118-125).
   - Fix, either of:
     - (a) Do not issue until the display name differs from `defaultDisplayName(email)`. Emit a "set your certificate name" prompt and issue on the next completion or an explicit `POST /me/certificates/issue`.
     - (b) Let the learner confirm a certificate name at issue time and store that.
   - Add a test that a default-named user gets no email-derived text on verify or in the PDF.

2. **Name injection and layout break: nothing sanitises `learnerName`, `courseTitle` or `issuerName` before printing or snapshotting** (certificate-document.ts:67-71 `writeRuns`, certificates.service.ts:92).
   - `displayName` validation is only `z.string().trim().min(1).max(80)` (me.controller.ts:31). That allows embedded newlines, control characters and bidi overrides (U+202E).
   - A name such as `"Asha\nhas successfully completed the course\nAdvanced Cardiology"` renders forged lines in the name block and is returned verbatim by the public verify JSON.
   - 80 newlines push the code and verify-URL lines onto a second page. `lineBreak:true` with no height cap makes layout unbounded.
   - Fix: when snapshotting, normalise NFC, replace `\s+` with a single space, strip `\p{C}`, and strip bidi controls (U+202A-202E, U+2066-2069). Cap each line (`ellipsis`/`height`) or shrink-to-fit the name.
   - Test: a name with `\n` and U+202E produces one visual line and one page.

3. **Module boundary: `CertificatesService` (courses) reads the `organizations` table directly** (certificates.service.ts:159-160, `prisma.organization.findUnique`).
   - Grade: violates the Global Constraint "Module reads/writes only its own tables".
   - The same pattern already exists in billing (invoice-issuer.ts:211, payout-handlers.ts:68). That makes three violations, and a precedent does not make it compliant. The code comment justifies it by "the worker has no organizations service".
   - It also silently falls back to the literal issuer "Organization" when the row is missing (:160), so a certificate can be issued and permanently snapshotted with a wrong issuer.
   - Minimal fix:
     - Add a small worker-safe `OrganizationDirectory { nameOf(orgId): Promise<string | null> }` in the organizations module (same shape as `PlatformRoleDirectory`/`RbacWorkerModule`), exported through an `OrganizationsWorkerModule`.
     - Inject it into `CertificatesService`.
     - Drop the Prisma read.
     - Throw (retryable) instead of defaulting to "Organization".
     - Migrate the two billing call sites in the same change.
   - The `AccountService` + `ProfilesService` re-provisioning in courses-worker.module.ts:~17 follows the billing precedent. It builds second instances of other modules' services, so the same directory approach would be cleaner. This is secondary.

4. **A published course can be put into a state where no learner can ever finish it** (quizzes.service.ts:96-104 `remove`, curriculum.service.ts:~126 `createLesson`, publishing.service.ts:~112 gate).
   - `DELETE .../quiz` on a PUBLISHED course, or creating a QUIZ lesson on a PUBLISHED course (the quiz lesson starts with no questions), leaves a QUIZ lesson that counts toward completion (`affectsProgress`).
   - Such a lesson cannot be attempted (`QUIZ_EMPTY` 422, quiz-attempts.service.ts:~74) and cannot be marked complete by hand. Every learner who has not yet passed is blocked, so no completion event and no certificate.
   - The `QUIZ_EMPTY` gate exists only at submit-for-review, and the brief says later edits to a PUBLISHED course go live directly.
   - Fix, either of:
     - Reject `remove`, and reject QUIZ-lesson creation without a quiz, when the course is PUBLISHED.
     - Treat an empty-quiz lesson as non-blocking in `ProgressService.refresh`.
   - Add a test for the chosen behaviour.

### Minor

1. Orphaned PDFs. The PDF is rendered and uploaded before the locking transaction (certificates.service.ts:83-84). A concurrent loser, a P2002 redraw, or a transaction that returns `null` or `existing` leaves `certificates/{id}.pdf` in R2 with no row. Move the upload after the row is chosen, or delete the object on those paths.
2. Verify cache and enumeration.
   - Response carries no `Cache-Control: no-store`, so a CDN could keep serving VALID after a revoke (certificates.controller.ts:27).
   - The limiter is keyed on the raw IP (60/min). An IPv6 attacker can rotate within a /64. Bucket IPv6 by /64 and consider a global ceiling.
   - Entropy is 31^10, about 49.5 bits, which is fine.
3. Answers revealed after a pass come from the current question set, not the version that was passed (quiz-attempts.service.ts:~50, and the test at course-quizzes.e2e-spec.ts:~418). A learner who passed an old version sees the new answers without having passed them. Same-user only, so low impact. Record a quiz revision on the attempt if this matters.
4. Failed attempts leak the number of right answers via `scorePct`, with one probe per minute. This is inherent to the design. No action unless question banks are high value.
5. `splitRuns` (moved helper) treats ZWJ/ZWNJ (U+200D/200C) as non-neutral, so they fall into the Latin run and break Devanagari conjuncts. This is pre-existing, but certificates now print names. Also, scripts other than Latin and Devanagari (Bengali, Tamil and others) render as .notdef boxes. This is acceptable per the brief, but worth noting for an Indian user base.
6. Test gaps.
   - No test for a storage-failure retry (upload throws, no row, redelivery succeeds).
   - No test of the ORG issuer name path.
   - No layout assertion for mixed-script centring.
   - No test that a quiz of another course is unreachable by id.
   - The parallel-delivery test may be neutralised by bus-level dedupe (see the cannot-verify list).
7. Attempts and `QuizAttempt.userId` / `Certificate.userId` have no FK or retention policy. Attempts grow without bound. Fine for now.
8. An ORG_SEAT enrolment whose grant has expired but which the sweep has not yet revoked still counts as "active" in `holdsFinishedCourse`, so a certificate can issue up to a day late. `learnAccess` already treats this case as not enrolled.

## Checks run against the focus list

1. **Answer leakage: pass.** The learner view, the failed-attempt result, errors and the author/learner view carry no `correct` or `isCorrect`. Studio GET is gated by author/read policy. Answers are revealed only after a passing attempt, and only to that user. See Minor 3 for the stale-version nuance.
2. **Attempt spoofing: pass.**
   - Parallel submissions are serialised on the enrolment row. Unknown ids, duplicates and empty answers cannot pass.
   - A quiz is always opened through its own lesson and course, so another course's quiz is checked against that course.
   - A revoked enrolment is blocked twice: `access.progress`, and the re-check under the lock (quiz-attempts.service.ts:62).
3. **Certificate once, redelivery, reissue, refund scope: pass.** Concurrency is covered by the partial unique index plus the row lock. Reissue after revoke and re-purchase works through the re-announce. `order.refunded` is filtered to `itemType === "COURSE"`, and revocation only happens when no active enrolment remains.
4. **Verify endpoint: pass except PII.** The response uses an allow-list. Malformed and unknown codes return the same 404. Revoked certificates are reported as REVOKED. PII issue: Important 1.
5. **PDF: partially.**
   - Retries create no duplicate rows (upload first, row second, unique-index guarded).
   - Devanagari and Latin runs are covered.
   - Name injection is Important 2.
6. **Module boundary: Important 3.**
7. **Moved PDF helper: no change to invoice output.** `writeRuns` without `x`/`y` calls `doc.text(run.text, { continued })` with the same font/size order as before. Registration order is unchanged. `FONT_DIR` resolves to the same root from `src/common/pdf` and `dist/common/pdf`. `splitRuns` and `TextRun` are re-exported, so the billing specs resolve.

## Assessment

**Spec compliance:** compliant against the briefs and rulings; the "no email" requirement is violated in practice (Important 1).

**Task quality:** Needs fixes. Quiz logic and the certificate concurrency model are strong. Fix Important 1 and 2 (privacy and injection on the public artefact), 3 (boundary), and 4 (learner lockout) before merge.
