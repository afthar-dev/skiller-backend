import { Controller, Get } from "@nestjs/common";
import request from "supertest";
import { RequireStepUp } from "../../src/modules/identity/require-step-up.decorator";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";

@Controller("test-step-up")
class ProtectedTestController {
  @Get()
  @RequireStepUp()
  protectedRoute() {
    return { ok: true };
  }
}

describe("step-up verification", () => {
  let t: AuthTestApp;
  const http = () => request(t.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const protectedGet = (token: string) => http().get("/v1/test-step-up").set(auth(token));

  async function stepUp(session: { email: string; accessToken: string }, ip = uniqueIp()) {
    const before = t.mail.sent.filter((m) => m.to === session.email).length;
    const res = await http().post("/v1/auth/step-up/request").set(auth(session.accessToken)).set("X-Forwarded-For", ip);
    expect(res.status).toBe(202);
    expect(Object.keys(res.body)).toEqual(["challengeId"]);
    const code = await t.codeFor(session.email, before);
    return { challengeId: res.body.challengeId as string, code };
  }

  const verifyStepUp = (token: string, body: object) => http().post("/v1/auth/step-up/verify").set(auth(token)).send(body);

  beforeAll(async () => {
    t = await createAuthTestApp({ controllers: [ProtectedTestController] });
  });

  afterAll(() => t?.close());

  it("protected route is STEP_UP_REQUIRED until the step-up is verified, then 200", async () => {
    const me = await t.login();
    const before = await protectedGet(me.accessToken);
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe("STEP_UP_REQUIRED");

    const { challengeId, code } = await stepUp(me);
    const verified = await verifyStepUp(me.accessToken, { challengeId, code });
    expect(verified.status).toBe(204);

    const after = await protectedGet(me.accessToken);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ ok: true });
  });

  it("the step-up code is mailed with the STEP_UP purpose", async () => {
    const me = await t.login();
    await stepUp(me);
    const last = [...t.mail.sent].reverse().find((m) => m.to === me.email)!;
    expect(last.subject).toMatch(/verification code/i);
  });

  it("expires 300 s after verification (still valid at 299 s, required again at 301 s)", async () => {
    const me = await t.login();
    const { challengeId, code } = await stepUp(me);
    await verifyStepUp(me.accessToken, { challengeId, code }).expect(204);

    t.clock.advanceSec(299);
    // the 15 minute access token is still valid, only the step-up window is measured here
    expect((await protectedGet(me.accessToken)).status).toBe(200);
    t.clock.advanceSec(2);
    const res = await protectedGet(me.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("STEP_UP_REQUIRED");
  });

  it("stores stepup:{sessionId} in Redis with a 300 s TTL", async () => {
    const me = await t.login();
    const { challengeId, code } = await stepUp(me);
    await verifyStepUp(me.accessToken, { challengeId, code }).expect(204);
    const { REDIS } = await import("../../src/common/redis/redis.constants");
    const redis = t.app.get<import("ioredis").Redis>(REDIS);
    const sessionId = (await http().get("/v1/auth/sessions").set(auth(me.accessToken))).body.items[0].id;
    const ttl = await redis.ttl(`stepup:${sessionId}`);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("step-up on session A does not unlock session B of the same user", async () => {
    const email = `two-${Date.now()}@example.com`;
    const a = await t.login(email);
    const b = await t.login(email);
    const { challengeId, code } = await stepUp(a);
    await verifyStepUp(a.accessToken, { challengeId, code }).expect(204);
    expect((await protectedGet(a.accessToken)).status).toBe(200);
    const res = await protectedGet(b.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("STEP_UP_REQUIRED");
  });

  it("a STEP_UP challenge cannot be used at /auth/otp/verify (OTP_INVALID) and is not burned by trying", async () => {
    const me = await t.login();
    const { challengeId, code } = await stepUp(me);
    const res = await http().post("/v1/auth/otp/verify").send({ challengeId, code });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("OTP_INVALID");
    expect(res.headers["set-cookie"]).toBeUndefined();
    await verifyStepUp(me.accessToken, { challengeId, code }).expect(204);
  });

  it("a LOGIN challenge cannot be used for step-up", async () => {
    const me = await t.login();
    const before = t.mail.sent.filter((m) => m.to === me.email).length;
    const { challengeId } = await t.requestOtp(me.email);
    const code = await t.codeFor(me.email, before);
    const res = await verifyStepUp(me.accessToken, { challengeId, code });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("OTP_INVALID");
    expect((await protectedGet(me.accessToken)).status).toBe(403);
  });

  it("another user cannot redeem my step-up challenge", async () => {
    const me = await t.login();
    const other = await t.login();
    const { challengeId, code } = await stepUp(me);
    const res = await verifyStepUp(other.accessToken, { challengeId, code });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("OTP_INVALID");
    expect((await protectedGet(other.accessToken)).status).toBe(403);
    await verifyStepUp(me.accessToken, { challengeId, code }).expect(204);
  });

  it("a wrong code is OTP_INVALID and does not unlock", async () => {
    const me = await t.login();
    const { challengeId, code } = await stepUp(me);
    const res = await verifyStepUp(me.accessToken, { challengeId, code: code === "000000" ? "111111" : "000000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "OTP_INVALID", details: { attemptsLeft: 4 } });
    expect((await protectedGet(me.accessToken)).status).toBe(403);
  });

  it("step-up endpoints require authentication", async () => {
    expect((await http().post("/v1/auth/step-up/request")).status).toBe(401);
    expect((await http().post("/v1/auth/step-up/verify").send({})).status).toBe(401);
    expect((await http().get("/v1/test-step-up")).status).toBe(401);
  });
});
