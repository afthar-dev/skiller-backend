# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new Skiller backend with OTP auth, sessions, DB-driven RBAC, profiles, organizations, R2 media upload + HLS transcode + signed playback, transactional email, in-app notifications, and the admin shell with audit log.

**Architecture:** NestJS modular monolith with a second bootstrap (`worker.ts`) running BullMQ processors from the same codebase. Modules own their Prisma models; cross-module side effects go through a transactional outbox relayed to BullMQ. All money is out of scope for this phase.

**Tech Stack:** Node 22 LTS, pnpm 9, NestJS 11, Prisma 6 (Neon Postgres), ioredis + BullMQ 5, Zod 3, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (R2), `resend` + `@react-email/components`, `@nestjs/jwt`, `nestjs-pino`, `@sentry/nestjs`, `@nestjs/swagger`, Jest + Supertest + `@testcontainers/postgresql` + `@testcontainers/redis`, ffmpeg 7 in worker image, Cloudflare Workers (`wrangler`) for the playback gate.

**Spec:** `docs/superpowers/specs/2026-11-03-skiller-platform-redesign-design.md` (sections 3–7, 13, 14, 15, 16, 17; phase 1 row of section 18).

## Global Constraints

- All routes under `/v1`.
- Error body: `{ "error": { "code": string, "message": string, "details": object }, "requestId": string }`.
- Cursor pagination: `?cursor=&limit=` → `{ items, nextCursor }`; `limit` default 20, max 100.
- Timestamps ISO-8601 UTC.
- OTP: 6 digits, stored hashed, TTL 10 minutes, max 5 attempts.
- Access token TTL 15 minutes; refresh token in httpOnly, Secure, SameSite=Lax cookie named `skiller_rt`, path `/v1/auth`.
- Step-up OTP valid 5 minutes.
- Module reads/writes only its own tables; cross-module via exported service or outbox event. Enforced by `eslint-plugin-boundaries`.
- System roles: `member`, `creator`, `org_owner`, `org_instructor`, `org_learner`, `moderator`, `support`, `finance_admin`, `super_admin`.
- Media limits: images ≤10 MB (`avatar`, `banner`, `thumbnail`, `gig_gallery`, public bucket); `reel` video ≤90 s, ≤200 MB, public; `course_lesson` video private, plan quota; `course_resource` pdf/zip ≤100 MB, private.
- HLS renditions 240p/480p/720p/1080p, capped at source height.
- Playback token expiry 10 minutes.
- Unattached media older than 24 h deleted.
- App refuses to start on invalid config.
- Secrets never logged; Pino redacts `authorization`, `cookie`, `*.code`, `*.token`.

## Review Focus

1. **Two tabs refresh at once** — the second refresh presents the just-rotated token. Expected: no logout. Rule: reuse within 10 s of rotation returns `409 REFRESH_RACE` without revoking; reuse after 10 s revokes the family. Test in Task 7.
2. **Suspended user still holds a valid 15-minute access token** — expected: blocked immediately. `AuthGuard` checks `users.status` via a Redis-cached lookup (bust on status change). Test in Task 7 and Task 17.
3. **Permission removed from a role** — expected: takes effect on the next request, not after cache TTL. Test in Task 9.
4. **Upload `complete` called twice, or with fewer bytes than declared** — expected: second call returns the same asset idempotently; size mismatch → `UPLOAD_SIZE_MISMATCH` and asset `FAILED`. Test in Task 13.
5. **Handle collision differing only by case (`@Aftab` vs `@aftab`) and removing the last `super_admin`** — expected: handle rejected `HANDLE_TAKEN`; last super-admin revoke rejected `LAST_SUPER_ADMIN`. Tests in Task 11 and Task 10.

---

## File Structure

```
skiller-backend/
  package.json, tsconfig.json, nest-cli.json, .eslintrc.cjs, jest.config.ts, .env.example, Dockerfile, Dockerfile.worker
  .github/workflows/ci.yml
  prisma/schema.prisma            # one file, models grouped by module with comment headers
  prisma/seed.ts                  # system roles + permission sync + super admin bootstrap
  src/
    main.ts  worker.ts  app.module.ts  worker.module.ts
    common/
      config/config.schema.ts  config/config.module.ts
      errors/app-error.ts  errors/error.filter.ts
      http/request-id.middleware.ts  http/pagination.ts
      prisma/prisma.service.ts  prisma/prisma.module.ts
      redis/redis.module.ts  redis/rate-limit.guard.ts
      queue/queue.module.ts  queue/queue-names.ts
      outbox/outbox.service.ts  outbox/outbox.relay.ts  outbox/event-bus.ts  outbox/events.ts
      auth/current-user.decorator.ts  auth/public.decorator.ts
    modules/
      identity/   otp.service.ts  session.service.ts  token.service.ts  auth.guard.ts  step-up.guard.ts  auth.controller.ts  identity.module.ts
      rbac/       permission.registry.ts  require-permission.decorator.ts  permission.service.ts  permission.guard.ts  roles.service.ts  roles.controller.ts  permission-sync.ts  rbac.module.ts
      audit/      audit.service.ts  audit.controller.ts  audit.module.ts
      users/      users.service.ts  profile.controller.ts  follows.service.ts  creator.service.ts  users.module.ts
      organizations/ organizations.service.ts  organizations.controller.ts  organizations.module.ts
      media/      media.rules.ts  r2.client.ts  media.service.ts  media.controller.ts  transcode.processor.ts  ffmpeg.ts  playback.service.ts  playback-token.ts  media-cleanup.processor.ts  media.module.ts
      mail/       resend.client.ts  mail.service.ts  mail.processor.ts  templates/*.tsx  mail.module.ts
      notifications/ notifications.service.ts  notifications.controller.ts  notification.handlers.ts  notifications.module.ts
      admin/      admin-users.controller.ts  settings.service.ts  flags.service.ts  admin.module.ts
  edge/playback-gate/  src/index.ts  wrangler.toml  test/index.test.ts
  test/
    setup/containers.ts  setup/app.ts  setup/factories.ts
    e2e/*.e2e-spec.ts
```

