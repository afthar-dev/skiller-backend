# Re-review Tasks 9-10, fix round 1 (5f1d202..c90e5f2)

## Finding Verdicts

1. **Permission cache stale-write race** - ADDRESSED.
   permission.service.ts: `effective()` reads `perm:epoch:{userId}` first, then the cache key `perm:{userId}:{epoch}`, then the DB, and SETs under the captured epoch's key. `invalidateUsers` INCRs the epoch. A reader that loaded old grants before a bump writes to an old-epoch key nobody reads. The bump happens after commit, so any reader that captures the post-bump epoch also reads post-commit DB state. The interleaving test (permission.service.int-spec.ts "a reader that loaded the old grants...") is sound: the `findMany` spy is `mockImplementationOnce`, so the inner `invalidateRole` query is not intercepted. It asserts that the in-flight reader sees stale=true and that the next `has` is false. The epoch-reset hole below is a separate new defect.

2. **Invalidation after commit with no retry/backstop** - ADDRESSED.
   - roles.service.ts `invalidateWithRetry`: 3 attempts, 25/50 ms backoff, final failure is logged via `Logger.error` and returns normally (success is preserved).
   - `enqueueInvalidation(tx, ...)` writes `rbac.permissions_changed {userIds}` inside the mutation transaction for update, delete, grant and revoke. `grantSystem` with a caller tx is deliberately excluded (a new user has no cached permissions).
   - The handler `PermissionInvalidationHandler` registers on the shared `EventBus` in `onModuleInit` and calls `invalidateUsers`.
   - The e2e test mocks `redis.incr` to reject during the PATCH, asserts 200, then asserts the route is still stale (200). It then dispatches the outbox events through `EventBus` and asserts 403.
   - The test dispatches by hand rather than through the worker/relay.

3. **LAST_SUPER_ADMIN counts SUSPENDED/DELETED** - ADDRESSED.
   roles.service.ts `revoke`: the locking query joins `users` with `u.status = 'ACTIVE'` and uses `FOR UPDATE OF ur`. The UserStatus enum has only ACTIVE, SUSPENDED and DELETED, so every non-active state is excluded. The e2e test ("a suspended super_admin does not count as active") expects 409 LAST_SUPER_ADMIN and restores state in `finally`.

## Specific questions

- **Epoch TTL (24 h) expiring and restarting: stale key readable after reset? Yes. Important (narrow window).**
  `EPOCH_TTL_SEC` is set only on bump (permission.service.ts, `invalidateUsers`), not refreshed on reads. The comment "far longer than any cache entry, so a lapsed epoch can never revive a live key" is wrong. A cache entry written under epoch n at t0+23h59 (the epoch's TTL started at the bump at t0) outlives the epoch key by up to 10 min.
  - Failing sequence: the epoch is 1 (one bump in the cycle, the common case) and a user is active, so `perm:u:1` is cached up to ~10 min after the epoch key expires.
  - The epoch key lapses and reads fall back to epoch 0.
  - A permission change within that 10-minute tail INCRs the missing key to 1.
  - Readers then hit the surviving pre-change `perm:u:1` for up to ~10 min. That breaks "takes effect on the next request".
  - Only epoch == n can collide, so n bumps must land in the window. For n=1 that is a single revoke shortly after the 24 h mark.
  - Fix: do not expire the epoch key (one tiny key per user). Or refresh its TTL on every `effective()`. Or seed missing epochs from a time/random base so a reset can never reuse a number.
- **Is the worker handler registered in the worker process? Yes.**
  - `WorkerModule` imports `RbacWorkerModule`, which provides `PermissionService` and `PermissionInvalidationHandler`.
  - `EventBus` is exported by the `@Global` `OutboxModule`, which is imported in the worker.
  - `PrismaModule`, `RedisModule` and `ClockModule` are all `@Global`. `ClockModule` is also imported explicitly.
  - `OutboxProcessor` dispatches `{type, ...payload}` on the same singleton `EventBus`.
  - The API process also registers the handler (harmless: idempotent bumps).
  - No test boots the worker context to prove the wiring; I verified it by reading the code only.
- **Relaxed concurrent-revoke test still meaningful? Yes.**
  The invariants are exactly one 204, the loser's error in {LAST_SUPER_ADMIN, ROLE_ESCALATION_DENIED}, and exactly one active super_admin left. Without the lock both revokes could succeed, and the final count assertion would catch it. The report says removing `FOR UPDATE` failed 4/4 runs; that is a claim I did not re-run, but it is plausible from the code. The cost is that the lock path itself is no longer asserted to be hit on every run.

## New Breakage in the Fix Diff

- **Important:** permission.service.ts `EPOCH_TTL_SEC` / `invalidateUsers`: epoch expiry can revive a stale `perm:{userId}:{n}` entry (details above). Reachable but narrow; fix is one line (drop the TTL or refresh it).
- No Critical.

Minor (5):
1. `currentCacheKey` is test-only API on the production service (permission.service.ts).
2. `incr` and `expire` are not atomic, and `expire` failure is swallowed (permission.service.ts). The epoch then persists without a TTL, which is harmless.
3. Suspending a user does not lock the `users` row, so a status change can race the super_admin count (roles.service.ts revoke).
4. No test boots the worker module to prove handler registration. The e2e backstop test dispatches via `EventBus` manually.
5. `invalidateWithRetry` uses a raw `setTimeout` backoff and the retry delays are not covered by a test of the exhausted path's logging.

## Out-of-Scope Observations

None.

## Verdict

**Fix round:** Findings remain open: none of the three listed findings. All three are ADDRESSED, but the fix introduces one new Important issue (epoch TTL expiry reviving a stale key, permission.service.ts `EPOCH_TTL_SEC` / `invalidateUsers`) that should be fixed before closing the task.
