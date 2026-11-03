# Review: Tasks 16-17 (7ef1394..bf63cb3)

Line refs are to the review diff file (review-7ef1394..bf63cb3.diff) unless prefixed with a path.

### Spec Compliance
- Spec compliant, with one cosmetic deviation: the admin controller is `admin.controller.ts`, not `admin-users.controller.ts` (diff:543). Reported by the implementer; harmless.
- Cannot verify from the diff:
  - The real `WorkerModule` DI graph for `NotificationsWorkerModule`. The e2e test registers `NotificationEventHandlers` inside the API test app (notifications.e2e-spec:2047). Nothing boots `WorkerModule` and checks the handlers register. `EventBus`, `MailService` and `PrismaService` resolve only if their modules are `@Global`. `OutboxModule` and `MailModule` are global (grep). I did not check `PrismaModule`.
  - Whether `recentAudit` in admin user detail (diff:463) can carry emails in before/after payloads of other actions. It is gated by `user.view` anyway.

### Strengths
- Idempotency is layered. The unique `(userId, sourceEventId)` row plus `createMany skipDuplicates` (diff:1492-1505) dedupes rows. The mail job id `mail-<eventId>-<userId>-<type>` (diff:1514, mail.service diff:1065) dedupes mails while the job exists. `mail.processor` forwards `mail-<job.id>` as Resend's Idempotency-Key (mail.processor.ts:47). The mail is still enqueued when the row already existed, so a crash between insert and enqueue loses nothing.
- IDOR is closed. `markRead` scopes the update and the read by `userId` (diff:1536-1538), and every other query is `userId`-scoped. Another user's id returns 404, and the test checks it stays unread (diff:2104-2115).
- OTP never touches notify. Preferences only gate notify-originated mail.
- Suspend commits status and audit in one transaction under `FOR UPDATE` (diff:961-966). It is idempotent, with no duplicate audit row. The self-check and escalation check run before any write.
- Settings and flags fail safe: an invalid stored value falls back to the default (settings), or the flag is off (flags, diff:766-767).
- Admin module touches foreign data only through owner-service methods, with one exception (Important 1).

### Named risks
- (a) AuthGuard order (diff:984-991): no bypass. A revoked session of an ACTIVE user still reaches `isRevoked` and gets 401. A SUSPENDED or DELETED user now gets 403 even when the session is revoked. Only the error code changed. Fail-closed on Redis errors is unchanged.
- (b) EventBus: the `meta` argument is additive, and the existing handlers declare `(e)` and ignore it. Handlers registered via `bus.on` (grep): `rbac.permissions_changed` (permission-invalidation.handler.ts:14), `user.registered` profile handler (profile-registration.handler.ts:14), and the four new notification handlers. The only handler removed is `MediaFailedMailHandler`, and `MediaWorkerModule` registered nothing else. No handler silently stopped running. `OutboxProcessor` now passes `job.data.id` (diff:354). The content-hash fallback is test-only. See Minor 7 for the unverified worker wiring.
- (c) Removing `MediaFailedMailHandler`: with prefs on (default for `media.failed`), exactly one mail per event. Redelivery of the same event id is a jobId no-op while the job is retained (default completed retention is 1 h, queue.module.ts:21) and a Resend 24 h idempotency no-op after that (Minor 5). With `email=false`, `pref.email` is false and no mail is queued (diff:1508); the test covers it (diff:2130-2144). The old dedupe was per assetId and the new one is per event id. `markFailed` emits once per asset, so this is equivalent. The `REASONS` text is duplicated into the new handler (diff:1230), which is fine.
- (d) IDOR: no issue (see Strengths).
- (e) Search: the claims are only partly true. See Important 2 and 3, and Minor 1.
- (f) Flag hash: sha256(`key:userId`), first 4 bytes mod 100 (diff:701). It is stable and per-flag independent. Bias is about 1 in 4e7 because 2^32 mod 100 = 96, which is negligible. Raising `percent` is monotonic. `percent:0` is off, 100 is on, and no `userId` means off unless percent is 100. Correct.
- (g) Email leakage: every route that returns an email (`GET /admin/users`, `GET /admin/users/:id`) is `@RequirePermission("user.view")` (diff:585,591). Suspend, unsuspend and revoke return ids only. Settings and flags carry no PII. No leak found.

### Issues

#### Critical
None.