---

### Task 1: Scaffold, config, health

**Files:**
- Create: `package.json`, `tsconfig.json`, `nest-cli.json`, `.eslintrc.cjs`, `jest.config.ts`, `.env.example`, `.gitignore`, `src/main.ts`, `src/app.module.ts`, `src/common/config/config.schema.ts`, `src/common/config/config.module.ts`, `src/health.controller.ts`
- Test: `src/common/config/config.schema.spec.ts`, `test/e2e/health.e2e-spec.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig` (throws `ConfigError` listing every invalid key); `AppConfig` type; injection token `APP_CONFIG`.
- `AppConfig` keys: `nodeEnv`, `port`, `databaseUrl`, `redisUrl`, `jwtSecret` (≥32 chars), `otpPepper` (≥32), `playbackSecret` (≥32), `corsOrigins: string[]`, `cookieDomain`, `r2: {accountId, accessKeyId, secretAccessKey, publicBucket, privateBucket, publicBaseUrl, playbackBaseUrl}`, `resend: {apiKey, fromAddress, webhookSecret}`, `sentryDsn?`, `superAdminEmail`.

- [ ] **Step 1:** `git init` in `skiller-backend/`, `pnpm init`, add deps from Tech Stack, `nest-cli.json` with `src/main.ts` + `src/worker.ts` entry points. Commit `chore: init repo`.
- [ ] **Step 2: Write failing tests** in `config.schema.spec.ts`:
  - `loads valid env` → returns `corsOrigins` split on comma.
  - `rejects short jwt secret` → throws `ConfigError` whose message contains `JWT_SECRET`.
  - `reports all invalid keys at once` → missing `DATABASE_URL` and `REDIS_URL` both named.
- [ ] **Step 3:** Run `pnpm jest config.schema` → FAIL (module not found).
- [ ] **Step 4:** Implement `loadConfig` with Zod; `ConfigModule` global provider `APP_CONFIG` calling `loadConfig(process.env)` at boot.
- [ ] **Step 5:** `health.e2e-spec.ts`: `GET /v1/health` → 200 `{status:"ok"}`; `GET /v1/ready` → 200 when DB+Redis reachable (implement `/ready` after Task 2/4; mark `it.todo` here and fill in Task 4).
- [ ] **Step 6:** `main.ts`: global prefix `v1`, Helmet, CORS from `corsOrigins` with credentials, `cookie-parser`, shutdown hooks. Run tests → PASS.
- [ ] **Step 7:** Commit `feat: config validation and health endpoint`.

---

### Task 2: Prisma, test containers, error shape, request IDs, pagination

**Files:**
- Create: `prisma/schema.prisma` (datasource + generator only, plus `PlatformSetting` and `FeatureFlag` models), `src/common/prisma/*`, `src/common/errors/*`, `src/common/http/*`, `test/setup/containers.ts`, `test/setup/app.ts`
- Test: `src/common/errors/error.filter.spec.ts`, `src/common/http/pagination.spec.ts`

**Interfaces:**
- Produces:
  - `class AppError extends Error { constructor(code: string, status: number, message: string, details?: Record<string, unknown>) }`
  - `ErrorFilter` (global) mapping `AppError`, Nest `HttpException`, Zod/class-validator errors (`code: "VALIDATION_FAILED"`, `details.fields`), Prisma `P2002` (`code: "CONFLICT"`), unknown (`code: "INTERNAL"`, 500, message hidden in production).
  - `RequestIdMiddleware` — reads `x-request-id` or generates UUIDv7, sets response header, binds to Pino.
  - `parsePage(query): {cursor?: string; limit: number}`; `toPage<T extends {id: string}>(rows: T[], limit: number): {items: T[]; nextCursor: string | null}` (fetch `limit+1` rows, cursor = last item id).
  - `startContainers(): Promise<{databaseUrl, redisUrl, stop()}>` (runs `prisma migrate deploy` against the container); `createTestApp(overrides?): Promise<INestApplication>`.
- Models: `PlatformSetting(key String @id, value Json, updatedAt)`, `FeatureFlag(key String @id, enabled Boolean, rules Json?, updatedAt)`.

- [ ] **Step 1: Failing tests:**
  - `error.filter.spec`: `AppError("COURSE_NOT_FOUND",404,"Course not found")` → body `{error:{code:"COURSE_NOT_FOUND",message:"Course not found",details:{}},requestId:<header value>}`; unknown `Error("db exploded")` in production → 500, message `"Something went wrong"`.
  - `pagination.spec`: `limit=500` → 100; 21 rows with limit 20 → 20 items, `nextCursor` = id of item 20; 5 rows → `nextCursor: null`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement listed interfaces. `pnpm prisma migrate dev --name init`.
- [ ] **Step 4:** Run → PASS. Commit `feat: prisma, error shape, pagination, test harness`.

---

### Task 3: Redis, rate limiting, queues, worker bootstrap

**Files:**
- Create: `src/common/redis/*`, `src/common/queue/*`, `src/worker.ts`, `src/worker.module.ts`
- Test: `src/common/redis/rate-limit.guard.spec.ts` (Redis container)

**Interfaces:**
- Produces:
  - `REDIS` injection token (ioredis instance).
  - `@RateLimit({ key: (req) => string, limit: number, windowSec: number })` decorator + global `RateLimitGuard` (sliding window via Redis sorted set). Exceeds → `AppError("RATE_LIMITED",429)` with `details.retryAfterSec` and `Retry-After` header.
  - `QueueNames = { outbox: "outbox", mail: "mail", media: "media", maintenance: "maintenance" } as const`.
  - `QueueModule.register()` exposes BullMQ `Queue` per name; `worker.ts` boots `WorkerModule` (no HTTP server) which registers processors.
