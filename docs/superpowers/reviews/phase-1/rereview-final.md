# Re-review: final-review fix wave (d4629a1..4b87f8e)

## Finding Verdicts

- **I1 dedicated queues per processor class** - ADDRESSED. queue.constants.ts: outbox, mail, mediaTranscode ("media-transcode"), mediaLight ("media-light"), maintenance; `media` is gone. TranscodeProcessor on mediaTranscode, concurrency 1 (transcode.processor.ts:42-44); Image/File on mediaLight, concurrency 4; MediaCleanupProcessor stays on maintenance; relay moved off maintenance onto outbox (outbox.relay.ts:21,36), OutboxProcessor concurrency 5. QueueWorkerRunner still builds one Worker per queue (queue-worker.runner.ts:35-44), now each queue holds one concurrency class. Producer/consumer check: the only `.add`/`upsertJobScheduler` callers are media.service.ts:155 (new queues, routed by kind), outbox.relay.ts:36,65 (outbox), media-cleanup.processor.ts:41 (maintenance), mail.service.ts:27 (mail). No reference to the old `media` queue remains in src/ or test/. Worker boot test asserts startedQueues equals all QueueNames. Unit spec and isolation int spec cover it.
- **I2 part URL TTL 1 h + re-sign endpoint** - ADDRESSED. PART_PRESIGN_TTL_SEC=3600 used by presignParts (r2.client.ts); single PUT stays 900. `POST /v1/media/uploads/:id/parts` (media.controller.ts, HttpCode 200, media.upload). media.service.ts resignParts: owner only via owned() (404), PENDING only (409 UPLOAD_NOT_PENDING), multipart only (409), part numbers deduped and range-checked against partSizes (400 VALIDATION_FAILED), 60/h per user via consumeRateLimit mapped to 429 RATE_LIMITED. Body schema 1..10000, max 1000, strict. e2e tests cover TTLs, owner, 404, 409s, range, 429.
- **I3 worker size cap from the same SettingsService limit** - ADDRESSED. media-limits.ts `effectiveMaxBytes` is the single source; used in createUpload (media.service.ts) and in the transcode worker (transcode.processor.ts: `fetchSource(..., await effectiveMaxBytes(this.settings, asset.purpose))` -> verifySource maxBytes). Image/file keep the static rule. Int test: 6 GB fails at default 5120, passes after raising to 10 GB.
- **I4 boot tests + CI image run** - ADDRESSED. create-app.ts / create-worker.ts back main.ts / worker.ts; test/e2e/boot.e2e-spec.ts boots the real AppModule through createApp, listens on port 0, GETs /v1/health and /v1/ready; src/worker.module.int-spec.ts boots the real WorkerModule, asserts EventBus.registeredTypes against an exhaustive Record<DomainEventType, boolean> and that all queue Workers started. CI docker job builds both images (load: true), runs release:seed, starts the API image and curls /v1/health + /v1/ready, starts the worker image and greps "workers started" for outbox and media-transcode. Honest caveat from the report stands: the jest boot cannot reproduce the forwardRef cycle; the CI image run is what covers it.
- **I5 durable outbox delivery + dead-letter endpoint** - ADDRESSED. queue.options.ts OUTBOX_JOB_OPTIONS: attempts 15, backoff type capped-exponential delay 1000, removeOnFail false; applied to the outbox queue via jobOptionsFor (queue.module.ts). Strategy registered on every Worker via settings.backoffStrategy (queue-worker.runner.ts:48). Verified against bullmq 6.5.4 (job.js:455-458): strategy gets attemptsMade+1 (1 on the first failure) so delays are 1,2,4,...,1024 s then 1800 s; built-in exponential/fixed types are looked up first so other queues are unaffected. Total about 2.1 h. On the final failure (or UnrecoverableError) the runner calls reportException(err, 500) and processor.onExhausted; OutboxProcessor.onExhausted sets deadAt + lastError (outbox.processor.ts). Relay stays attempts 1 and removeOnFail true, so only event jobs are retained. Migration adds deadAt, lastError, index. `GET /v1/admin/outbox/dead` (outbox-dead.controller.ts, audit.view, parsePage, id-desc cursor on UUIDv7, nextCursor via toPage); e2e covers pagination, order, 403. Int test covers 3 attempts -> deadAt, lastError, Sentry call, failed job retained.
- **M1 unsuspend escalation** - ADDRESSED. admin-users.service.ts:133 denies a non-super_admin actor on a super_admin target with ROLE_ESCALATION_DENIED, mirroring the suspend check at :114. E2E asserts 403, status unchanged, no audit row, and that a super_admin can.
- **M2 test boots WorkerModule** - ADDRESSED. src/worker.module.int-spec.ts (see I4); mutation check reported.

## New Breakage in the Fix Diff

Critical: none. Important: none.

CI YAML validity: valid. Service containers (postgres:16-alpine, redis:7-alpine) publish 5432/6379 and `--network host` reaches them on localhost; folded `SMOKE_ENV` scalar becomes one line of `-e` flags and word-splits as intended; every required key in config.schema.ts is present (no unknown/missing env); `release:seed` exists in package.json and runs migrate deploy before the API starts; failure-log step is `|| true` guarded. Not executed on GitHub (stays unverified).

BullMQ backoff capping: correct (see I5). Migration correctness: additive columns/index are correct; the DROP/CREATE of the two text_pattern_ops indexes is Prisma drift noise with an identical final definition (schema.prisma:85,237), harmless.

Relay Sentry noise: when the DB is down the relay (attempts 1) fails every second and each tick hits the exhaustion path (queue-worker.runner.ts:45-47) -> one logger.error and one reportException per second per worker. Sentry's default Dedupe integration (Sentry.init uses defaults, sentry.ts:6) drops consecutive identical events, and a DB outage is itself a signal, so I rate it Minor, not Important.

Minor (6):
1. queue-worker.runner.ts:45 / outbox.relay.ts:36: relay failure reports to Sentry + error log every second during a DB outage; consider skipping the exhaustion path for the relay job or throttling it.
2. Upgrade hazard for any environment that already ran d4629a1: a persisted `outbox-relay` job scheduler on `maintenance` (no processor now; warns "matched no processor and was dropped" once a second) and leftover jobs on the removed `media` queue. Nothing calls removeJobScheduler or drains `media`. Fine if nothing is deployed yet; otherwise add a one-off cleanup.
3. queue-worker.runner.ts:45: UnrecoverableError (mail.processor.ts:51, Resend 4xx) now reports to Sentry as a 500 for every permanently rejected mail; expected client-side rejections add noise.
4. prisma/migrations/20261103064653_outbox_dead_letter/migration.sql:1-8,14-18: needless drop and rebuild of two search indexes (blocking on a large table); strip those statements.
5. transcode.processor.ts (effectiveMaxBytes at process time): lowering the setting after an upload was accepted fails that in-flight upload with UPLOAD_SIZE_MISMATCH. Edge case; consider storing the cap on the asset.
6. media.service.ts resignParts: the rate limit is consumed after validation, so invalid-body spam is not throttled beyond the global limits (cheap, owner-scoped); no dead-event replay endpoint (documented as manual).

## Out-of-Scope Observations

None new. Final-review minors 1-12 are untouched by this wave.

## Verdict

**Fix round:** All findings addressed (I1-I5, M1, M2), no new Critical/Important breakage. 6 Minor.