#### Important
1. `src/modules/admin/admin-users.service.ts:498` (diff:498): `tx.user.findUnique` reads the identity-owned `users` table from the admin module. This breaks the "module reads only its own tables" constraint. The read is also unlocked: the user could become DELETED between this check and `changeStatus`, which would revive a deleted account to ACTIVE. Fix: drop the pre-read and do what `suspend` does. Call `changeStatus`, then throw `USER_DELETED` if `from === "DELETED"`; the throw rolls back the transaction.
2. `src/modules/identity/account.service.ts:941-945`, `src/modules/users/profiles.service.ts:1670`, `admin.controller.ts:566` (diff:940, 1668, 566): `q` goes straight into Prisma `startsWith`, and the controller only enforces min 2 chars. `%` and `_` are not escaped or rejected in app code, and no test covers them. Whether Prisma escapes LIKE metacharacters on this path is unverified. If it does not, `q=%%` or `q=__` becomes a match-everything pattern that defeats the "prefix index" claim and returns wrong results. Literal `_` in emails or handles would also over-match. Fix: escape `\`, `%` and `_` (or reject them in the zod schema), and add a test with `q=%%`.
3. `test/e2e/admin.e2e-spec.ts:1889-1896` (diff:1889): the "search uses the prefix indexes" test proves little.
   - The regex accepts `users_pkey|users_email_key|profiles_handle_key`. With `SET enable_seqscan=off`, the `ORDER BY id DESC LIMIT` plan uses `users_pkey` even if the pattern index is unused, so it passes without the new migration.
   - It EXPLAINs a literal `'abc%'`, not the parameterized Prisma query. A generic prepared plan cannot use a prefix index with `LIKE $1`.
   - Session `SET` / `RESET` goes through the Prisma pool. They may run on different connections and leave `enable_seqscan=off` on a pooled connection for the rest of the suite.
   Fix: assert that the plan names `users_email_pattern_idx` with a query that has no `ORDER BY id`, and run it on a single connection or transaction (`SET LOCAL`).

#### Minor
1. `admin-users.service.ts:429-431`: the "bounded scan" holds in rounds (5 per request), not in rows. `ORDER BY id DESC LIMIT n` over an email-prefix match with a `id < cursor` filter sorts the whole prefix match each round, and a 2-char prefix can match a lot. Acceptable for an admin-only endpoint; note it.
2. `admin-users.service.ts:519-522`: if `bustStatus` exhausts retries it throws before `revokeAllForUser` runs, so sessions are not revoked on that path. Attempt both, then throw. Whether refresh also rejects suspended users is not visible in this diff.
3. `admin-users.service.ts:511-515`: revoke-sessions revokes first and audits in a separate transaction afterward. An audit failure leaves an unaudited mutation. This is unavoidable with Redis markers, but note it against "every admin mutation writes an audit row".
4. `admin-users.service.ts:495-509`: unsuspend has no `ROLE_ESCALATION_DENIED` check, so a `user.suspend` holder can unsuspend a suspended `super_admin`. The brief only mandates the check on suspend, but it is an easy reversal path.
5. Mail dedupe is bounded. The BullMQ jobId guard lasts only while the job is retained (1 h on complete). Beyond that it relies on Resend's 24 h idempotency window. A mail job left in `failed` (kept 7 d) makes later `add` calls with the same id silently no-ops.
6. `flags.service.ts:721`: rules `{}` means "on for everyone", while `{allowUserIds: []}` means "off for everyone". The inconsistency is surprising. Consider rejecting empty rules.
7. No test boots `WorkerModule` or `NotificationsWorkerModule` to confirm the handlers register in the real worker (see the Spec Compliance caveat).
8. `media.ready` notifies for every purpose, including avatars and thumbnails ("Your upload is ready"), which is noisy. The implementer flagged it. The welcome mail name is the email local part (diff:1258).
9. `roles.service.ts:1596-1603`: `userIdsWithPlatformRole` could return duplicate user ids (nullable `orgId` defeats the unique constraint). This would cause duplicate rows in the page and an under-filled `nextCursor`. Low likelihood.
10. `notifications.service.ts:1536,1543`: `new Date()` instead of the injected Clock (used elsewhere in the codebase). The list query orders by `id` while the `unread` filter's index is `(userId, readAt, createdAt)`.
11. The `media.failed` reasons text hard-codes "90 seconds" (diff:1231). The `reel_max_seconds` setting is now editable but not consumed (reported by the implementer).

Minor count: 11

### Assessment
**Task quality:** Needs fixes

**Reasoning:** The notification idempotency, IDOR protection, suspend ordering and flag hashing are solid, and the named risks (a)-(d), (f) and (g) check out. Three Important items remain: a cross-module `users` read with a revive-DELETED race, unescaped LIKE wildcards on the admin search, and a vacuous index test that can leak planner settings to pooled connections.