- [ ] **Step 1: Failing test:** limit 3 per 60 s → 4th call throws `RATE_LIMITED` with `retryAfterSec` between 1 and 60; different key unaffected.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** fill `/v1/ready` (Prisma `SELECT 1`, Redis `PING`; 503 `NOT_READY` if either fails). Run → PASS.
- [ ] **Step 5:** Commit `feat: redis rate limiting, queues, worker bootstrap`.

---

### Task 4: Transactional outbox and event bus

**Files:**
- Modify: `prisma/schema.prisma` (add `OutboxEvent`)
- Create: `src/common/outbox/outbox.service.ts`, `outbox.relay.ts`, `event-bus.ts`, `events.ts`
- Test: `src/common/outbox/outbox.int-spec.ts`

**Interfaces:**
- Model: `OutboxEvent(id String @id @default(uuid(7)), type String, payload Json, createdAt, publishedAt DateTime?, attempts Int @default(0))`, index on `publishedAt`.
- Produces:
  - `events.ts`: discriminated union `DomainEvent` with phase-1 members: `user.registered {userId,email}`, `user.became_creator {userId}`, `media.ready {assetId,ownerId,purpose}`, `media.failed {assetId,ownerId,reason}`, `org.member_invited {orgId,email,inviteId}`, `role.granted {userId,roleKey,grantedBy}`.
  - `OutboxService.enqueue(tx: Prisma.TransactionClient, event: DomainEvent): Promise<void>`.
  - `OutboxRelay` (worker, repeatable job every 1 s): selects unpublished rows `FOR UPDATE SKIP LOCKED LIMIT 100`, adds BullMQ job on `outbox` queue with `jobId = event.id` (dedupe), sets `publishedAt`.
  - `EventBus.on<T extends DomainEvent["type"]>(type: T, handler: (e: Extract<DomainEvent,{type:T}>) => Promise<void>)`; outbox processor dispatches to all handlers; handler failure → BullMQ retry (5 attempts, exponential).
- [ ] **Step 1: Failing tests:** event enqueued inside a rolled-back transaction is never relayed; committed event is delivered to a registered handler exactly once even when relay runs twice concurrently.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: transactional outbox`.

---

### Task 5: Mail via Resend

**Files:**
- Create: `src/modules/mail/*`, `src/modules/mail/templates/otp.tsx`, `welcome.tsx`, `org-invite.tsx`, `media-failed.tsx`
- Modify: `prisma/schema.prisma` (add `EmailSuppression(email String @id, reason String, createdAt)`)
- Test: `src/modules/mail/mail.processor.spec.ts`

**Interfaces:**
- Produces:
  - `type MailTemplate = "otp" | "welcome" | "org_invite" | "media_failed"`; per-template data types (`otp: {code: string, purpose: "LOGIN" | "STEP_UP", expiresInMin: 10}` etc.).
  - `MailService.send<T extends MailTemplate>(template: T, to: string, data: MailData[T], opts?: {category: "transactional" | "promotional"}): Promise<void>` — enqueues job on `mail` queue; never calls Resend inline.
  - `ResendClient` interface `{ send(msg: {to, subject, html, text, headers?}): Promise<{id: string}> }` with fake implementation for tests.
  - `POST /v1/webhooks/resend` (Svix signature verified with `resend.webhookSecret`): `email.bounced` / `email.complained` → upsert `EmailSuppression`.
- Rule: transactional mail is sent regardless of suppression except reason `bounced` (hard bounce → skip and log). Promotional mail skips any suppressed address.
- [ ] **Step 1: Failing tests:** OTP mail renders code in both html and text; bounced address skips send; Resend 5xx → job throws (retry); subject for `otp` login is `"Your Skiller sign-in code"`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: resend mail pipeline`.

---

### Task 6: Users core model and OTP challenge

**Files:**
- Modify: `prisma/schema.prisma` — add `User`, `OtpChallenge`
- Create: `src/modules/identity/otp.service.ts`
- Test: `src/modules/identity/otp.service.int-spec.ts`

**Interfaces:**
- Models:
  - `User(id uuid7, email String @unique (stored lower-case), status UserStatus @default(ACTIVE) /* ACTIVE|SUSPENDED|DELETED */, emailVerifiedAt, createdAt, updatedAt)`.
  - `OtpChallenge(id, email, purpose OtpPurpose /* LOGIN|STEP_UP */, userId?, codeHash String, attempts Int @default(0), expiresAt, consumedAt?, ip, createdAt)`.
- Produces:
  - `OtpService.request(input: {email: string; purpose: OtpPurpose; ip: string; userId?: string}): Promise<{challengeId: string; expiresAt: Date}>` — hash = HMAC-SHA256(`otpPepper`, `challengeId:code`); invalidates prior unconsumed challenges for same email+purpose; sends `otp` mail.
  - `OtpService.verify(challengeId: string, code: string): Promise<{email: string; purpose: OtpPurpose; userId?: string}>` — single SQL `UPDATE ... SET attempts = attempts + 1 WHERE id=$1 AND consumed_at IS NULL AND expires_at > now() AND attempts < 5 RETURNING *`, then constant-time compare; on match set `consumedAt` with `WHERE consumed_at IS NULL` (row count 0 → `OTP_INVALID`).
  - Errors: `OTP_INVALID` (400, wrong code, details `{attemptsLeft}`), `OTP_EXPIRED` (400), `OTP_LOCKED` (429 after 5 attempts).
- [ ] **Step 1: Failing tests:**
  - correct code → returns email; second verify of same code → `OTP_INVALID`.
  - 5 wrong codes → 6th attempt (even correct) → `OTP_LOCKED`.
  - expired (fake clock +10 min 1 s) → `OTP_EXPIRED`.
  - 10 parallel `verify` calls with correct code → exactly 1 succeeds.
  - new `request` invalidates previous challenge's code.
  - email `"  Foo@Bar.COM "` normalised to `foo@bar.com`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: otp challenges`.

---

### Task 7: Auth endpoints, sessions, tokens

