# Final whole-branch review: Phase 1 Foundation

Range: `8e3d749..d4629a1` (branch `phase-1-foundation`, 28 commits). Reviewer: Opus, read-only. I did the review myself in several passes: Task 18 artifacts and both bootstraps first, then identity/RBAC/admin, then media/playback/edge, then data integrity and tests, then ledger triage. I did not run the suites, lint or Docker builds (no worktree install). Every finding below comes from reading the code, so each one cites a file and line.

## Strengths

- **Auth core is solid.** OTP verification is one atomic `UPDATE ... RETURNING` with purpose and user binding. Refresh rotation is a compare-and-swap with a 10 s race window, and family revocation is correct (`session.service.ts:58-103`). The JWT verifier pins the algorithm and issuer. Revocation fails closed: the Redis marker is written before the DB update, and the request returns 503 if the marker cannot be written.
- **One global guard with a boot-time check.** `AccessGuard` (`access.guard.ts`) fixes the authN-then-authZ order. `assertAllRoutesGuarded` (`route-guard-check.ts`) refuses to boot when a route has no access decorator. I checked every controller: each route carries `@Public`, `@AuthenticatedOnly` or `@RequirePermission`. Step-up guards role grants, suspend/unsuspend and settings, which matches spec §4.
- **The permission cache cannot serve stale entries.** Invalidation bumps a per-user epoch (`permission.service.ts:8-12,94-98`), and there is an outbox backstop in the same transaction. Role edits, deletes, grants, revokes, org changes and the creator flow all invalidate. Review Focus 3 is tested end to end (`roles.e2e-spec.ts:104`).
- **The last super_admin is protected under concurrency.** Active grants are locked in a fixed order and only ACTIVE users count (`roles.service.ts:297-310`). There are race tests.
- **Suspend fails closed.** The status is committed with its audit row, the cache entry is overwritten with SUSPENDED, and sessions are always revoked (`admin-users.service.ts:111-169`).
- **Media hardening is thorough.**
  - All uploads land in the private bucket first.
  - Presigned URLs sign Content-Length and Content-Type.
  - Worker reads use If-Match on the ETag and stream to a temp file.
  - ffmpeg runs with `-protocol_whitelist file`, a container allowlist and SIGKILL timeouts.
  - Image formats and resource files are checked by content (sharp format, magic bytes).
  - An asset can have exactly one attachment (`media.service.ts:140-159`).
  - The `complete` claim is idempotent and the jobId equals the asset id.
- **The edge gate is tight.** Paths are matched against a strict allowlist and the token must name the asset in the path. Constant-time verification uses `crypto.subtle.verify`. Range/416 handling is correct, and absolute URIs in playlists are never given the token.
- **Outbox and handlers.** The relay uses `FOR UPDATE SKIP LOCKED`, and the jobId equals the event id. Handlers are idempotent: notifications are unique on `(userId, sourceEventId)`, mail uses a jobId plus a Resend Idempotency-Key, `ProfilesService.ensure` uses ON CONFLICT, and the RBAC handler only INCRs.
- **Data integrity.** `user_roles` is unique with `NULLS NOT DISTINCT`. Lower-case handle/slug/email invariants make the plain unique indexes case-insensitive. Mutation, audit and outbox writes share one transaction in RBAC, orgs, admin, settings, flags and creator.
- **Task 18.**
  - Pino and redaction are wired into both processes (`app.module.ts:28`, `worker.module.ts:22`, `main.ts:13`, `worker.ts:10`).
  - The Sentry filter reports only status ≥ 500.
  - The release scripts are compiled, so production needs no ts-node.
  - openssl is in both build stages, which fixes a real latent engine mismatch in the worker image.
  - Containers run as non-root.
  - CI covers lint, typecheck, validate, the drift script, all three jest projects, the edge tests and the OpenAPI diff, then builds both images.
  - The OpenAPI test checks real properties (default error and 401 on secured operations).

## Review Focus (checked one by one)

