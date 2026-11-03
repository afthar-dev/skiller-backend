# Review: Tasks 9 and 10 (71c1fee..5f1d202)

## Spec Compliance

Issues found (one global constraint not met: "permission removed from a role takes effect on the next request").
Everything else in both briefs is present: models, NULLS NOT DISTINCT unique index, registry/definePermissions, sync (upsert, never delete, orphans logged, super_admin re-grant), seed, PermissionService, guard + boot check, AuditService.record signature, all endpoints, error codes, step-up on grant/revoke, MemberRoleGranter rebind, outbox `role.granted`.

Cannot verify from diff: (a) HealthController and any other pre-existing route carry @Public (boot check would otherwise fail; implementer's e2e boots, so likely fine); (b) "active super_admin" with respect to suspended users (brief silent; code counts only expiry).

## Strengths
- Single AccessGuard fixes AuthN-then-AuthZ order independent of module import order; 401 for none/invalid/malformed tokens is tested on a @RequirePermission route. @RequireStepUp is a method-level guard so it runs after the global permission check (403 FORBIDDEN before STEP_UP_REQUIRED). Correct.
- Org isolation correct: byOrg keyed by orgId, `has` only consults byOrg[orgId] or platform; `assertActorHolds` uses platform + the target org only. Tested (permission.service.int-spec, access.e2e-spec).
- Expired UserRole handled consistently: `effective` filters in SQL (used by guard and by assertActorHolds), last-super-admin query filters expiry, cache TTL clipped to earliest expiry. Re-grant of an expired row renews it instead of hitting the unique slot.
- LAST_SUPER_ADMIN: `FOR UPDATE` on all active rows, ordered by id; reasoning on READ COMMITTED re-check holds (deleted rows skipped after the first commit). Concurrency test with RED evidence.
- SQL injection: the only raw query (roles.service.ts:~207) is a tagged-template `$queryRaw` (parameterised: roleId and now are bound). Migrations are static DDL. Everything else is Prisma query builder. Safe.
- Audit rows written with the mutation's tx client; failed mutation leaves none; tested.
- Sensible extra hardening (escalation on create/update/revoke, super_admin permissions frozen).

## Issues

### Critical
None.

### Important
1. permission.service.ts:30-66 (and 77, 87): stale-write race is real and violates "next request". `effective()` does GET miss -> DB read -> `SET ... EX` with no version/CAS. Interleaving: reader R reads DB (old grants); admin commits revoke and `invalidateUser` DELs the key; R then SETs the old set. The stale entry lives up to 600 s, so a revoked permission (including super_admin, or role.grant used by `assertActorHolds`) keeps working for up to 10 minutes. The window is small per event but unbounded by anything except the TTL, and the constraint is explicit. Fix: per-user epoch. `invalidate*` does `INCR permv:{userId}`; the reader GETs the epoch before the DB read and writes via a Lua script (or WATCH/MULTI) that SETs only if the epoch is unchanged; also embed the epoch in the cache key (`perm:{userId}:{epoch}`) so a stale writer lands on a dead key. Add a test that interleaves read, invalidate, write. Note the briefs fix the key as `perm:{userId}`; keep that key for the value and add a sibling epoch key.
2. roles.service.ts:111,127,174,211 (invalidate after commit, outside the tx, no retry): if Redis fails after the DB commit, the request returns 500 but the change is committed and the cache is stale up to TTL. For `revoke` a client retry gets 404 (row already gone), so invalidation is never re-attempted. Fix: epoch bump (item 1) done before commit as well as after, or make invalidation idempotent-retriable (outbox job `perm.invalidate`), or on revoke NOT_FOUND still invalidate `expectedUserId`.

### Minor (8)
1. permission-sync.ts:70-79 and permission-sync.ts (`syncPermissions` super_admin auto-grants, `seedSystemRoles`): `bootstrapSuperAdmin` grants super_admin and sync grants keys with no `audit_logs` row; constraint says every role change is audited (system actor).
2. roles.service.ts:135,85,180: role/permission set used for the escalation check is read outside the transaction; a concurrent role update can add a permission between check and write (TOCTOU). Re-read inside the tx.
3. permission.guard.ts:35: 403 body includes `details.permission` (the required key) - discloses internal permission names to any authenticated user.
4. roles.service.ts:218-232: `grantSystem` does not check role scope; an ORG role with orgId null would become a platform-wide grant of org permissions. Only called with constants today.
5. route-guard-check.ts:27: only `Object.getOwnPropertyNames(proto)` is scanned; route handlers inherited from a base controller class are not checked.
6. permission.guard.ts:21: `getAllAndOverride` lets a class-level @RequirePermission apply to a method marked @Public; AuthGuard skips auth, then the guard throws 401 on a route declared public. Boot check passes it. Edge case but confusing.
7. permission.service.ts:~64: `Math.max(1, floor(...))` can keep an entry up to 1 s past the grant's expiry; no test that `assertActorHolds` ignores an expired grant (covered only indirectly through `effective`).
8. orgId is free-form (no org table/validation yet) in grant/guard; revisit when the org module lands.

## Assessment

**Task quality:** Needs fixes

**Reasoning:** Design is sound and well tested for ordering, org isolation, expiry, last-super-admin locking and SQL safety, but the permission cache can be repopulated with a pre-invalidation set (and invalidation failure is not retried), so the "next request" guarantee is not actually met; fix with an invalidation epoch/CAS write.