**Files:**
- Modify: `prisma/schema.prisma` — add `Session`
- Create: `token.service.ts`, `session.service.ts`, `auth.guard.ts`, `auth.controller.ts`, `identity.module.ts`, `src/common/auth/current-user.decorator.ts`, `public.decorator.ts`
- Test: `test/e2e/auth.e2e-spec.ts`, `src/modules/identity/session.service.int-spec.ts`

**Interfaces:**
- Model: `Session(id, userId, familyId, refreshHash String @unique, previousHash String?, rotatedAt?, userAgent, ip, lastUsedAt, expiresAt /* +30 days */, revokedAt?, createdAt)`.
- Produces:
  - `TokenService.signAccess(p: {sub: string; sid: string}): string` (HS256, 15 min, `iss: "skiller"`); `verifyAccess(token): {sub, sid}`.
  - `SessionService.create(userId, meta: {ip, userAgent}): Promise<{session: Session; refreshToken: string}>` — refresh token = 32 random bytes base64url; stored as SHA-256.
  - `SessionService.rotate(refreshToken, meta): Promise<{userId; sessionId; refreshToken}>` — algorithm:
    ```
    row = find by refreshHash
    if row: if revoked/expired → AUTH_SESSION_EXPIRED
            else new token; previousHash = refreshHash; refreshHash = new; rotatedAt = now; return
    row = find by previousHash
    if row and now - row.rotatedAt <= 10s → AppError("REFRESH_RACE", 409)
    if row → revoke every session with row.familyId; AUTH_TOKEN_REUSED (401)
    else → AUTH_SESSION_EXPIRED (401)
    ```
  - `SessionService.revoke(sessionId)`, `revokeAllForUser(userId, exceptSessionId?)`, `list(userId)`.
  - `AuthGuard` (global; skip with `@Public()`): verifies access token, loads `{status}` via `UserStatusCache.get(userId)` (Redis 60 s, busted by `UserStatusCache.bust(userId)`), rejects `SUSPENDED`/`DELETED` with `AUTH_ACCOUNT_SUSPENDED` 403, rejects revoked session (`sessions:revoked:{sid}` Redis key set on revoke, TTL 15 min) with 401.
  - `@CurrentUser(): AuthUser` → `{id: string; sessionId: string}`.
  - Endpoints:
    - `POST /v1/auth/otp/request {email}` → 202 `{challengeId, expiresAt}`; rate limit 5/15 min per email and 20/15 min per IP. Same response whether or not the email exists.
    - `POST /v1/auth/otp/verify {challengeId, code}` → creates user if new (emit `user.registered`, grant `member` through injected interface `MemberRoleGranter { grantMember(tx: Prisma.TransactionClient, userId: string): Promise<void> }` — Task 7 binds a no-op implementation; Task 10 rebinds it to `RolesService`), creates session → 200 `{accessToken, user: {id, email, isNew}}` + `Set-Cookie skiller_rt`.
    - `POST /v1/auth/refresh` (cookie) → 200 `{accessToken}` + new cookie.
    - `POST /v1/auth/logout` → revokes current session, clears cookie.
    - `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id`, `POST /v1/auth/sessions/revoke-others`.
- [ ] **Step 1: Failing tests (e2e with fake mail capturing codes):**
  - full login: request → verify → `GET /v1/me` (stub returning `{id}`) with bearer → 200.
  - refresh rotates cookie; old cookie used 11 s later (fake timers) → 401 `AUTH_TOKEN_REUSED` and the new cookie also fails.
  - **Review Focus 1:** old cookie reused within 10 s → 409 `REFRESH_RACE`, and the new cookie still works.
  - **Review Focus 2:** suspend user via `prisma.user.update` + `UserStatusCache.bust` → next request with still-valid access token → 403 `AUTH_ACCOUNT_SUSPENDED`.
  - logout then reuse access token → 401.
  - OTP request for unknown and known email return identical bodies.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: otp login, rotating sessions`.

---

### Task 8: Step-up verification

**Files:**
- Create: `src/modules/identity/step-up.guard.ts`, `require-step-up.decorator.ts`; modify `auth.controller.ts`
- Test: `test/e2e/step-up.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `POST /v1/auth/step-up/request` → OTP purpose `STEP_UP` to the user's email → `{challengeId}`.
  - `POST /v1/auth/step-up/verify {challengeId, code}` → sets Redis `stepup:{sessionId}` with TTL 300 s → 204.
  - `@RequireStepUp()` + `StepUpGuard` → missing key → 403 `STEP_UP_REQUIRED`.
