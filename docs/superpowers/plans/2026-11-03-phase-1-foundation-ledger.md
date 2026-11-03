# SDD ledger — plan: docs/superpowers/plans/2026-11-03-phase-1-foundation.md
Spec: docs/superpowers/specs/2026-11-03-skiller-platform-redesign-design.md
Setup: Ruling: Node 24 used instead of 22 (installed toolchain) — Nest 11/Prisma 6 support it — cost if wrong: pin engines later
Setup: Ruling: ffmpeg via ffmpeg-static/ffprobe-static devDeps for tests; worker image apt ffmpeg — no system ffmpeg on dev box — cost if wrong: minor codec drift
Setup: Ruling: work on branch phase-1-foundation in fresh repo (no worktree; repo just created) — cost if wrong: none
Pre-flight: T7 consumes MemberRoleGranter → T10 produces RolesService.grantSystem — consistent (rebind in T10)
Pre-flight: T7 UserStatusCache → T17 consumes bust() — consistent
Pre-flight: T11 avatar/banner → T13 MediaService.attach — deferred wiring to T13, consistent
Pre-flight: T4 DomainEvent union → T5/T11/T12/T13/T16 consume event names — consistent
Task 1: Ruling: added src/bootstrap.ts configureApp() shared by main.ts and e2e — tests must hit real prefix/middleware — cost if wrong: none
Task 1: Ruling: jest.config.js (not .ts) and eslint.config.mjs flat config (ESLint 9) instead of .eslintrc.cjs — tooling versions — cost if wrong: none
Task 1: Ruling: added optional R2_ENDPOINT config (default Cloudflare endpoint) — needed for MinIO in tests — cost if wrong: none
Task 1: complete (commits 8e3d749..da937e4, tests: npx jest --selectProjects unit e2e → Ran all test suites in 2 projects.)
Task 2: complete (commits da937e4..7b25d93, tests: npx jest --selectProjects unit e2e → Ran all test suites in 2 projects.)
Task 2: Ruling: ErrorFilter takes isProduction ctor arg; maps HttpException by status; sets Retry-After from details.retryAfterSec (for Task 3) — cost if wrong: none
Task 2: Ruling: Testcontainers started once per jest run via globalSetup (env inherited by workers), not per suite — speed — cost if wrong: tests must use unique data, no truncation between suites
Task 2: Ruling: uuid pinned to v10 (v11+ ESM-only breaks ts-jest CJS) — cost if wrong: none
Task 2: Ruling: migrations authored against local docker container `skiller-mig` (postgresql://postgres:p@localhost:55432/skiller) via `pnpm db:migrate:new <name>` — cost if wrong: none
Executor: Ruling: user switched mid-run to Sonnet helpers. Tasks 3-18 implemented by Sonnet subagents, one per task group (3-5, 6-8, 9-12, 13-15, 16-18) instead of one per task; one Sonnet task-review per group; final whole-branch review on Opus — user asked to reduce token use — cost if wrong: coarser review gates, defects found later
Task 3-5: Ruling (implementer): svix pinned 1.45.1 (2.x ESM-only) — cost if wrong: none
Task 3-5: Ruling (implementer): @react-email/render dropped; react-dom/server renderToStaticMarkup + html-to-text — Jest VM rejects dynamic import — cost if wrong: minor template rendering differences
Task 3-5: Ruling (implementer): Resend client via fetch (no SDK), Idempotency-Key, 4xx (≠429) UnrecoverableError — cost if wrong: none
Task 3-5: Ruling (implementer): app created with { rawBody: true } in main.ts and test harness for webhook signature — cost if wrong: none
Task 3-5: Ruling (implementer): outbox relay on maintenance queue repeat 1s; JobProcessor jobNames filter — cost if wrong: none
Task 3-5: Ruling (controller): commit trailer from Sonnet helpers left as-is (accurate authorship) — cost if wrong: cosmetic
Task 3-5: Ruling (controller): outbox handlers must be idempotent (at-least-once); carried into later dispatches — cost if wrong: duplicate notifications/emails
Task 3-5: minor (deferred): 9 minors listed in .superpowers/sdd/2026-11-03-phase-1-foundation/docs/superpowers/reviews/phase-1/review-3-5.md (vacuous client.sent assertion, retry/backoff unasserted, unmatched job names dropped silently, no /v1/ready timeout, …)
Task 3-5: Ruling (controller): scoped re-review of 3.6KB test-only fix diff done by controller instead of a dispatched re-reviewer — token budget — cost if wrong: weak gate on that one test
Task 3-5: fix round 1/5 (1 addressed, 0 open — outbox relay concurrency test now fails without row lock; commits 06925d9..0675ef3)
Task 3: complete (commits 7b25d93..fd9a2b5, review clean after round 1)
Task 4: complete (commits fd9a2b5..0675ef3, review clean after round 1)
Task 5: complete (commits 98a767d..06925d9, review clean)
Task 6-8: Ruling (implementer): OtpService.verify(challengeId, code, {purpose?, userId?}) — purpose/user filter inside atomic UPDATE so wrong-purpose attempts don't burn attempts — cost if wrong: none
Task 6-8: Ruling (implementer): camelCase quoted columns (matches outbox), not snake_case — cost if wrong: inconsistent naming vs spec @@map convention (tables still mapped)
Task 6-8: Ruling (implementer): injected Clock passed into SQL instead of now() — cost if wrong: none
Task 6-8: Ruling (implementer): sliding refresh expiry (rotation resets expiresAt to +30d) — brief silent — cost if wrong: sessions live indefinitely while active
Task 6-8: Ruling (implementer): suspended user refresh/OTP login → 403 AUTH_ACCOUNT_SUSPENDED — cost if wrong: none
Task 6-8: Ruling (implementer): IdentityModule @Global(); @RateLimit variadic; jsonwebtoken@9 added — cost if wrong: none
Task 6-8: Ruling (controller): "step-up valid 5 minutes" = step-up grant TTL 300s; STEP_UP challenge keeps the global OTP TTL 10 min — spec §4 reads as grant validity — cost if wrong: step-up code usable 5 min longer
Task 6-8: Ruling (controller): re-graded minor "plaintext OTP in BullMQ job data 1h-7d" to Important — secret at rest in Redis — cost if wrong: none
Task 6-8: Ruling (controller): revocation fix = Redis marker written first with 3 retries, then DB; Redis failure → 503 SERVICE_UNAVAILABLE (fail closed, nothing revoked half-way); revokeFamily still returns 401 AUTH_TOKEN_REUSED; Redis must run maxmemory-policy noeviction (documented) — cost if wrong: logout 503s during Redis outage
Task 6-8: minor (deferred): 12 remaining minors in docs/superpowers/reviews/phase-1/review-6-8.md (no absolute session cap, vacuous assert auth.e2e:26, no JWT alg negative test, FakeClock reset, no verify/refresh rate limit, status cache race, concurrent OTP request, single previous hash, session create outside tx, email bucket consumed before IP check, logout needs live token, step-up challenge TTL untested)
Task 6-8: fix round 1/5 (4 addressed, 0 open — trust proxy, revoke ordering, per-user step-up limit, OTP job retention; commits 6577568..71c1fee)
Task 6-8: minor (deferred): 3 from re-review in redocs/superpowers/reviews/phase-1/review-6-8.md (user bucket burned before IP check, marker without DB revoke on DB failure, TRUST_PROXY misconfig spoofing documented only)
Task 6: complete (commits 0675ef3..782c046, review clean after round 1)
Task 7: complete (commits 782c046..450dfad + fix 71c1fee, review clean after round 1)
Task 8: complete (commits 450dfad..6577568 + fix 71c1fee, review clean after round 1)
Executor: Ruling: group 9-12 split into two dispatches (9-10, 11-12) — context size — cost if wrong: one more review seat
Task 9-10: Ruling (implementer): ROLE_ESCALATION_DENIED also on role create/update-added perms/revoke; super_admin perms update → ROLE_SYSTEM_PROTECTED; RolesService(actorId, ..., meta{ip,requestId}) — cost if wrong: none
Task 9-10: Ruling (implementer): grantSystem audits but emits no role.granted event — cost if wrong: no in-app notice for system grants (acceptable)
Task 9-10: Ruling (implementer): test global-setup runs prisma db seed; signup 500 ROLE_NOT_FOUND on unseeded DB — cost if wrong: deploy must seed (release step)
Task 9-10: Ruling (controller): seed/sync must not depend on ts-node in production → carried to Task 18 (compile seed into dist, release cmd uses node) — cost if wrong: release step fails
Task 9-10: Ruling (controller): permission cache fix = per-user epoch in key (perm:{userId}:{epoch}); invalidation INCRs epoch; post-commit bump with 3 retries + outbox event `rbac.permissions_changed {userIds}` in same tx as backstop (worker re-bumps; INCR idempotent enough) — cost if wrong: stale perms only until outbox relay (~1s) on Redis failure
Task 9-10: Ruling (controller): last-super-admin count excludes SUSPENDED/DELETED users (re-graded from "cannot verify" to Important) — lockout risk — cost if wrong: none
Task 9-10: minor (deferred): 8 minors in docs/superpowers/reviews/phase-1/review-9-10.md (seed grants unaudited, role read outside tx before escalation check, 403 discloses permission key, grantSystem no scope check, boot check ignores inherited handlers, class-level RequirePermission + method Public → 401, TTL rounding 1s, orgId unvalidated)
Task 9-10: fix round 1/5 (3 addressed, 1 new open — epoch key TTL reset can revive stale cache entry; commits 5f1d202..c90e5f2)
Task 9-10: Ruling (controller): epoch keys get no TTL (persist; one tiny key per user) — simplest correct fix — cost if wrong: few bytes per user in Redis
Task 9-10: minor (deferred): 5 minors in redocs/superpowers/reviews/phase-1/review-9-10.md
Task 9-10: fix round 2/5 (1 addressed, 0 open — epoch keys no TTL; commits c90e5f2..ea909dd; controller re-review of 5-line diff)
Task 9: complete (commits 71c1fee..1a344ed + fixes c90e5f2, ea909dd, review clean after round 2)
Task 10: complete (commits 1a344ed..5f1d202 + fixes c90e5f2, ea909dd, review clean after round 2)
Task 11-12: Ruling (controller): invite email sent via MailService directly after commit (not outbox `org.member_invited`) — keeps raw token out of outbox; re-invite supersedes orphan — cost if wrong: occasional unsent invite on Redis failure
Task 11-12: Ruling (controller): org owner can never be removed (no ownership transfer in Phase 1) — cost if wrong: none
Task 11-12: Ruling (controller): ⚠️ users.email lower-case verified by Task 6 normalisation; parsePage limits verified by Task 2 tests
Task 11-12: Ruling (controller): duplicate membership fix = invite rejected with ORG_ALREADY_MEMBER if invitee email already holds any role in org; members list aggregates roles per user `{userId, handle, displayName, roles: string[]}` — cost if wrong: role change needs remove+reinvite
Task 11-12: minor (deferred): 12 minors in docs/superpowers/reviews/phase-1/review-11-12.md
Task 11-12: fix round 1/5 (3 addressed, 0 open — identity boundary, WEB_BASE_URL, membership dedupe; commits 453ff96..420986a; controller re-review of diff)
Task 11: complete (commits ea909dd..021701a + fix 420986a, review clean after round 1)
Task 12: complete (commits 021701a..453ff96 + fix 420986a, review clean after round 1)
Executor: Ruling: media group split 13-14 then 15 — context size — cost if wrong: none
Task 13-14: Ruling (implementer): MinIO test image cgr.dev/chainguard/minio (Docker Hub denied), override MINIO_IMAGE — cost if wrong: none
Task 13-14: Ruling (implementer): Dockerfile.worker node:24-bookworm-slim, pnpm 10.17.1 pinned, --ignore-scripts — cost if wrong: none
Task 13-14: Ruling (implementer): MediaAsset.filename nullable column; no upscaling of image variants; 0.5s duration tolerance; course_resource READY on complete — cost if wrong: none
Task 13-14: Ruling (controller): upload abuse caps = 30 createUpload/hour/user (consumeRateLimit) + max 10 PENDING per user → 429 UPLOAD_LIMIT_REACHED — cost if wrong: power users hit cap
Task 13-14: Ruling (controller): all sources upload to PRIVATE bucket `incoming/{assetId}/source` regardless of purpose; worker writes processed outputs to target bucket; source deleted after READY except COURSE_LESSON (kept private for reprocessing) — fixes public-source EXIF/HTML risk — cost if wrong: extra copy cost
Task 13-14: Ruling (controller): presigned PUT signs Content-Length + Content-Type; UploadPart URLs sign per-part Content-Length; single-PUT URL TTL 15 min; complete records ETag; worker GETs with IfMatch etag, re-checks size ≤ maxBytes, streams to temp file (no full buffer) — cost if wrong: none
Task 13-14: Ruling (controller): ffmpeg hardening = probe/transcode on local temp file with `-protocol_whitelist file`, container allowlist (mov/mp4/m4a/3gp/3g2/mj2, matroska/webm), execFile timeouts (probe 30s, transcode 30 min, SIGKILL) — cost if wrong: rare valid files rejected
Task 13-14: Ruling (controller): duration = max(format, stream durations); no tolerance (reject > 90.0 s); transcode with `-t 90` cap for reels — spec says ≤90 s — cost if wrong: clips at 90.2 s rejected
Task 13-14: Ruling (controller): content verification — images sharp meta.format ∈ {jpeg,png,webp} matching declared family; course_resource magic bytes (%PDF- or PK\x03\x04) before READY → else FAILED MEDIA_TYPE_MISMATCH — cost if wrong: none
Task 13-14: Ruling (controller): replacing/clearing avatar/banner/logo calls MediaService.detach(tx, oldAssetId) setting attachedAt=null, detachedAt=now; cleanup deletes detached > 24h — cost if wrong: none
Task 13-14: minor (deferred): 8 minors in docs/superpowers/reviews/phase-1/review-13-14.md
Task 13-14: Ruling (controller, revises earlier): reel duration measured on video streams (format duration only if no stream durations), accept ≤ 90.1 s; output hard-capped with -t 90 so tolerance cannot leak — strict 90.0 rejected real phone reels with AAC padding — cost if wrong: none
Task 13-14: fix round 1/5 (8 addressed, 1 new open — shared asset detached for all targets; commits 99af4d3..614b544)
Task 13-14: Ruling (controller): an asset may have exactly one attachment; attach of an already-attached asset (other than re-attaching to the same target) → MEDIA_NOT_USABLE — simplest invariant — cost if wrong: user must re-upload to reuse an image
Task 13-14: minor (deferred): 5 minors in redocs/superpowers/reviews/phase-1/review-13-14.md
Task 13-14: fix round 2/5 (2 addressed, 0 open — single-attachment invariant, reel duration on video stream ≤90.1s; commits 614b544..728f8e1; controller re-review from report + stat)
Task 13: complete (commits 420986a..82fed1c + fixes 614b544, 728f8e1, review clean after round 2)
Task 14: complete (commits 82fed1c..99af4d3 + fixes 614b544, 728f8e1, review clean after round 2)
Task 15: Ruling (implementer): playback path = real R2 key `course_lesson/{ownerId}/{assetId}/hls/index.m3u8`; token `a` must equal assetId segment — Worker has no DB — cost if wrong: none
Task 15: Ruling (implementer): @cloudflare/vitest-pool-workers 0.23.0 + vitest ^4.1, compat date 2026-08-01; wrangler.toml bucket/origins placeholders — cost if wrong: deploy config to fill
Task 15: Ruling (controller): ⚠️ PLAYBACK_SECRET min length verified (config.schema secret() ≥32, Task 1 test)
Task 15: Ruling (controller): re-graded minor "suffix/open/out-of-bounds Range → wrong Content-Length / 500" to Important — breaks seeking in players — cost if wrong: none
Task 15: Ruling (controller): 10-min token stays (spec); frontend player must re-call /v1/media/:id/playback before expiry and reload manifest (~6 calls/hour, within 120/h) — note for frontend phase — cost if wrong: long lessons stall if frontend ignores it
Task 15: minor (deferred): 5 remaining minors in docs/superpowers/reviews/phase-1/review-15.md (timingSafeEqual untestable, no OPTIONS, HEAD test shallow, localhost in prod ALLOWED_ORIGINS, EXT-X-MEDIA/I-FRAME rewrite untested)
Task 15: fix round 1/5 (4 addressed, 0 open — bucket check test, traversal/extension guard tests with mutation proof, range 206/416; commits 39630c1..7ef1394; controller re-review from mutation evidence)
Task 15: complete (commits 728f8e1..39630c1 + fix 7ef1394, review clean after round 1)
Executor: Ruling: final group split 16-17 then 18 — context size — cost if wrong: none
Task 16-17: Ruling (implementer): AuthGuard checks status before revocation (suspended live token → 403 not 401) — cost if wrong: none
Task 16-17: Ruling (implementer): suspend commits status+audit first, then cache bust (3 retries) + revoke; Redis failure → 503 with suspension in force; idempotent retry — guarantees block via status — cost if wrong: none
Task 16-17: Ruling (implementer): media.failed mail moved into notifications (prefs apply), MediaFailedMailHandler removed; EventBus handlers get {eventId}; MailService.send idempotencyKey; single admin.controller.ts — cost if wrong: none
Task 16-17: Ruling (controller): media.ready notification only for REEL and COURSE_LESSON (not images) — noise — cost if wrong: none
Task 16-17: Ruling (controller): wire settings reel_max_seconds and max_upload_mb_course_lesson into media rules/transcode (read via SettingsService at createUpload/probe time); hold_days stays for Phase 2 — settings must not be no-ops — cost if wrong: none
Task 16-17: Ruling (controller): re-graded minor "session revoke skipped when status-cache bust fails" to Important — suspended user could act up to 60s — fix: always attempt revoke; status cache TTL check falls back... (see dispatch) — cost if wrong: none
Task 16-17: minor (deferred): 9 remaining minors in docs/superpowers/reviews/phase-1/review-16-17.md (revoke-sessions audit separate tx, unsuspend no super_admin escalation check, flag rules {} vs allowUserIds [] semantics, worker wiring untested, …)
Task 16-17: fix round 1/5 (6 addressed, 0 open — unsuspend boundary, LIKE escaping, real index test, suspend fail-closed put SUSPENDED + always revoke, media.ready reel/lesson only, settings wired via global SettingsModule; commits bf63cb3..16e273c; controller re-review of security hunks)
Task 16: complete (commits 7ef1394..66d6ef0 + fix 16e273c, review clean after round 1)
Task 17: complete (commits 66d6ef0..bf63cb3 + fix 16e273c, review clean after round 1)
Task 18: Ruling (implementer): boundaries via ESLint core no-restricted-imports (not eslint-plugin-boundaries) — cost if wrong: none
Task 18: Ruling (implementer): CI uses scripts/check-schema-drift.mjs ignoring only the two text_pattern_ops index statements Prisma misreports — cost if wrong: masks drift on those two indexes
Task 18: Ruling (implementer): @nestjs/swagger pinned 11 (12 ESM-only); 401 documented on authenticated ops only — cost if wrong: none
Task 18: Ruling (implementer): forwardRef in 3 places to break users/media/admin index load-order cycle; openssl installed in both Docker build stages (fixes Task 14 worker image engine mismatch) — cost if wrong: none
Task 18: Ruling (controller): Task 18's task review folded into final whole-branch Opus review — token budget — cost if wrong: Task 18 issues surface at final review instead
Task 18: complete (commits 16e273c..d4629a1, reviewed in final review)
Final review: Opus — merge with fixes; 0 Critical, 5 Important, 2 deferred minors promoted (unsuspend super_admin escalation; WorkerModule boot test), 12 new minors (final-review.md)
Final: Ruling: queue concurrency fix = dedicated queues per processor class: `outbox` (relay+dispatch), `maintenance` (cleanup), `media-transcode` (concurrency 1), `media-light` (image/file, concurrency 4) — BullMQ workers cannot filter by job name — cost if wrong: more queues to monitor
Final: Ruling: part URLs TTL 1 h + `POST /v1/media/uploads/:id/parts {partNumbers}` re-signs parts for PENDING owner uploads (rate-limited) — spec says resumable — cost if wrong: none
Final: Ruling: worker size cap reads the same SettingsService limit as createUpload (single source) — cost if wrong: none
Final: Ruling: outbox dispatch attempts 15, exponential 1 s base capped 30 min (~hours total); failed jobs retained; on exhaustion OutboxEvent.deadAt + lastError set and Sentry capture; worker job failures reported to Sentry; admin can list dead events (`GET /v1/admin/outbox/dead`, audit.view) — cost if wrong: none
Final: Ruling: boot tests for real AppModule (HTTP listen + /v1/health) and WorkerModule (context + all expected EventBus handlers registered) in CI; CI also runs API image with test env and curls /v1/health — cost if wrong: none
Final: fixed I1-I5, M1, M2 — commits d4629a1..4b87f8e, suite 344/344 + edge 74/74; scoped re-review all ADDRESSED, no new Critical/Important
Final: minor (deferred): 12 minors in final-review.md + 6 in redocs/superpowers/reviews/phase-1/review-final.md (relay Sentry noise in DB outage, stale schedulers on existing envs, mail 4xx reported as 500, index rebuild in migration, in-flight uploads fail when size setting lowered, re-sign limit consumed after validation / no replay endpoint)
Final: Ruling: ledger copied to docs/superpowers/plans/2026-11-03-phase-1-foundation-ledger.md before workspace deletion — keeps rulings and deferred minors visible — cost if wrong: none
