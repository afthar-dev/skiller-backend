import { Controller, Get } from "@nestjs/common";
import { addDays, istDateOf } from "../../src/common/clock/ist";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import request from "supertest";
import { EventBus } from "../../src/common/outbox/event-bus";
import type { DomainEvent } from "../../src/common/outbox/events";
import { REDIS } from "../../src/common/redis/redis.constants";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { PermissionService } from "../../src/modules/rbac/permission.service";
import { RequirePermission } from "../../src/modules/rbac/require-permission.decorator";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

@Controller("test-roles")
class MediaTestController {
  @Get("media")
  @RequirePermission("media.manage_any")
  media() {
    return { ok: true };
  }
}

const uid = () => randomUUID().replace(/-/g, "").slice(0, 10);
type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("roles and audit", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let admin: Session; // the seeded super admin
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function stepUp(s: Session) {
    const before = t.mail.sent.filter((m) => m.to === s.email).length;
    const res = await http().post("/v1/auth/step-up/request").set(auth(s)).set("X-Forwarded-For", uniqueIp());
    expect(res.status).toBe(202);
    const code = await t.codeFor(s.email, before);
    const ok = await http().post("/v1/auth/step-up/verify").set(auth(s)).send({ challengeId: res.body.challengeId, code });
    expect(ok.status).toBe(204);
  }

  const createRole = (s: Session, body: object) => http().post("/v1/admin/roles").set(auth(s)).send(body);
  const grant = (s: Session, userId: string, body: object) => http().post(`/v1/admin/users/${userId}/roles`).set(auth(s)).send(body);
  const revoke = (s: Session, userId: string, userRoleId: string) => http().delete(`/v1/admin/users/${userId}/roles/${userRoleId}`).set(auth(s));
  const mediaRoute = (s: Session) => http().get("/v1/test-roles/media").set(auth(s));
  const roleKey = (prefix: string) => `${prefix}_${uid()}`;
  const auditRows = (targetType: string, targetId: string) =>
    prisma.auditLog.findMany({ where: { targetType, targetId }, orderBy: { id: "asc" } });

  /** Leaves exactly the given users holding an active platform super_admin grant. */
  async function onlySuperAdmins(userIds: string[]) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
    const stale = await prisma.userRole.findMany({ where: { roleId: role.id, userId: { notIn: userIds } }, select: { userId: true } });
    await prisma.userRole.deleteMany({ where: { roleId: role.id, userId: { notIn: userIds } } });
    const perms = t.app.get(PermissionService);
    await perms.invalidateUsers(stale.map((s) => s.userId));
    for (const userId of userIds) {
      if (!(await prisma.userRole.findFirst({ where: { roleId: role.id, userId, orgId: null } }))) {
        await prisma.userRole.create({ data: { roleId: role.id, userId } });
      }
      await perms.invalidateUser(userId);
    }
  }

  beforeAll(async () => {
    t = await createAuthTestApp({ controllers: [MediaTestController] });
    prisma = t.app.get(PrismaService);
    admin = await t.login("admin@skiller.test");
    await stepUp(admin);
  });

  afterAll(() => t?.close());

  it("new OTP sign-up gets a `member` UserRole row, with an audit row", async () => {
    const s = await t.login();
    expect(s.isNew).toBe(true);
    const rows = await prisma.userRole.findMany({ where: { userId: s.userId }, include: { role: true } });
    expect(rows.map((r) => r.role.key)).toEqual(["member"]);
    expect(rows[0].orgId).toBeNull();
    const audit = await prisma.auditLog.findMany({ where: { action: "role.grant_system", targetId: rows[0].id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBeNull();
  });

  it("custom role content_reviewer: create, grant, user can call a media.manage_any route; revoke removes it at once", async () => {
    const key = roleKey("content_reviewer");
    const created = await createRole(admin, { key, name: "Content reviewer", scope: "PLATFORM", permissionKeys: ["user.view", "media.manage_any"] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key, name: "Content reviewer", scope: "PLATFORM", isSystem: false });
    expect([...created.body.permissionKeys].sort()).toEqual(["media.manage_any", "user.view"]);

    const user = await t.login();
    expect((await mediaRoute(user)).status).toBe(403); // caches the empty permission set

    const granted = await grant(admin, user.userId, { roleKey: key });
    expect(granted.status).toBe(201);
    expect(granted.body).toMatchObject({ userId: user.userId, roleKey: key, orgId: null });
    expect((await mediaRoute(user)).status).toBe(200); // cache was invalidated before the grant returned

    const revoked = await revoke(admin, user.userId, granted.body.id);
    expect(revoked.status).toBe(204);
    expect((await mediaRoute(user)).status).toBe(403);
  });

  it("removing a permission from a role takes effect for holders immediately (cache invalidated)", async () => {
    const key = roleKey("reviewer2");
    const role = (await createRole(admin, { key, name: "R2", scope: "PLATFORM", permissionKeys: ["media.manage_any"] })).body;
    const user = await t.login();
    expect((await grant(admin, user.userId, { roleKey: key })).status).toBe(201);
    expect((await mediaRoute(user)).status).toBe(200);

    const patched = await http().patch(`/v1/admin/roles/${role.id}`).set(auth(admin)).send({ permissionKeys: ["user.view"] });
    expect(patched.status).toBe(200);
    expect(patched.body.permissionKeys).toEqual(["user.view"]);
    expect((await mediaRoute(user)).status).toBe(403);
  });

  it("support user cannot grant super_admin (ROLE_ESCALATION_DENIED) but can grant a role within their own permissions", async () => {
    const granterKey = roleKey("granter");
    expect((await createRole(admin, { key: granterKey, name: "Granter", scope: "PLATFORM", permissionKeys: ["role.grant"] })).status).toBe(201);
    const support = await t.login();
    expect((await grant(admin, support.userId, { roleKey: "support" })).status).toBe(201);
    expect((await grant(admin, support.userId, { roleKey: granterKey })).status).toBe(201);
    await stepUp(support);

    const target = await t.login();
    const denied = await grant(support, target.userId, { roleKey: "super_admin" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("ROLE_ESCALATION_DENIED");
    expect(await prisma.userRole.count({ where: { userId: target.userId, role: { key: "super_admin" } } })).toBe(0);

    const ok = await grant(support, target.userId, { roleKey: "moderator" });
    expect(ok.status).toBe(403); // moderator has media.manage_any, which support does not hold
    expect(ok.body.error.code).toBe("ROLE_ESCALATION_DENIED");

    const inside = await createRole(admin, { key: roleKey("viewer"), name: "Viewer", scope: "PLATFORM", permissionKeys: ["user.view"] });
    const granted = await grant(support, target.userId, { roleKey: inside.body.key });
    expect(granted.status).toBe(201);

    // revoking a role the actor does not fully hold is escalation too
    const modGrant = await grant(admin, target.userId, { roleKey: "moderator" });
    const revokeDenied = await revoke(support, target.userId, modGrant.body.id);
    expect(revokeDenied.status).toBe(403);
    expect(revokeDenied.body.error.code).toBe("ROLE_ESCALATION_DENIED");
  });

  it("an actor cannot create or extend a role with permissions they do not hold", async () => {
    const support = await t.login();
    const key = roleKey("mgr");
    expect((await createRole(admin, { key, name: "Mgr", scope: "PLATFORM", permissionKeys: ["rbac.manage", "user.view"] })).status).toBe(201);
    expect((await grant(admin, support.userId, { roleKey: key })).status).toBe(201);
    const denied = await createRole(support, { key: roleKey("evil"), name: "Evil", scope: "PLATFORM", permissionKeys: ["settings.manage"] });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("ROLE_ESCALATION_DENIED");
  });

  it("rejects unknown permission keys, system role deletion, duplicate keys and scope mismatches", async () => {
    const unknown = await createRole(admin, { key: roleKey("bad"), name: "Bad", scope: "PLATFORM", permissionKeys: ["nope.nothing"] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("PERMISSION_UNKNOWN");
    expect(unknown.body.error.details.keys).toEqual(["nope.nothing"]);

    const support = await prisma.role.findUniqueOrThrow({ where: { key: "support" } });
    const del = await http().delete(`/v1/admin/roles/${support.id}`).set(auth(admin));
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("ROLE_SYSTEM_PROTECTED");

    const key = roleKey("dupe");
    expect((await createRole(admin, { key, name: "D", scope: "PLATFORM", permissionKeys: [] })).status).toBe(201);
    expect((await createRole(admin, { key, name: "D", scope: "PLATFORM", permissionKeys: [] })).status).toBe(409);

    const other = await t.login();
    const orgRoleNoOrg = await grant(admin, other.userId, { roleKey: "org_owner" });
    expect(orgRoleNoOrg.status).toBe(400);
    const platformRoleWithOrg = await grant(admin, other.userId, { roleKey: "support", orgId: "org-1" });
    expect(platformRoleWithOrg.status).toBe(400);
    const orgGrant = await grant(admin, other.userId, { roleKey: "org_owner", orgId: `org-${uid()}` });
    expect(orgGrant.status).toBe(201);
    const again = await grant(admin, other.userId, { roleKey: "support" });
    expect(again.status).toBe(201);
    expect((await grant(admin, other.userId, { roleKey: "support" })).status).toBe(409);
  });

  it("role grant and revoke require a step-up", async () => {
    const granter = await t.login();
    const key = roleKey("granter2");
    await createRole(admin, { key, name: "G", scope: "PLATFORM", permissionKeys: ["role.grant"] });
    await grant(admin, granter.userId, { roleKey: key });
    const target = await t.login();
    const res = await grant(granter, target.userId, { roleKey: key });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("STEP_UP_REQUIRED");
  });

  it("revoking the last active super_admin is LAST_SUPER_ADMIN; an expired grant does not count as active", async () => {
    const other = await t.login();
    await onlySuperAdmins([admin.userId, other.userId]);
    const otherGrant = await prisma.userRole.findFirstOrThrow({ where: { userId: other.userId, role: { key: "super_admin" } } });
    const adminGrant = await prisma.userRole.findFirstOrThrow({ where: { userId: admin.userId, role: { key: "super_admin" } } });

    expect((await revoke(admin, other.userId, otherGrant.id)).status).toBe(204); // two active -> one left
    const last = await revoke(admin, admin.userId, adminGrant.id);
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe("LAST_SUPER_ADMIN");
    expect(await prisma.userRole.count({ where: { id: adminGrant.id } })).toBe(1);

    // an expired super_admin grant is not an active one: with only an expired second grant the admin is still the last
    const sa = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
    await prisma.userRole.create({ data: { userId: other.userId, roleId: sa.id, expiresAt: new Date(Date.now() - 60_000) } });
    const stillLast = await revoke(admin, admin.userId, adminGrant.id);
    expect(stillLast.body.error.code).toBe("LAST_SUPER_ADMIN");
  });

  it("a suspended super_admin does not count as active for LAST_SUPER_ADMIN", async () => {
    const other = await t.login();
    await onlySuperAdmins([admin.userId, other.userId]);
    const adminGrant = await prisma.userRole.findFirstOrThrow({ where: { userId: admin.userId, role: { key: "super_admin" } } });
    await prisma.user.update({ where: { id: other.userId }, data: { status: "SUSPENDED" } });
    try {
      const res = await revoke(admin, admin.userId, adminGrant.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("LAST_SUPER_ADMIN");
    } finally {
      await prisma.user.update({ where: { id: other.userId }, data: { status: "ACTIVE" } });
      await onlySuperAdmins([admin.userId]);
    }
  });

  it("if cache invalidation fails after commit the request still succeeds, and the outbox backstop invalidates", async () => {
    const key = roleKey("backstop");
    const role = (await createRole(admin, { key, name: "B", scope: "PLATFORM", permissionKeys: ["media.manage_any"] })).body;
    const user = await t.login();
    expect((await grant(admin, user.userId, { roleKey: key })).status).toBe(201);
    expect((await mediaRoute(user)).status).toBe(200); // cached

    const redis = t.app.get<Redis>(REDIS);
    const incr = jest.spyOn(redis, "incr").mockRejectedValue(new Error("redis down"));
    let patched;
    try {
      patched = await http().patch(`/v1/admin/roles/${role.id}`).set(auth(admin)).send({ permissionKeys: ["user.view"] });
    } finally {
      incr.mockRestore();
    }
    expect(patched.status).toBe(200);
    expect((await mediaRoute(user)).status).toBe(200); // stale: the direct invalidation failed

    const events = (await prisma.outboxEvent.findMany({ where: { type: "rbac.permissions_changed" } })).filter((e) =>
      ((e.payload as { userIds: string[] }).userIds ?? []).includes(user.userId),
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) await t.app.get(EventBus).dispatch({ type: e.type, ...(e.payload as object) } as DomainEvent);
    expect((await mediaRoute(user)).status).toBe(403);
  });

  it("two concurrent revokes of the two remaining super_admins: exactly one succeeds", async () => {
    const other = await t.login();
    await stepUp(other);
    await onlySuperAdmins([admin.userId, other.userId]);
    const otherGrant = await prisma.userRole.findFirstOrThrow({ where: { userId: other.userId, role: { key: "super_admin" } } });
    const adminGrant = await prisma.userRole.findFirstOrThrow({ where: { userId: admin.userId, role: { key: "super_admin" } } });

    // Warm both actors' permission caches so the two requests reach the transaction at the same moment.
    await Promise.all([admin, other].map((x) => http().get("/v1/admin/roles").set(auth(x))));
    const [a, b] = await Promise.all([revoke(admin, other.userId, otherGrant.id), revoke(other, admin.userId, adminGrant.id)]);
    // Exactly one wins. The loser is refused either by the lock (LAST_SUPER_ADMIN) or, if the winner already committed before the
    // loser's escalation check, because the loser has just lost super_admin itself (ROLE_ESCALATION_DENIED). Never two 204s.
    expect([a.status, b.status].filter((x) => x === 204)).toHaveLength(1);
    const failed = a.status === 204 ? b : a;
    expect(["LAST_SUPER_ADMIN", "ROLE_ESCALATION_DENIED"]).toContain(failed.body.error.code);
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
    expect(await prisma.userRole.count({ where: { roleId: role.id, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } })).toBe(1);

    // restore the seeded admin for the remaining tests
    await onlySuperAdmins([admin.userId]);
  });

  it("every mutation writes exactly one audit row with before/after, in the same transaction", async () => {
    const key = roleKey("audited");
    const created = await createRole(admin, { key, name: "Audited", scope: "PLATFORM", permissionKeys: ["user.view"] });
    const roleId = created.body.id as string;
    let rows = await auditRows("role", roleId);
    expect(rows.map((r) => r.action)).toEqual(["role.create"]);
    expect(rows[0]).toMatchObject({ actorId: admin.userId, before: null });
    expect(rows[0].after).toMatchObject({ key, name: "Audited", permissionKeys: ["user.view"] });
    expect(rows[0].requestId).toEqual(expect.any(String));
    expect(rows[0].ip).toEqual(expect.any(String));

    await http().patch(`/v1/admin/roles/${roleId}`).set(auth(admin)).send({ name: "Audited 2", permissionKeys: ["user.view", "audit.view"] });
    rows = await auditRows("role", roleId);
    expect(rows.map((r) => r.action)).toEqual(["role.create", "role.update"]);
    expect(rows[1].before).toMatchObject({ name: "Audited", permissionKeys: ["user.view"] });
    expect(rows[1].after).toMatchObject({ name: "Audited 2" });
    expect((rows[1].after as { permissionKeys: string[] }).permissionKeys.sort()).toEqual(["audit.view", "user.view"]);

    const user = await t.login();
    const granted = await grant(admin, user.userId, { roleKey: key });
    const userRoleId = granted.body.id as string;
    rows = await auditRows("user_role", userRoleId);
    expect(rows.map((r) => r.action)).toEqual(["role.grant"]);
    expect(rows[0]).toMatchObject({ actorId: admin.userId, before: null });
    expect(rows[0].after).toMatchObject({ userId: user.userId, roleKey: key, orgId: null });

    await revoke(admin, user.userId, userRoleId);
    rows = await auditRows("user_role", userRoleId);
    expect(rows.map((r) => r.action)).toEqual(["role.grant", "role.revoke"]);
    expect(rows[1].before).toMatchObject({ userId: user.userId, roleKey: key });
    expect(rows[1].after).toBeNull();

    const del = await http().delete(`/v1/admin/roles/${roleId}`).set(auth(admin));
    expect(del.status).toBe(204);
    rows = await auditRows("role", roleId);
    expect(rows.map((r) => r.action)).toEqual(["role.create", "role.update", "role.delete"]);
    expect(rows[2].before).toMatchObject({ key });
    expect(rows[2].after).toBeNull();
  });

  it("a failed mutation leaves no audit row", async () => {
    const key = roleKey("failaudit");
    const before = await prisma.auditLog.count();
    const res = await createRole(admin, { key, name: "x", scope: "PLATFORM", permissionKeys: ["nope.nope"] });
    expect(res.status).toBe(400);
    expect(await prisma.auditLog.count()).toBe(before);
  });

  it("emits role.granted through the outbox on grant", async () => {
    const user = await t.login();
    const res = await grant(admin, user.userId, { roleKey: "moderator" });
    expect(res.status).toBe(201);
    const events = await prisma.outboxEvent.findMany({ where: { type: "role.granted" } });
    expect(events.some((e) => JSON.stringify(e.payload).includes(user.userId))).toBe(true);
  });

  it("GET /v1/admin/roles and /permissions need rbac.view; /audit needs audit.view and filters + paginates", async () => {
    const plain = await t.login();
    expect((await http().get("/v1/admin/roles").set(auth(plain))).status).toBe(403);
    expect((await http().get("/v1/admin/permissions").set(auth(plain))).status).toBe(403);
    expect((await http().get("/v1/admin/audit").set(auth(plain))).status).toBe(403);

    const roles = await http().get("/v1/admin/roles").set(auth(admin));
    expect(roles.status).toBe(200);
    expect(roles.body.items.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(["member", "super_admin", "support"]));
    const perms = await http().get("/v1/admin/permissions").set(auth(admin));
    expect(perms.body.items.map((p: { key: string }) => p.key)).toEqual(expect.arrayContaining(["role.grant", "audit.view"]));

    const target = await t.login();
    for (const r of ["moderator", "support", "finance_admin"]) await grant(admin, target.userId, { roleKey: r });
    const page1 = await http().get("/v1/admin/audit").query({ actorId: admin.userId, limit: 2 }).set(auth(admin));
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await http().get("/v1/admin/audit").query({ actorId: admin.userId, limit: 2, cursor: page1.body.nextCursor }).set(auth(admin));
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
    expect(page2.body.items[0].createdAt <= page1.body.items[1].createdAt).toBe(true);

    const filtered = await http().get("/v1/admin/audit").query({ targetType: "user_role" }).set(auth(admin));
    expect(filtered.body.items.every((i: { targetType: string }) => i.targetType === "user_role")).toBe(true);
    expect(filtered.body.items[0]).toEqual(expect.objectContaining({ action: expect.any(String), targetId: expect.any(String), createdAt: expect.any(String) }));

    // By action (exact), and by IST day range (inclusive), alone or together with the other filters.
    const action: string = filtered.body.items[0].action;
    const byAction = await http().get("/v1/admin/audit").query({ action }).set(auth(admin));
    expect(byAction.status).toBe(200);
    expect(byAction.body.items.length).toBeGreaterThan(0);
    expect(byAction.body.items.every((i: { action: string }) => i.action === action)).toBe(true);
    expect((await http().get("/v1/admin/audit").query({ action: "no.such.action" }).set(auth(admin))).body.items).toEqual([]);

    const today = istDateOf(new Date());
    const window = (q: Record<string, string>) => http().get("/v1/admin/audit").query({ actorId: admin.userId, limit: 100, ...q }).set(auth(admin));
    const within = await window({ from: addDays(today, -1), to: addDays(today, 1) });
    expect(within.status).toBe(200);
    expect(within.body.items.length).toBeGreaterThanOrEqual(3);
    expect((await window({ from: addDays(today, 1) })).body.items).toEqual([]); // nothing after today
    expect((await window({ to: addDays(today, -1) })).body.items).toEqual([]); // nothing before today
    const both = await window({ action, from: today, to: addDays(today, 1) });
    expect(both.body.items.every((i: { action: string }) => i.action === action)).toBe(true);
    for (const bad of [{ from: "yesterday" }, { to: "2026-02-30" }, { from: "2026-01-02", to: "2026-01-01" }] as Record<string, string>[]) expect([bad, (await window(bad)).status]).toEqual([bad, 400]);
  });

  it("unauthenticated admin routes are 401", async () => {
    expect((await http().post("/v1/admin/roles").send({})).status).toBe(401);
    expect((await http().get("/v1/admin/audit")).status).toBe(401);
  });

});