- [ ] **Step 1: Failing tests:** protected test route returns `STEP_UP_REQUIRED`; after verify → 200; after 301 s → `STEP_UP_REQUIRED`; step-up on session A does not unlock session B; `STEP_UP` challenge cannot be used at `/auth/otp/verify` (→ `OTP_INVALID`).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: step-up verification`.

---

### Task 9: RBAC core — registry, sync, guard, cache

**Files:**
- Modify: `prisma/schema.prisma` — add `Permission`, `Role`, `RolePermission`, `UserRole`
- Create: `src/modules/rbac/permission.registry.ts`, `require-permission.decorator.ts`, `permission.service.ts`, `permission.guard.ts`, `permission-sync.ts`, `rbac.module.ts`; `prisma/seed.ts`
- Test: `src/modules/rbac/permission.service.int-spec.ts`, `permission-sync.spec.ts`

**Interfaces:**
- Models:
  - `Permission(id, key String @unique, description, module, createdAt)`
  - `Role(id, key String @unique, name, scope RoleScope /* PLATFORM|ORG */, isSystem Boolean, createdById?, createdAt)`
  - `RolePermission(roleId, permissionId) @@id([roleId, permissionId])`
  - `UserRole(id, userId, roleId, orgId String?, grantedById?, expiresAt?, createdAt) @@unique([userId, roleId, orgId])` (use `NULLS NOT DISTINCT` via raw migration).
- Produces:
  - `definePermissions(module: string, perms: Record<string, string>)` → returns typed key constants and registers them in `PermissionRegistry` (in-memory, collected at import).
  - Phase-1 keys: `profile.update_any`, `user.view`, `user.suspend`, `user.revoke_sessions`, `rbac.view`, `rbac.manage`, `role.grant`, `audit.view`, `media.upload`, `media.manage_any`, `org.create`, `org.manage`, `org.invite`, `settings.manage`, `flags.manage`, `notification.view`.
  - Default system-role grants (seed): `member` → `media.upload`, `org.create`; `creator` → member set (later phases add course/gig keys); `org_owner` → `org.manage`, `org.invite`; `moderator` → `user.view`, `media.manage_any`; `support` → `user.view`, `user.revoke_sessions`, `audit.view`; `finance_admin` → `user.view`, `audit.view`; `super_admin` → every key (sync re-grants new keys to `super_admin` automatically).
  - `syncPermissions(prisma, registry)`: upserts keys, never deletes; logs keys present in DB but not in code as `orphan`. Runs in `seed.ts` and as release step `pnpm db:sync-permissions`.
  - Seed bootstraps `superAdminEmail` user with `super_admin`.
  - `PermissionService.effective(userId): Promise<{platform: Set<string>; byOrg: Map<string, Set<string>>}>` — cached in Redis `perm:{userId}` (TTL 10 min), ignores expired `UserRole`.
  - `PermissionService.has(userId, key, orgId?): Promise<boolean>` (platform grant satisfies any org).
  - `PermissionService.invalidateUser(userId)`, `invalidateRole(roleId)` (deletes `perm:*` for all holders of that role via `UserRole` lookup).
  - `@RequirePermission(key, opts?: {orgParam?: string})` + global `PermissionGuard`. Routes with neither `@RequirePermission` nor `@Public` nor `@AuthenticatedOnly()` fail a boot-time check (`assertAllRoutesGuarded`) — the app refuses to start.
- [ ] **Step 1: Failing tests:**
  - sync is idempotent; new key added to code is inserted and granted to `super_admin`.
  - org-scoped grant passes for that org, fails for another org.
  - expired `UserRole` ignored.
  - **Review Focus 3:** remove permission from role via `RolesService` (Task 10) → `invalidateRole` → next `has` returns false without waiting for TTL. (Write test here against `invalidateRole` directly.)
  - boot check throws naming the unguarded route.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: db-driven rbac core`.

---

### Task 10: Audit log and role management API

**Files:**
- Modify: `prisma/schema.prisma` — add `AuditLog`
- Create: `src/modules/audit/*`, `src/modules/rbac/roles.service.ts`, `roles.controller.ts`
- Test: `test/e2e/roles.e2e-spec.ts`

**Interfaces:**
- Model: `AuditLog(id, actorId?, action String, targetType String, targetId String, before Json?, after Json?, ip String?, requestId String?, createdAt)` indexes on `(targetType,targetId)`, `(actorId,createdAt)`.
- Produces:
  - `AuditService.record(tx: Prisma.TransactionClient, entry: {actorId: string | null; action: string; targetType: string; targetId: string; before?: unknown; after?: unknown; ip?: string; requestId?: string}): Promise<void>`.
  - `GET /v1/admin/audit?targetType=&targetId=&actorId=` (`audit.view`), paginated.
  - `RolesService`: `create({key, name, scope, permissionKeys})`, `update(roleId, {name?, permissionKeys?})`, `delete(roleId)` (system roles → `ROLE_SYSTEM_PROTECTED`), `grant(actorId, {userId, roleKey, orgId?, expiresAt?})`, `revoke(actorId, userRoleId)`, `grantSystem(userId, roleKey)`. Each mutation writes audit + invalidates cache + emits `role.granted` where applicable.
  - Endpoints: `GET/POST /v1/admin/roles`, `PATCH/DELETE /v1/admin/roles/:id`, `GET /v1/admin/permissions` (`rbac.view` / `rbac.manage`); `POST /v1/admin/users/:id/roles`, `DELETE /v1/admin/users/:id/roles/:userRoleId` (`role.grant` + `@RequireStepUp()`).
  - Rules: unknown permission key → `PERMISSION_UNKNOWN`; actor cannot grant a role containing a permission they do not hold → `ROLE_ESCALATION_DENIED`; revoking the last active `super_admin` grant → `LAST_SUPER_ADMIN`.
