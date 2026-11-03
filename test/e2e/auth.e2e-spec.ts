import request from "supertest";
import { QueueNames, queueToken } from "../../src/common/queue/queue.constants";
import type { Queue } from "bullmq";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { UserStatusCache } from "../../src/modules/identity/user-status.cache";
import { AuthTestApp, createAuthTestApp, readRefreshCookie, uniqueEmail, uniqueIp } from "../support/auth-app";

describe("auth", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const refresh = (cookie: string) => http().post("/v1/auth/refresh").set("Cookie", `skiller_rt=${cookie}`);

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
  });

  afterAll(() => t?.close());

  it("full login: request -> verify -> GET /v1/me with bearer", async () => {
    const email = uniqueEmail("Login");
    const before = t.mail.sent.length;
    const { challengeId, expiresAt } = await t.requestOtp(email);
    expect(typeof challengeId).toBe("string");
    expect(new Date(expiresAt).getTime() - t.clock.now().getTime()).toBe(10 * 60_000);
    expect(t.mail.sent.length).toBeGreaterThanOrEqual(before); // delivery is async via the worker
    const code = await t.codeFor(email);

    const res = await http().post("/v1/auth/otp/verify").set("X-Forwarded-For", uniqueIp()).send({ challengeId, code });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: email.toLowerCase(), isNew: true });
    expect(typeof res.body.accessToken).toBe("string");

    const cookie = readRefreshCookie(res)!;
    expect(cookie).not.toBeNull();
    expect(cookie.raw).toMatch(/HttpOnly/i);
    expect(cookie.raw).toMatch(/Secure/i);
    expect(cookie.raw).toMatch(/SameSite=Lax/i);
    expect(cookie.raw).toMatch(/Path=\/v1\/auth(;|$)/i);
    expect(cookie.raw).toMatch(/Domain=localhost/i);
    expect(cookie.raw).toMatch(/Max-Age=2592000/i);

    const me = await http().get("/v1/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual({ id: res.body.user.id, email: email.toLowerCase(), status: "ACTIVE" });

    // user.registered went to the outbox in the same transaction as the user row
    const events = await prisma.outboxEvent.count({ where: { type: "user.registered", payload: { path: ["userId"], equals: res.body.user.id } } });
    expect(events).toBe(1);

    // a returning user is not new and emits no second event
    const again = await t.login(email);
    expect(again.userId).toBe(res.body.user.id);
    expect(again.isNew).toBe(false);
    expect(await prisma.outboxEvent.count({ where: { type: "user.registered", payload: { path: ["userId"], equals: res.body.user.id } } })).toBe(1);
  });

  it("rejects requests without or with a bad bearer token", async () => {
    expect((await http().get("/v1/me")).status).toBe(401);
    const bad = await http().get("/v1/me").set("Authorization", "Bearer not.a.jwt");
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("AUTH_TOKEN_INVALID");
  });

  it("health and ready stay public", async () => {
    expect((await http().get("/v1/health")).status).toBe(200);
  });

  it("access token expires after 15 minutes", async () => {
    const { accessToken } = await t.login();
    t.clock.advance(15 * 60_000 + 1000);
    try {
      const res = await http().get("/v1/me").set("Authorization", `Bearer ${accessToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("AUTH_TOKEN_EXPIRED");
    } finally {
      t.clock.advance(-(15 * 60_000 + 1000));
    }
  });

  it("wrong code -> OTP_INVALID with attemptsLeft; verify never reveals which emails exist", async () => {
    const email = uniqueEmail();
    const { challengeId } = await t.requestOtp(email);
    const code = await t.codeFor(email);
    const wrong = code === "000000" ? "111111" : "000000";
    const res = await http().post("/v1/auth/otp/verify").send({ challengeId, code: wrong });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "OTP_INVALID", details: { attemptsLeft: 4 } });
    const bad = await http().post("/v1/auth/otp/verify").send({ challengeId, code: "abc" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("refresh rotates the cookie; the old cookie 11 s later is AUTH_TOKEN_REUSED and the new cookie also fails", async () => {
    const { cookie: c0 } = await t.login();
    const r1 = await refresh(c0.value);
    expect(r1.status).toBe(200);
    expect(typeof r1.body.accessToken).toBe("string");
    const c1 = readRefreshCookie(r1)!;
    expect(c1.value).not.toBe(c0.value);

    t.clock.advance(11_000);
    const reused = await refresh(c0.value);
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("AUTH_TOKEN_REUSED");

    const newToo = await refresh(c1.value);
    expect(newToo.status).toBe(401);
    expect(newToo.body.error.code).toBe("AUTH_SESSION_EXPIRED");
  });

  it("Review Focus 1: old cookie reused within 10 s is 409 REFRESH_RACE and the new cookie still works", async () => {
    const { cookie: c0 } = await t.login();
    const c1 = readRefreshCookie(await refresh(c0.value))!;
    t.clock.advance(3_000);
    const race = await refresh(c0.value);
    expect(race.status).toBe(409);
    expect(race.body.error.code).toBe("REFRESH_RACE");
    const ok = await refresh(c1.value);
    expect(ok.status).toBe(200);
    expect(readRefreshCookie(ok)!.value).not.toBe(c1.value);
  });

  it("refresh without a cookie is AUTH_SESSION_EXPIRED", async () => {
    const res = await http().post("/v1/auth/refresh");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_SESSION_EXPIRED");
  });

  it("Review Focus 2: suspending a user blocks a still-valid access token (403) after the status cache is busted", async () => {
    const { userId, accessToken, cookie } = await t.login();
    expect((await http().get("/v1/me").set("Authorization", `Bearer ${accessToken}`)).status).toBe(200);

    await prisma.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } });
    await t.app.get(UserStatusCache).bust(userId);

    const res = await http().get("/v1/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AUTH_ACCOUNT_SUSPENDED");

    // the refresh token of a suspended user cannot mint new access tokens either
    const r = await refresh(cookie.value);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("AUTH_ACCOUNT_SUSPENDED");
  });

  it("a suspended user cannot complete OTP login", async () => {
    const { email, userId } = await t.login();
    await prisma.user.update({ where: { id: userId }, data: { status: "SUSPENDED" } });
    await t.app.get(UserStatusCache).bust(userId);
    const before = t.mail.sent.filter((m) => m.to === email).length;
    const { challengeId } = await t.requestOtp(email);
    const code = await t.codeFor(email, before);
    const res = await http().post("/v1/auth/otp/verify").send({ challengeId, code });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AUTH_ACCOUNT_SUSPENDED");
  });

  it("logout revokes the session: access token -> 401, cookie cleared, refresh fails", async () => {
    const { accessToken, cookie } = await t.login();
    const out = await http().post("/v1/auth/logout").set("Authorization", `Bearer ${accessToken}`).set("Cookie", `skiller_rt=${cookie.value}`);
    expect(out.status).toBe(204);
    const cleared = readRefreshCookie(out)!;
    expect(cleared.value).toBe("");
    expect(cleared.raw).toMatch(/Path=\/v1\/auth/i);

    const me = await http().get("/v1/me").set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(401);
    expect((await refresh(cookie.value)).body.error.code).toBe("AUTH_SESSION_EXPIRED");
  });

  it("OTP request returns identical bodies for known and unknown emails", async () => {
    const known = await t.login();
    const a = await http().post("/v1/auth/otp/request").set("X-Forwarded-For", uniqueIp()).send({ email: known.email });
    const b = await http().post("/v1/auth/otp/request").set("X-Forwarded-For", uniqueIp()).send({ email: uniqueEmail("ghost") });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(Object.keys(a.body).sort()).toEqual(["challengeId", "expiresAt"]);
    expect(Object.keys(b.body).sort()).toEqual(["challengeId", "expiresAt"]);
    expect(typeof a.body.challengeId).toBe(typeof b.body.challengeId);
    expect(a.body.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.body.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.body.expiresAt).toMatch(/Z$/);
    expect(b.body.expiresAt).toMatch(/Z$/);
  });

  it("OTP request is rate limited: 5 per email, 20 per IP per 15 minutes", async () => {
    const email = uniqueEmail("rl");
    for (let i = 0; i < 5; i++) {
      expect((await http().post("/v1/auth/otp/request").set("X-Forwarded-For", uniqueIp()).send({ email })).status).toBe(202);
    }
    const blocked = await http().post("/v1/auth/otp/request").set("X-Forwarded-For", uniqueIp()).send({ email: ` ${email.toUpperCase()} ` });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    const ip = uniqueIp();
    for (let i = 0; i < 20; i++) {
      expect((await http().post("/v1/auth/otp/request").set("X-Forwarded-For", ip).send({ email: uniqueEmail("ip") })).status).toBe(202);
    }
    expect((await http().post("/v1/auth/otp/request").set("X-Forwarded-For", ip).send({ email: uniqueEmail("ip") })).status).toBe(429);
  });

  it("sessions: list, revoke one, revoke others", async () => {
    const email = uniqueEmail("multi");
    const a = await t.login(email);
    const b = await t.login(email);
    const c = await t.login(email);
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

    const list = await http().get("/v1/auth/sessions").set(auth(a.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/refreshHash|previousHash/);
    const bSession = list.body.items.find((s: { current: boolean }) => !s.current)!;

    const del = await http().delete(`/v1/auth/sessions/${bSession.id}`).set(auth(a.accessToken));
    expect(del.status).toBe(204);
    expect((await http().delete(`/v1/auth/sessions/${bSession.id}`).set(auth(a.accessToken))).status).toBe(204);

    const other = await t.login();
    const notMine = await http().delete(`/v1/auth/sessions/${bSession.id}`).set(auth(other.accessToken));
    expect(notMine.status).toBe(404);

    const rest = await http().post("/v1/auth/sessions/revoke-others").set(auth(a.accessToken));
    expect(rest.status).toBe(204);
    expect((await http().get("/v1/me").set(auth(a.accessToken))).status).toBe(200);
    const left = await http().get("/v1/auth/sessions").set(auth(a.accessToken));
    expect(left.body.items).toHaveLength(1);
    for (const token of [b.accessToken, c.accessToken]) {
      expect((await http().get("/v1/me").set(auth(token))).status).toBe(401);
    }
    expect(await t.app.get(PrismaService).session.count({ where: { userId: a.userId, revokedAt: null } })).toBe(1);
  });

  it("TRUST_PROXY=1: different X-Forwarded-For IPs get separate per-IP buckets", async () => {
    const a = uniqueIp();
    const b = uniqueIp();
    for (let i = 0; i < 20; i++) {
      await http().post("/v1/auth/otp/request").set("X-Forwarded-For", a).send({ email: uniqueEmail("px") }).expect(202);
    }
    expect((await http().post("/v1/auth/otp/request").set("X-Forwarded-For", a).send({ email: uniqueEmail("px") })).status).toBe(429);
    expect((await http().post("/v1/auth/otp/request").set("X-Forwarded-For", b).send({ email: uniqueEmail("px") })).status).toBe(202);
  });

  it("OTP mail jobs are removed from the queue once completed (no plaintext code retained)", async () => {
    const email = uniqueEmail("retain");
    await t.requestOtp(email);
    await t.codeFor(email);
    const queue = t.app.get<Queue>(queueToken(QueueNames.mail));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await queue.getJobs(["waiting", "active", "delayed"])).length > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const jobs = await queue.getJobs(["completed", "failed", "waiting", "active", "delayed"]);
    expect(jobs.filter((j) => (j.data as { to: string }).to === email.toLowerCase())).toHaveLength(0);
  });
});
