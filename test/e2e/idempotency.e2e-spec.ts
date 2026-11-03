import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { AuthUser } from "../../src/common/auth/auth-user";
import { AuthenticatedOnly } from "../../src/common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../src/common/auth/current-user.decorator";
import { AppError } from "../../src/common/errors/app-error";
import { Idempotent } from "../../src/common/idempotency/idempotent.decorator";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

const state = { calls: 0, gate: null as null | Promise<void>, failOnce: false };

@Controller("test-idem")
class IdempotencyTestController {
  @AuthenticatedOnly()
  @Idempotent()
  @Post("echo")
  @HttpCode(201)
  echo(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    state.calls++;
    return { call: state.calls, user: user.id, body };
  }

  @AuthenticatedOnly()
  @Idempotent()
  @Post("slow")
  @HttpCode(201)
  async slow() {
    state.calls++;
    if (state.gate) await state.gate;
    return { call: state.calls };
  }

  @AuthenticatedOnly()
  @Idempotent()
  @Post("flaky")
  @HttpCode(201)
  flaky() {
    state.calls++;
    if (state.failOnce) {
      state.failOnce = false;
      throw new Error("boom");
    }
    return { call: state.calls };
  }

  @AuthenticatedOnly()
  @Idempotent()
  @Post("reject")
  @HttpCode(201)
  reject() {
    state.calls++;
    throw new AppError("TEST_REJECTED", 422, "nope", { why: "test" });
  }
}

describe("@Idempotent()", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const http = () => request(t.app.getHttpServer());
  const post = (path: string, s: { accessToken: string }, key: string | null, body: object = {}) => {
    let r = http().post(`/v1/test-idem/${path}`).set({ Authorization: `Bearer ${s.accessToken}` });
    if (key !== null) r = r.set("Idempotency-Key", key);
    return r.send(body);
  };

  beforeAll(async () => {
    t = await createAuthTestApp({ controllers: [IdempotencyTestController] });
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());
  beforeEach(() => {
    state.calls = 0;
    state.gate = null;
    state.failOnce = false;
  });

  it("requires the Idempotency-Key header", async () => {
    const s = await t.login();
    const res = await post("echo", s, null);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(state.calls).toBe(0);
  });

  it("replays the stored response for the same key and body, without running the handler again", async () => {
    const s = await t.login();
    const key = randomUUID();
    const first = await post("echo", s, key, { a: 1, b: 2 });
    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    // key order in the body does not matter
    const second = await post("echo", s, key, { b: 2, a: 1 });
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(state.calls).toBe(1);
  });

  it("the same key with a different body is 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const s = await t.login();
    const key = randomUUID();
    await post("echo", s, key, { a: 1 });
    const res = await post("echo", s, key, { a: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(state.calls).toBe(1);
  });

  it("keys are scoped per user and per route", async () => {
    const a = await t.login();
    const b = await t.login();
    const key = randomUUID();
    expect((await post("echo", a, key)).body.user).toBe(a.userId);
    const other = await post("echo", b, key);
    expect(other.headers["idempotent-replayed"]).toBeUndefined();
    expect(other.body.user).toBe(b.userId);
    const otherRoute = await post("reject", a, key);
    expect(otherRoute.headers["idempotent-replayed"]).toBeUndefined();
    expect(state.calls).toBe(3);
  });

  it("a concurrent request with the same key is 409 IDEMPOTENCY_IN_PROGRESS; after it finishes the key replays", async () => {
    const s = await t.login();
    const key = randomUUID();
    let open!: () => void;
    state.gate = new Promise<void>((r) => (open = r));
    const inFlight = post("slow", s, key).then((r) => r);
    await until(async () => (await prisma.idempotencyRecord.count({ where: { userId: s.userId, key } })) > 0);
    const concurrent = await post("slow", s, key);
    expect(concurrent.status).toBe(409);
    expect(concurrent.body.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    open();
    const done = await inFlight;
    expect(done.status).toBe(201);
    const replay = await post("slow", s, key);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(done.body);
    expect(state.calls).toBe(1);
  });

  it("a 5xx failure releases the key so the retry runs again", async () => {
    const s = await t.login();
    const key = randomUUID();
    state.failOnce = true;
    const failed = await post("flaky", s, key);
    expect(failed.status).toBe(500);
    expect(await prisma.idempotencyRecord.count({ where: { userId: s.userId, key } })).toBe(0);
    const retry = await post("flaky", s, key);
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBeUndefined();
    expect(state.calls).toBe(2);
  });

  it("a 4xx is stored and replayed as the same error", async () => {
    const s = await t.login();
    const key = randomUUID();
    const first = await post("reject", s, key);
    expect(first.status).toBe(422);
    const second = await post("reject", s, key);
    expect(second.status).toBe(422);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body.error).toEqual(first.body.error);
    expect(state.calls).toBe(1);
  });

  it("an IN_PROGRESS record abandoned by a crashed process is taken over after the stale window", async () => {
    const s = await t.login();
    const key = randomUUID();
    await post("echo", s, key, { a: 1 });
    // simulate a crash: the record never completed and was started long ago
    await prisma.idempotencyRecord.updateMany({ where: { userId: s.userId, key }, data: { status: "IN_PROGRESS", response: undefined, statusCode: null, startedAt: new Date(t.clock.now().getTime() - 10 * 60_000) } });
    const res = await post("echo", s, key, { a: 1 });
    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(state.calls).toBe(2);
  });
});

async function until(read: () => Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await read())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