- Rebind Task 7's `MemberRoleGranter` to `RolesService.grantSystem(userId, "member")`; e2e: new OTP sign-up has `member` in `/v1/me` roles (add after Task 11 provides `/v1/me`, or assert via `UserRole` row here).
- [ ] **Step 1: Failing tests:** create custom role "content_reviewer" with `user.view` + `media.manage_any`, grant it, user can call a `media.manage_any` route; support user trying to grant `super_admin` → `ROLE_ESCALATION_DENIED`; **Review Focus 5:** revoke last super-admin → `LAST_SUPER_ADMIN`; every mutation creates one `AuditLog` row with before/after.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: role management and audit log`.

---

### Task 11: Profiles, follows, become-creator

**Files:**
- Modify: `prisma/schema.prisma` — add `Profile`, `Experience`, `Education`, `ProfileSkill`, `PortfolioItem`, `Follow`
- Create: `src/modules/users/*`
- Test: `test/e2e/profile.e2e-spec.ts`

**Interfaces:**
- Models:
  - `Profile(userId @id, handle String @unique /* lower-case citext */, displayName, headline?, about?, avatarAssetId?, bannerAssetId?, location?, links Json @default("[]"), followersCount Int @default(0), followingCount Int @default(0), isCreator Boolean @default(false), verifiedAt?, updatedAt)`.
  - `Experience(id, userId, title, company, startDate, endDate?, description?, position Int)`; `Education(id, userId, school, degree?, field?, startYear?, endYear?, position)`; `ProfileSkill(userId, skill String, position) @@id([userId, skill])`; `PortfolioItem(id, userId, title, url?, mediaAssetId?, description?, position)`.
  - `Follow(followerId, followeeId, createdAt) @@id([followerId, followeeId])`.
- Produces:
  - Profile created on `user.registered` handler with handle derived from email local part + 4 random digits.
  - `GET /v1/me` → `{user, profile, roles: string[], permissions: string[]}` (frontend renders from this; permissions are display hints only).
  - `PATCH /v1/me/profile` — handle rules: `^[a-z0-9_]{3,30}$` after lower-casing, reserved list (`admin`, `api`, `skiller`, `support`, `settings`, `me`, `v1`) → `HANDLE_RESERVED`; taken → `HANDLE_TAKEN`. `avatarAssetId`/`bannerAssetId` accepted only once Task 13 lands — validated with `MediaService.attach` (READY, owned by caller, matching purpose, else `MEDIA_NOT_USABLE`). Task 13 adds that wiring and its test.
  - `PUT /v1/me/experience` (replace list, max 30), same for `education`, `skills` (max 50, each ≤40 chars), `portfolio` (max 30).
  - `GET /v1/profiles/:handle` (`@Public`) → profile + experience + education + skills + portfolio + `isFollowing` when authenticated.
  - `POST /v1/profiles/:handle/follow`, `DELETE ...` — idempotent; self-follow → `FOLLOW_SELF`; counters updated in same transaction.
  - `GET /v1/profiles/:handle/followers|following` paginated.
  - `POST /v1/me/become-creator {acceptTerms: true}` → grants `creator`, `isCreator=true`, emits `user.became_creator` (Phase 2 subscribes to create wallet + Free plan). Already creator → 200 no-op.
- [ ] **Step 1: Failing tests:** **Review Focus 5:** `@Aftab` when `aftab` exists → `HANDLE_TAKEN`; reserved handle rejected; follow twice keeps count 1; unfollow non-followed is 204 and count unchanged; become-creator adds `creator` to `/v1/me` roles and emits one outbox event.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: profiles, follows, creator onboarding`.

---

### Task 12: Organizations

**Files:**
- Modify: `prisma/schema.prisma` — add `Organization`, `OrgInvite`
- Create: `src/modules/organizations/*`
- Test: `test/e2e/organizations.e2e-spec.ts`

**Interfaces:**
- Models: `Organization(id, slug String @unique, name, logoAssetId?, about?, ownerId, createdAt)`; `OrgInvite(id, orgId, email, roleKey, tokenHash @unique, expiresAt /* +7 days */, acceptedAt?, invitedById)`. Membership = `UserRole` rows with `orgId` (no separate members table).
- Produces:
  - `POST /v1/orgs` (`org.create`) → creator gets `org_owner` for that org.
  - `GET /v1/orgs/:slug` public; `PATCH /v1/orgs/:slug` (`org.manage`, `orgParam: "slug"`).
  - `POST /v1/orgs/:slug/invites {email, roleKey ∈ org_instructor|org_learner}` (`org.invite`) → mail `org_invite` with link containing raw token.
  - `POST /v1/org-invites/accept {token}` → must be logged in with the invited email (`INVITE_EMAIL_MISMATCH`), grants role, marks accepted; expired → `INVITE_EXPIRED`; reused → `INVITE_USED`.
  - `GET /v1/orgs/:slug/members`, `DELETE /v1/orgs/:slug/members/:userId` (`org.manage`); owner cannot remove self → `ORG_OWNER_REQUIRED`.
  - Seat limits deferred to Phase 2 entitlements (no check in Phase 1).
- [ ] **Step 1: Failing tests:** owner invites, invitee accepts, invitee has `org_instructor` only in that org; accepting with different logged-in email fails; instructor cannot invite (403 `FORBIDDEN`).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: organizations and invites`.

---

### Task 13: Media upload sessions (R2 multipart)

**Files:**
- Modify: `prisma/schema.prisma` — add `MediaAsset`
- Create: `src/modules/media/media.rules.ts`, `r2.client.ts`, `media.service.ts`, `media.controller.ts`, `media.module.ts`
- Test: `src/modules/media/media.rules.spec.ts`, `test/e2e/media-upload.e2e-spec.ts` (R2 replaced by MinIO testcontainer — S3-compatible)

**Interfaces:**
- Model: `MediaAsset(id, ownerId, purpose MediaPurpose /* AVATAR|BANNER|THUMBNAIL|GIG_GALLERY|REEL|COURSE_LESSON|COURSE_RESOURCE */, bucket MediaBucket /* PUBLIC|PRIVATE */, status MediaStatus /* PENDING|UPLOADED|PROCESSING|READY|FAILED */, objectKey, mime, declaredSize BigInt, uploadId?, durationSec Float?, width?, height?, renditions Json?, posterKey?, failureReason?, attachedAt?, createdAt, updatedAt)`.
- Produces:
  - `MEDIA_RULES: Record<MediaPurpose, {bucket; mimes: string[]; maxBytes: number; maxDurationSec?: number; kind: "image" | "video" | "file"}>` — values exactly from Global Constraints; `course_lesson` maxBytes 5 GB per file at Phase 1 (plan quota enforced Phase 2).
  - `R2Client`: `createMultipart(bucket, key, mime)`, `presignParts(bucket, key, uploadId, partCount): string[]` (URL TTL 1 h, part size 10 MB), `completeMultipart(bucket, key, uploadId, parts: {partNumber, etag}[])`, `head(bucket, key): {size}`, `delete(bucket, key)`, `getObject`, `putObject`.
  - `MediaService.createUpload(userId, {purpose, filename, mime, size}): Promise<{assetId, partSize, partUrls: string[]}>` — object key `{purpose}/{ownerId}/{assetId}/source`; images ≤10 MB use single presigned PUT (`partUrls.length === 1`, no `uploadId`).
  - `MediaService.complete(userId, assetId, parts): Promise<MediaAssetDto>` — idempotent: already `UPLOADED|PROCESSING|READY` → return current. `head` size ≠ declared → status `FAILED`, `UPLOAD_SIZE_MISMATCH`. Video → enqueue `media.transcode` (`jobId = assetId`). Image → enqueue `media.image` (resize to webp 256/1024; avatar square crop) then READY.
  - `MediaService.attach(tx, assetId, ownerId, purpose): Promise<void>` — exported for other modules; sets `attachedAt`; validates owner + purpose + READY → `MEDIA_NOT_USABLE`.
  - `GET /v1/media/:id` (owner or `media.manage_any`) → status + public URLs (public bucket) — poll target for frontend.
  - Endpoints require `media.upload`; purposes `REEL`, `COURSE_LESSON`, `COURSE_RESOURCE` additionally require `Profile.isCreator` → `CREATOR_REQUIRED`.
  - Wire `PATCH /v1/me/profile` avatar/banner (and org logo) through `MediaService.attach`.
- [ ] **Step 1: Failing tests:** rules: 11 MB avatar → `MEDIA_TOO_LARGE`; `image/gif` reel → `MEDIA_TYPE_NOT_ALLOWED`; non-creator reel → `CREATOR_REQUIRED`. e2e: create → PUT parts to MinIO → complete → status `PROCESSING` and one job queued; **Review Focus 4:** complete twice → same asset, still one job; upload 1 byte short → `UPLOAD_SIZE_MISMATCH`, status `FAILED`; setting avatar to another user's READY asset → `MEDIA_NOT_USABLE`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: r2 media upload sessions`.