1. **Two tabs refreshing at once:** implemented (`session.service.ts:93-99`) and tested at `auth.e2e-spec.ts:113`. OK.
2. **Suspended user holding a valid access token:** `AuthGuard` checks status before revocation, and suspend writes SUSPENDED into the cache and revokes the sessions. Tested in auth and admin e2e. OK.
3. **Permission removed from a role takes effect on the next request:** epoch bump after commit, plus the outbox backstop. Tested. OK. (Caveat: if Redis fails the backstop's own delivery, see I-5.)
4. **`complete` twice, or fewer bytes than declared:** conditional claim, and the size mismatch marks the asset FAILED. Tested at `media-upload.e2e-spec.ts:162,191`. OK.
5. **`@Aftab` vs `aftab`, and the last super_admin:** `HANDLE_TAKEN` (`profile.e2e-spec.ts:66`) and `LAST_SUPER_ADMIN` (`roles.e2e-spec.ts:194-268`). OK.

## Critical

None found.

## Important

**I-1. The queue runner merges every processor on a queue into one BullMQ Worker at the highest concurrency.**
- Where: `src/common/queue/queue-worker.runner.ts:22`, together with `transcode.processor.ts:43` (concurrency 1), `image.processor.ts:25` and `file.processor.ts:21` (4).
- What goes wrong:
  - The `media` queue gets one Worker with concurrency 4, so a single worker process runs up to 4 ffmpeg transcodes at once. The comment at `transcode.processor.ts:43` ("ffmpeg saturates the machine") is not honoured.
  - Each transcode can download a 5 GB lesson to `/tmp` and write HLS output beside it. Four concurrent lesson uploads can therefore exhaust disk and CPU and time out (`PROCESSING_TIMEOUT` is permanent).
  - The `maintenance` queue holds both the 1 s `outbox-relay` and the hourly `media.cleanup`, at concurrency 1. While cleanup runs (one DB transaction plus R2 deletes per asset, up to 60 s each, `media-cleanup.processor.ts:84-97`), the relay is blocked. Every domain event waits behind it: notifications, the welcome mail, and the permission-invalidation backstop.
- Fix: give each processor its own Worker. BullMQ cannot filter by job name, so move `media.transcode` and `media.cleanup` onto their own queues (e.g. `media-video`, `media-cleanup`), or make the runner create one Worker per processor and route by queue. Add a unit test that the runner honours per-processor concurrency.

**I-2. Multipart part URLs expire after 15 minutes and there is no way to re-sign them.**
- Where: `src/modules/media/media.rules.ts:7` (`PRESIGN_TTL_SEC = 15 min`) is used for UploadPart URLs at `r2.client.ts:69`. `media.controller.ts` exposes only create and complete.
- Why it is wrong: the plan says "URL TTL 1 h", and spec §7 says parts upload "resumable". The Task 13-14 ruling shortened only the *single-PUT* URL to 15 min, but the constant also governs parts.
- What goes wrong: every part URL is minted at `createUpload`. Uploading the allowed 5 GB lesson in 15 minutes needs about 45 Mbit/s sustained. On a normal connection the later parts get 403 and the upload cannot be resumed; the user must start over and hits the same wall again.
- Fix: use a separate part TTL (≥ 1 h) and add `POST /v1/media/uploads/:id/parts` that re-presigns given part numbers for a PENDING owned asset (optionally ListParts for resume).

**I-3. The admin setting `max_upload_mb_course_lesson` above 5120 MB produces uploads that are guaranteed to fail.**
- Where: `src/modules/admin/settings.registry.ts:8` (max 51200), `media.service.ts:69-70` (createUpload honours the setting), `source-fetch.ts:19` (the worker rejects `head.size > MEDIA_RULES[purpose].maxBytes`, a static 5 GB).
- What goes wrong: an admin raises the limit to 10 GB. A creator uploads a 6 GB lesson, `complete` succeeds, and the worker marks it FAILED with `UPLOAD_SIZE_MISMATCH`, a misleading reason after hours of upload. This contradicts the controller ruling that settings must not be no-ops.
- Fix (any one): store the effective `maxBytes` on the asset at createUpload and check that in `verifySource`; or read the same setting in the worker; or cap the setting at 5120 for Phase 1.

**I-4. Neither real entry point is booted by any automated check.**
- Where: `src/main.ts`, `src/worker.ts`, `src/worker.module.ts`. The forwardRef cycle points are `admin.module.ts:11`, `media.module.ts:13`, `organizations.module.ts:10`, `users.module.ts:11` and `me.controller.ts:101`.
- Evidence:
  - The Task 18 report says a production boot (`node dist/main.js`) failed with an undefined `MediaService` from the users↔media↔admin index cycle. It was fixed with forwardRef and "verified manually by script", and the report notes "there is no automated test for it".
  - Jest loads modules in a different order, so the suites cannot catch this.
  - `WorkerModule` is never compiled in a test (deferred 16-17 #7); only `MediaWorkerModule` is, via `test/support/media-worker.ts`.
  - The CI `docker` job builds both images but never runs them.
- What goes wrong: a future import edge breaks `node dist/main.js` or the worker graph (e.g. a handler module missing from `worker.module.ts:22`), and CI stays green.
- Fix: add a CI step after `pnpm build` that starts `node dist/main.js` and `node dist/worker.js` against the CI Postgres/Redis services, waits for `/v1/ready` and for the "workers started: outbox, mail, media, maintenance" log line, then kills both. Also add one jest test that compiles `WorkerModule` and asserts that EventBus has handlers for `user.registered`, `media.ready`, `media.failed`, `role.granted` and `rbac.permissions_changed`, and that every queue has a processor.

**I-5. Outbox delivery gives up after about 31 seconds, silently.**
- Where: `src/common/queue/queue.module.ts:13` (attempts 5, exponential 1 s for every queue, including `outbox`), `outbox.relay.ts:68-71` (the row is marked `publishedAt` when the job is enqueued), `queue-worker.runner.ts:32` (the final failure is only a `warn` log), `error.filter.ts:39` (Sentry is reported only from the HTTP filter).
- What goes wrong: a handler dependency (Postgres for notifications or profiles, Resend enqueue, Redis INCR) fails for more than about 31 s, i.e. 1+2+4+8+16 s of backoff. The event job then ends in `failed`, and nothing re-delivers it, because the outbox row already says published. Welcome mail, media notifications and the permission-invalidation backstop are lost with no alert. The ledger ruling "outbox handlers must be idempotent (at-least-once)" assumes delivery keeps retrying.
- Fix: give the outbox queue many more attempts with capped backoff (e.g. 25 attempts, about a day). Report exhausted jobs from the worker's `failed` listener to Sentry (`reportException(err, 500)` when `attemptsMade >= attempts`). Document how to replay a failed outbox job.

## Minor (12)

1. **`src/common/observability/logger.ts:11`:** `*.code` also redacts `err.code` and Prisma error codes (P2002, P2025, ...) in error logs, which loses diagnostics. Narrow it to `req.body.code` / `*.body.code`, or accept the loss knowingly.
2. **`logger.ts:30`:** `LOG_LEVEL` is read from `process.env` outside the Zod config. An invalid value throws inside pino at boot with an unhelpful message. Add it to `config.schema.ts`.
3. **`Dockerfile:11,26`:** pnpm 10 runs build scripts only for `onlyBuiltDependencies` (`package.json:93`), so `@prisma/engines` never downloads the schema engine at build time. `npm run release` fetches it from binaries.prisma.sh at release time; that is why the comment says it "needs to write to its engines directory". The release fails in egress-restricted environments. Fetch the engines in the build stage (e.g. `RUN pnpm exec prisma -v` after generate, or add `@prisma/engines` and `prisma` to `onlyBuiltDependencies`). There is also no `HEALTHCHECK` in either image.
4. **`Dockerfile.worker:18`:** Debian bookworm's apt `ffmpeg` is 5.1, while the plan's tech stack says ffmpeg 7. The tests run ffmpeg-static (a different version), so the production codec behaviour is untested.
5. **`package.json:21` / `permission-sync.ts:40`:**
   - `release` runs only `sync-permissions`, so a system role added in a later phase is not created until someone runs `release:seed`.
   - The sync grants new keys to super_admin without bumping the permission epochs of super_admin holders, so a new permission stays invisible to them for up to 10 min after a deploy.
6. **`organizations.service.ts:157`:** an `org.member_invited` outbox event (with the invitee's email) is still written even though the ruling moved invite mail to direct send. Nothing consumes it. Drop it, or document it as reserved.
7. **`roles.service.ts:258,302` and `permission-sync.ts:71`:** RBAC reads and writes the identity-owned `users` table (existence check, status join, super-admin bootstrap). This breaks spec §3.2, and the lint rule cannot catch it. Use `AccountService` for the existence check, or note it as an accepted exception.
8. **`ffmpeg.ts:14,162`:**
   - The 30-minute transcode timeout applies per rung, and on expiry the asset is permanently FAILED with `PROCESSING_TIMEOUT`. A multi-hour 1080p lesson on a modest worker can exceed it.
   - The inner `probe(input)` at `ffmpeg.ts:145` and `probe("index.m3u8", dir)` run without the probe timeout.
9. **`media-lifecycle.ts:74`:** if `markFailed` itself throws on the last attempt, the job fails and the asset stays PROCESSING forever. Neither the cleanup job (it deletes only unattached rows) nor anything else moves it. Consider letting the cleanup job also fail PROCESSING assets older than N hours.
10. **Test honesty:**
    - `logger.spec.ts` checks redaction on a standalone pino built from the params, not through the app's HTTP logger.
    - No test proves `ErrorFilter` calls `reportException` (Sentry 5xx-only reporting is tested only on the helper).
    - The module-boundary rule has no automated negative case (proof was a manual scratch file). One lint fixture run in CI would keep the rule honest.
11. **`src/common/redis/rate-limit.guard.spec.ts`:** it sits in the `unit` project but starts a Redis container, so `pnpm test` ("unit") needs Docker.
12. **`edge/playback-gate/src/index.ts:76-78`:** the gate does not check `u` against anything. A user suspended mid-playback keeps segment access until the token expires (≤ 10 min). This is acceptable by design; record it in the README next to the 10-minute re-call note.

## Ledger rulings, weighed

The calls are mostly sound. Three affect the verdict:

- **Task 13-14, "single-PUT URL TTL 15 min":** sound for single PUTs, but the implementation applied it to multipart parts as well (I-2).
- **Task 16-17, "wire settings ... must not be no-ops":** wired on the API side only (I-3).
- **Task 18, "forwardRef in 3 places" and "Task 18 review folded into the final review":** the forwardRef fix works, but safe load order now rests on manual verification (I-4).

The others hold, with notes:

- Sliding 30-day refresh with no absolute cap is a product decision; I recommend a 90-day cap before payments.
- The camelCase-columns ruling leaves a naming inconsistency with the spec's convention. It is cosmetic now and costly to change later; decide before Phase 2 adds tables.
- The rulings that reduced review gates ("controller re-review from report + stat" for 13-14 round 2, 15 and 16-17): I re-read the hunks they covered (single-attachment invariant, reel duration, range handling, suspend fail-closed) and found them correct.

## Deferred minors: triage

| Group | Must fix before merge | Defer |
|---|---|---|
| 3-5 (9) | none | All. Worth noting: #3 (unmatched job names dropped silently) becomes more relevant once I-1 splits queues; #6 (`/v1/ready` has no ping timeout) is acceptable because orchestrator probes have their own timeout. |
| 6-8 (12) + rereview (3) | none | All. Recommended soon: #4 (JWT negative tests for alg `none`/HS512/wrong issuer) is cheap insurance; #1 (absolute session cap) is a product call. |
| 9-10 (8) + rereview (5) | none | All. #3 (403 discloses the permission key) and #5 (inherited handlers not scanned) are low risk today. |
| 11-12 (12) | none | All. #2 (follow counter deadlock → 500) is a quick fix when convenient. |
| 13-14 (8) + rereview (5) | none | All. Add the R2 lifecycle rule (abort incomplete multipart after 1 day, #1) to deploy docs. The rereview #3 per-rung timeout overlaps my Minor 8. |
| 15 (5) | none | All. #5 (localhost in production `ALLOWED_ORIGINS`) is already resolved: `wrangler.toml:10` now has only `https://app.skiller.in`. |
| 16-17 (9) | **#4: unsuspend has no super_admin escalation check** (`admin-users.service.ts:131-144`). Any `user.suspend` holder can reverse a super admin's suspension of another super_admin, for example a compromised one. Mirror the check at `:114`; it is about a 3-line fix. **#7: no test boots `WorkerModule`.** Fold this into I-4. | The rest. |

## Declined to judge

- **Spec §11-12 (billing, wallet, `Idempotency-Key`):** Phase 2+, out of scope.
- **Spec §13 promotional campaigns and one-click unsubscribe:** not in the Phase 1 plan.
- **"Global" rate limit in spec §16:** the Phase 1 plan defines only per-route `@RateLimit`.
- **Org seat limits, plan storage quota, verified badge, wallet accounts at creator onboarding (spec §6/§7):** the plan defers them to Phase 2.
- **Cleanup deleting every reel, lesson, resource, thumbnail and gig_gallery asset after 24 h:** Phase 1 has no module that attaches them. This matches spec §7 literally, but the Phase 1 manual exit check must run within 24 h of the uploads.
- **OpenAPI success schemas missing for admin/orgs/notifications/profiles routes:** the implementer flagged this; the plan requires only error documentation.
- **Whether the CI workflow actually runs green on GitHub:** not executed by the implementer or by me. Actions/services syntax looks correct.
- **Docker image smoke behaviour:** the worker image was never run, by the implementer or by me.
- **Node 24 vs the plan's Node 22, and pnpm 10 vs pnpm 9:** an accepted setup ruling.
- **ESLint core rule vs `eslint-plugin-boundaries`:** accepted ruling; the rule is equivalent for imports.

## Verdict

**Ready to merge: With fixes.**

No Critical issues, and the security boundaries (auth, sessions, step-up, RBAC, suspend, playback) hold under the review-focus scenarios. Five Important issues should land first: I-1 (queue concurrency and relay starvation), I-2 (part URL expiry), I-3 (setting vs worker limit), I-4 (automated boot of both entry points) and I-5 (outbox retry exhaustion and no worker alerting). The two deferred 16-17 minors (#4 unsuspend escalation, #7 worker boot test) should land with them. Each fix is small and local, and none needs a migration except possibly I-3 if the effective limit is stored on the asset.
