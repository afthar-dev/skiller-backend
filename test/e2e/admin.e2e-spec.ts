import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { REDIS } from "../../src/common/redis/redis.constants";
import { FlagsService, flagBucket } from "../../src/modules/admin/flags.service";
import { SettingsService } from "../../src/modules/admin/settings.service";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uid = () => randomUUID().replace(/-/g, "").slice(0, 10);

describe("admin shell", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let admin: Session;
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

  /** A signed-in user holding a custom platform role with the given permissions (and a fresh step-up). */
  async function staffWith(permissionKeys: string[], withStepUp = true) {
    const key = `staff_${uid()}`;
    expect((await http().post("/v1/admin/roles").set(auth(admin)).send({ key, name: key, scope: "PLATFORM", permissionKeys })).status).toBe(201);
    const s = await t.login();
    expect((await http().post(`/v1/admin/users/${s.userId}/roles`).set(auth(admin)).send({ roleKey: key })).status).toBe(201);
    if (withStepUp) await stepUp(s);
    return s;
  }

  const audit = (action: string, targetId: string) => prisma.auditLog.findMany({ where: { action, targetId } });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    admin = await t.login("admin@skiller.test");
    await stepUp(admin);
  });
  afterAll(() => t?.close());

  describe("suspend", () => {
    it("suspending blocks the user's existing access token at once (403), revokes sessions and audits", async () => {
      const victim = await t.login();
      expect((await http().get("/v1/me").set(auth(victim))).status).toBe(200);

      const res = await http().post(`/v1/admin/users/${victim.userId}/suspend`).set(auth(admin)).send({ reason: "spam" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: victim.userId, status: "SUSPENDED" });

      expect((await http().get("/v1/me").set(auth(victim))).status).toBe(403);
      const sessions = await prisma.session.findMany({ where: { userId: victim.userId } });
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
      const rows = await audit("user.suspend", victim.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: admin.userId, targetType: "user", after: { status: "SUSPENDED", reason: "spam" } });

      const un = await http().post(`/v1/admin/users/${victim.userId}/unsuspend`).set(auth(admin));
      expect(un.status).toBe(200);
      expect(await audit("user.unsuspend", victim.userId)).toHaveLength(1);
      const again = await t.login(victim.email); // can sign in again
      expect((await http().get("/v1/me").set(auth(again))).status).toBe(200);
    });

    it("is idempotent: repeating does not add audit rows", async () => {
      const victim = await t.login();
      await http().post(`/v1/admin/users/${victim.userId}/suspend`).set(auth(admin)).send({ reason: "x" });
      const again = await http().post(`/v1/admin/users/${victim.userId}/suspend`).set(auth(admin)).send({ reason: "x" });
      expect(again.status).toBe(200);
      expect(await audit("user.suspend", victim.userId)).toHaveLength(1);
    });

    it("needs user.suspend and a step-up; reason is required", async () => {
      const victim = await t.login();
      const viewer = await staffWith(["user.view"]);
      expect((await http().post(`/v1/admin/users/${victim.userId}/suspend`).set(auth(viewer)).send({ reason: "r" })).status).toBe(403);

      const suspender = await staffWith(["user.suspend", "user.view"]);
      const noStep = await staffWith(["user.suspend", "user.view"], false);
      const res = await http().post(`/v1/admin/users/${victim.userId}/suspend`).set(auth(noStep)).send({ reason: "r" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("STEP_UP_REQUIRED");

      const bad = await http().post(`/v1/admin/users/${victim.userId}/suspend`).set(auth(suspender)).send({});
      expect(bad.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("a non-super_admin cannot suspend a super_admin (ROLE_ESCALATION_DENIED); nobody can suspend themselves (ADMIN_SELF_ACTION)", async () => {
      const moderator = await staffWith(["user.suspend", "user.view"]);
      const res = await http().post(`/v1/admin/users/${admin.userId}/suspend`).set(auth(moderator)).send({ reason: "coup" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ROLE_ESCALATION_DENIED");
      expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } })).status).toBe("ACTIVE");

      const self = await http().post(`/v1/admin/users/${moderator.userId}/suspend`).set(auth(moderator)).send({ reason: "me" });
      expect(self.status).toBe(403);
      expect(self.body.error.code).toBe("ADMIN_SELF_ACTION");
      expect((await http().post(`/v1/admin/users/${randomUUID()}/suspend`).set(auth(admin)).send({ reason: "r" })).status).toBe(404);
    });

    it("Redis outage while revoking: 503, the suspension stays committed and the user is still blocked; a retry completes it", async () => {
      const victim = await t.login();
      const redis = t.app.get<Redis>(REDIS);
      const set = jest.spyOn(redis, "set").mockRejectedValue(new Error("redis down"));
      let res;
      try {
        res = await http().post(`/v1/admin/users/${victim.userId}/suspend`).set(auth(admin)).send({ reason: "x" });
      } finally {
        set.mockRestore();
      }
      expect(res.status).toBe(503);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.userId } })).status).toBe("SUSPENDED");
      expect((await http().get("/v1/me").set(auth(victim))).status).toBe(403); // status cache was busted
      const retry = await http().post(`/v1/admin/users/${victim.userId}/suspend`).set(auth(admin)).send({ reason: "x" });
      expect(retry.status).toBe(200);
      expect((await prisma.session.findMany({ where: { userId: victim.userId } })).every((s) => s.revokedAt)).toBe(true);
      expect(await audit("user.suspend", victim.userId)).toHaveLength(1);
    });
  });

  describe("users", () => {
    it("searches by email prefix and handle prefix with pagination, status and role filters", async () => {
      const tag = uid();
      const a = await t.login(`zz${tag}-a@example.com`);
      const b = await t.login(`zz${tag}-b@example.com`);
      await http().get("/v1/me").set(auth(a)); // creates profiles lazily
      await http().get("/v1/me").set(auth(b));
      const handle = (await prisma.profile.findUniqueOrThrow({ where: { userId: a.userId } })).handle;

      const byEmail = await http().get(`/v1/admin/users?q=ZZ${tag}`).set(auth(admin));
      expect(byEmail.status).toBe(200);
      expect(byEmail.body.items.map((i: { id: string }) => i.id).sort()).toEqual([a.userId, b.userId].sort());
      expect(byEmail.body.items[0]).toEqual(expect.objectContaining({ email: expect.any(String), status: "ACTIVE", roles: ["member"] }));

      const byHandle = await http().get(`/v1/admin/users?q=${handle}`).set(auth(admin));
      expect(byHandle.body.items.map((i: { id: string }) => i.id)).toContain(a.userId);

      const p1 = await http().get(`/v1/admin/users?q=zz${tag}&limit=1`).set(auth(admin));
      expect(p1.body.items).toHaveLength(1);
      expect(p1.body.nextCursor).toEqual(expect.any(String));
      const p2 = await http().get(`/v1/admin/users?q=zz${tag}&limit=1&cursor=${p1.body.nextCursor}`).set(auth(admin));
      expect(p2.body.items).toHaveLength(1);
      expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);

      await http().post(`/v1/admin/users/${b.userId}/suspend`).set(auth(admin)).send({ reason: "r" });
      const suspended = await http().get(`/v1/admin/users?q=zz${tag}&status=SUSPENDED`).set(auth(admin));
      expect(suspended.body.items.map((i: { id: string }) => i.id)).toEqual([b.userId]);

      const supers = await http().get(`/v1/admin/users?role=super_admin`).set(auth(admin));
      expect(supers.body.items.map((i: { id: string }) => i.id)).toContain(admin.userId);
      const none = await http().get(`/v1/admin/users?q=zz${tag}&role=super_admin`).set(auth(admin));
      expect(none.body.items).toHaveLength(0);
    });

    it("search uses the prefix indexes (no seq scan on users/profiles)", async () => {
      await prisma.$executeRawUnsafe("SET enable_seqscan = off");
      const plan = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN SELECT id FROM users WHERE email LIKE 'abc%' ORDER BY id DESC LIMIT 5`);
      const handlePlan = await prisma.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN SELECT "userId" FROM profiles WHERE handle LIKE 'abc%' LIMIT 5`);
      await prisma.$executeRawUnsafe("RESET enable_seqscan");
      expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/users_email_pattern_idx|users_pkey|users_email_key/);
      expect(handlePlan.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/profiles_handle_pattern_idx|profiles_handle_key/);
    });

    it("rejects a one-character query and requires user.view", async () => {
      expect((await http().get("/v1/admin/users?q=a").set(auth(admin))).body.error.code).toBe("VALIDATION_FAILED");
      const plain = await t.login();
      expect((await http().get("/v1/admin/users").set(auth(plain))).status).toBe(403);
    });

    it("user detail returns profile, roles, active session count and recent audit; revoke-sessions kills sessions with an audit row", async () => {
      const u = await t.login();
      await http().get("/v1/me").set(auth(u));
      await t.login(u.email); // second session
      const detail = await http().get(`/v1/admin/users/${u.userId}`).set(auth(admin));
      expect(detail.status).toBe(200);
      expect(detail.body.user).toMatchObject({ id: u.userId, email: u.email, status: "ACTIVE" });
      expect(detail.body.profile).toMatchObject({ id: u.userId });
      expect(detail.body.roles.map((r: { roleKey: string }) => r.roleKey)).toContain("member");
      expect(detail.body.activeSessions).toBe(2);
      expect(Array.isArray(detail.body.recentAudit)).toBe(true);

      const res = await http().post(`/v1/admin/users/${u.userId}/revoke-sessions`).set(auth(admin));
      expect(res.status).toBe(200);
      expect((await http().get("/v1/me").set(auth(u))).status).toBe(401);
      expect((await http().get(`/v1/admin/users/${u.userId}`).set(auth(admin))).body.activeSessions).toBe(0);
      expect(await audit("user.revoke_sessions", u.userId)).toHaveLength(1);
      expect((await http().get(`/v1/admin/users/${randomUUID()}`).set(auth(admin))).status).toBe(404);
    });
  });

  describe("settings", () => {
    it("defaults, validated write with step-up + audit, cache busted on write", async () => {
      const settings = t.app.get(SettingsService);
      await prisma.platformSetting.deleteMany();
      expect(await settings.get("hold_days")).toBe(7);
      expect(await settings.get("max_upload_mb_course_lesson")).toBe(5120);
      expect(await settings.get("reel_max_seconds")).toBe(90);

      const list = await http().get("/v1/admin/settings").set(auth(admin));
      expect(list.body.items.find((i: { key: string }) => i.key === "hold_days")).toMatchObject({ value: 7, default: 7 });

      const bad = await http().put("/v1/admin/settings").set(auth(admin)).send({ key: "hold_days", value: -1 });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("VALIDATION_FAILED");
      expect((await http().put("/v1/admin/settings").set(auth(admin)).send({ key: "nope", value: 1 })).body.error.code).toBe("VALIDATION_FAILED");
      expect((await http().put("/v1/admin/settings").set(auth(admin)).send({ key: "hold_days", value: "3" })).status).toBe(400);

      const ok = await http().put("/v1/admin/settings").set(auth(admin)).send({ key: "hold_days", value: 14 });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ key: "hold_days", value: 14 });
      expect(await settings.get("hold_days")).toBe(14); // the 60 s cache held 7 and was busted
      const rows = await audit("setting.update", "hold_days");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: admin.userId, after: { value: 14 } });
    });

    it("PUT needs settings.manage and a step-up", async () => {
      const plain = await t.login();
      expect((await http().put("/v1/admin/settings").set(auth(plain)).send({ key: "hold_days", value: 3 })).status).toBe(403);
      const fresh = await staffWith(["settings.manage"], false);
      const res = await http().put("/v1/admin/settings").set(auth(fresh)).send({ key: "hold_days", value: 3 });
      expect(res.body.error.code).toBe("STEP_UP_REQUIRED");
    });
  });

  describe("feature flags", () => {
    it("gig_orders is seeded off", async () => {
      const flags = t.app.get(FlagsService);
      expect(await flags.isEnabled("gig_orders", { userId: admin.userId })).toBe(false);
      expect(await flags.isEnabled("unknown_flag")).toBe(false);
    });

    it("percent 0 is off, allowUserIds wins, percent 100 and no rules are on for all; stable hash buckets", async () => {
      const flags = t.app.get(FlagsService);
      const key = `f_${uid()}`;
      const put = (body: object) => http().put("/v1/admin/flags").set(auth(admin)).send({ key, ...body });
      const user = randomUUID();
      const other = randomUUID();

      expect((await put({ enabled: true, rules: { percent: 0 } })).status).toBe(200);
      expect(await flags.isEnabled(key, { userId: user })).toBe(false);

      await put({ enabled: true, rules: { percent: 0, allowUserIds: [user] } });
      expect(await flags.isEnabled(key, { userId: user })).toBe(true);
      expect(await flags.isEnabled(key, { userId: other })).toBe(false);

      await put({ enabled: true, rules: { percent: 100 } });
      expect(await flags.isEnabled(key, { userId: other })).toBe(true);
      expect(await flags.isEnabled(key)).toBe(true);

      await put({ enabled: true });
      expect(await flags.isEnabled(key, { userId: other })).toBe(true);
      await put({ enabled: false, rules: { percent: 100 } });
      expect(await flags.isEnabled(key, { userId: other })).toBe(false);

      const bucket = flagBucket(key, user);
      expect(bucket).toBe(flagBucket(key, user));
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
      await put({ enabled: true, rules: { percent: bucket } });
      expect(await flags.isEnabled(key, { userId: user })).toBe(false);
      await put({ enabled: true, rules: { percent: bucket + 1 } });
      expect(await flags.isEnabled(key, { userId: user })).toBe(true);

      expect(await audit("flag.update", key)).toHaveLength(7);
      const list = await http().get("/v1/admin/flags").set(auth(admin));
      expect(list.body.items.map((i: { key: string }) => i.key)).toEqual(expect.arrayContaining(["gig_orders", key]));
    });

    it("validates input and requires flags.manage", async () => {
      expect((await http().put("/v1/admin/flags").set(auth(admin)).send({ key: "Bad Key", enabled: true })).body.error.code).toBe("VALIDATION_FAILED");
      expect((await http().put("/v1/admin/flags").set(auth(admin)).send({ key: "ok_flag", enabled: true, rules: { percent: 101 } })).status).toBe(400);
      const plain = await t.login();
      expect((await http().get("/v1/admin/flags").set(auth(plain))).status).toBe(403);
    });
  });

  it("every admin mutation leaves an audit row (suspend, unsuspend, revoke-sessions, setting, flag)", async () => {
    const actions = await prisma.auditLog.groupBy({ by: ["action"], where: { actorId: admin.userId, action: { in: ["user.suspend", "user.unsuspend", "user.revoke_sessions", "setting.update", "flag.update"] } } });
    expect(actions.map((a) => a.action).sort()).toEqual(["flag.update", "setting.update", "user.revoke_sessions", "user.suspend", "user.unsuspend"]);
  });
});