---

### Task 14: Transcode worker, image processing, cleanup

**Files:**
- Create: `src/modules/media/ffmpeg.ts`, `transcode.processor.ts`, `image.processor.ts`, `media-cleanup.processor.ts`, `Dockerfile.worker`; `test/fixtures/sample-3s-720p.mp4`, `sample-portrait-100s.mp4` (generated by `ffmpeg -f lavfi` in a script `test/fixtures/make.sh`)
- Test: `src/modules/media/ffmpeg.spec.ts`, `transcode.processor.int-spec.ts`

**Interfaces:**
- Produces:
  - `probe(path): Promise<{durationSec; width; height; hasVideo; hasAudio}>`.
  - `ladderFor(sourceHeight: number): Array<{name: "240p"|"480p"|"720p"|"1080p"; height; videoKbps; audioKbps}>` — bitrates 240p 400k, 480p 1000k, 720p 2500k, 1080p 5000k, audio 96k (240p/480p) / 128k; includes rungs ≤ source height, always at least 240p. Portrait sources ladder on width instead of height.
  - `transcodeToHls(input, outDir, ladder): Promise<void>` — 6 s segments, `hls_playlist_type vod`, master `index.m3u8`, H.264 + AAC.
  - Processor flow: download source to tmp → probe → reject (`FAILED`, reason `NO_VIDEO_STREAM` / `DURATION_EXCEEDED`) → transcode → poster at 1 s → upload `hls/` + `poster.jpg` under asset prefix in same bucket → status READY with `renditions`, `durationSec` → outbox `media.ready`; failure → `media.failed` (mail `media_failed`). Job attempts 2; tmp dir always removed.
  - Cleanup repeatable job hourly: assets with `attachedAt IS NULL AND createdAt < now() - 24h` → delete R2 prefix + row (every consumer calls `MediaService.attach`, so in-use assets always have `attachedAt`). Also aborts R2 multipart uploads for `PENDING` assets older than 24 h.
  - `Dockerfile.worker`: `node:22-bookworm-slim` + `apt-get install ffmpeg`.
- [ ] **Step 1: Failing tests:** `ladderFor(720)` → 240p,480p,720p; `ladderFor(1440)` → four rungs ending 1080p; `ladderFor(200)` → `[240p]`. Integration (ffmpeg on PATH; skipped with clear message if absent): 3 s fixture → READY, master playlist lists 3 renditions, poster exists; 100 s reel → FAILED `DURATION_EXCEEDED`; cleanup deletes unattached 25 h-old asset and keeps attached one.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: hls transcode worker and media cleanup`.

---

### Task 15: Signed private playback + Cloudflare playback gate

**Files:**
- Create: `src/modules/media/playback-token.ts`, `playback.service.ts`; `edge/playback-gate/src/index.ts`, `wrangler.toml`, `test/index.test.ts`, `edge/playback-gate/package.json`
- Test: `src/modules/media/playback-token.spec.ts`, edge tests via `vitest` + `@cloudflare/vitest-pool-workers`

**Interfaces:**
- Produces:
  - `signPlaybackToken(claims: {u: string; a: string; exp: number}, secret: string): string` → `base64url(json).base64url(hmacSha256)`; `verifyPlaybackToken(token, secret, nowSec): claims | null`. Same algorithm implemented in the edge worker with WebCrypto; shared test vectors in `edge/playback-gate/test/vectors.json` used by both test suites.
  - `PlaybackAccessPolicy` interface `{ canPlay(userId: string, asset: MediaAsset): Promise<boolean> }` — Phase 1 implementation: owner or `media.manage_any`. Phase 3 (courses) registers enrolment policy.
  - `GET /v1/media/:id/playback` → `{manifestUrl: "${playbackBaseUrl}/${assetId}/hls/index.m3u8?t=<token>", expiresAt, watermark: <user email>}`; private bucket only; not READY → `MEDIA_NOT_READY`; denied → 403 `FORBIDDEN`.
  - Edge worker: route `playbackBaseUrl/*`; extracts `assetId` from path, verifies token (`a` must equal path asset, `exp` future), fetches object from R2 binding; for `.m3u8` responses rewrites every segment/variant URI to append `?t=<same token>`; `Cache-Control: private, max-age=60` for playlists, `private, max-age=600` for segments; invalid → 403.
- [ ] **Step 1: Failing tests:** token round-trip; tampered payload → null; expired → null; edge: valid token → 200 and rewritten playlist lines end with `?t=`; token for asset A on asset B path → 403; missing token → 403.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: signed hls playback gate`.

---

### Task 16: In-app notifications

**Files:**
- Modify: `prisma/schema.prisma` — add `Notification`, `NotificationPreference`
- Create: `src/modules/notifications/*`
- Test: `test/e2e/notifications.e2e-spec.ts`

**Interfaces:**
- Models: `Notification(id, userId, type String, title, body, link String?, data Json?, readAt?, createdAt)` index `(userId, readAt, createdAt)`; `NotificationPreference(userId, type, inApp Boolean, email Boolean) @@id([userId, type])`.
- Produces:
  - `NotificationsService.notify(userId, {type, title, body, link?, data?, email?: {template: MailTemplate; data}})` — checks preference (defaults: in-app on, email on for transactional types), writes row, optionally `MailService.send`.
  - Handlers (worker, via `EventBus`): `user.registered` → `welcome` email + in-app; `media.ready` → in-app "Your video is ready"; `media.failed` → in-app + `media_failed` email; `role.granted` → in-app; `org.member_invited` handled by orgs (email only).
  - `GET /v1/notifications` paginated, `GET /v1/notifications/unread-count`, `POST /v1/notifications/:id/read`, `POST /v1/notifications/read-all`, `GET/PUT /v1/me/notification-preferences`.
  - OTP mail never routed through preferences.
- [ ] **Step 1: Failing tests:** `media.ready` event → one notification for owner; unread count decrements on read; read another user's notification → 404 `NOTIFICATION_NOT_FOUND`; email preference off → no mail job for `media_failed` but in-app row created.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: in-app notifications`.

---

### Task 17: Admin shell — users, settings, feature flags

**Files:**
- Create: `src/modules/admin/admin-users.controller.ts`, `settings.service.ts`, `flags.service.ts`, `admin.module.ts`
- Test: `test/e2e/admin.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `GET /v1/admin/users?q=&status=&role=` (`user.view`) — `q` matches email prefix or handle prefix; paginated.
  - `GET /v1/admin/users/:id` → user, profile, roles, active sessions count, recent audit entries.
  - `POST /v1/admin/users/:id/suspend {reason}` / `unsuspend` (`user.suspend` + step-up) → status change, `UserStatusCache.bust`, revoke all sessions, audit. Cannot suspend self → `ADMIN_SELF_ACTION`; cannot suspend a `super_admin` unless actor is `super_admin` → `ROLE_ESCALATION_DENIED`.
  - `POST /v1/admin/users/:id/revoke-sessions` (`user.revoke_sessions`).
  - `SettingsService.get<T>(key: SettingKey): Promise<T>` with typed defaults (`hold_days: 7`, `max_upload_mb_course_lesson: 5120`, `reel_max_seconds: 90`), Redis-cached 60 s; `GET/PUT /v1/admin/settings` (`settings.manage`, step-up, audit; value validated by per-key Zod schema).
  - `FlagsService.isEnabled(key: string, ctx?: {userId?: string}): Promise<boolean>` (rules: `{allowUserIds?: string[], percent?: number}`; percent hashed on userId); `GET/PUT /v1/admin/flags` (`flags.manage`, audit). Seed flag `gig_orders` = false.
- [ ] **Step 1: Failing tests:** **Review Focus 2:** suspend → suspended user's existing access token → 403 within same test; moderator cannot suspend super-admin; setting `hold_days` to `-1` → `VALIDATION_FAILED`; flag at `percent: 0` false, `allowUserIds` includes user → true; every admin mutation has audit row.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: admin shell`.

---

### Task 18: OpenAPI, observability, CI, deploy images

**Files:**
- Create: `src/common/observability/sentry.ts`, `scripts/export-openapi.ts`, `openapi.json` (generated, committed), `Dockerfile`, `.github/workflows/ci.yml`, `README.md`
- Modify: `src/main.ts`, `.eslintrc.cjs` (boundaries rules)
- Test: `test/e2e/openapi.e2e-spec.ts`

**Interfaces:**
- Produces:
  - Swagger at `/v1/docs` (non-production only); `pnpm openapi:export` writes `openapi.json`; every error response documented with the shared error schema.
  - Pino: JSON in production, pretty in dev; redact paths from Global Constraints. Sentry init when `sentryDsn` set; `AppError` with status < 500 not reported.
  - ESLint boundaries: `src/modules/<x>` may import `src/common/**`, `src/infra/**`, and only `src/modules/<y>/index.ts` of other modules. Each module gets an `index.ts` exporting its public services/types.
  - CI jobs: install (pnpm cache) → lint → typecheck → `prisma validate` + `prisma migrate diff --exit-code` against migrations → unit + integration + e2e (Docker services via Testcontainers) → `openapi:export` and `git diff --exit-code openapi.json` → build both images.
  - `Dockerfile` (API): multi-stage, `node:22-bookworm-slim`, non-root user, `CMD node dist/main.js`; release command `pnpm prisma migrate deploy && pnpm db:sync-permissions`.
- [ ] **Step 1: Failing test:** `openapi.e2e-spec` — generated spec contains `/v1/auth/otp/request` and every operation has a `401` and `default` error response referencing `ErrorResponse`.
- [ ] **Step 2:** Introduce a deliberate cross-module deep import in a scratch file; `pnpm lint` → fails with boundaries error; remove it.
- [ ] **Step 3–4:** implement → full suite `pnpm test && pnpm test:e2e` → PASS; `docker build -f Dockerfile .` and `-f Dockerfile.worker .` succeed.
- [ ] **Step 5:** Commit `chore: openapi, observability, ci, docker`.

---

## Phase 1 exit check

- [ ] Fresh DB: `pnpm prisma migrate deploy && pnpm db:seed` → super admin exists.
- [ ] Manual run (API + worker + MinIO/R2 test bucket + Resend test key): sign in by OTP, edit profile, upload avatar → READY, become creator, upload 3 s video → READY, fetch playback URL → plays through edge gate (wrangler dev), admin creates custom role and grants it, audit log shows both.
- [ ] `openapi.json` handed to frontend for client generation.
