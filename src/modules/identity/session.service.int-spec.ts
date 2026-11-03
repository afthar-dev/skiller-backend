import { Test, TestingModule } from "@nestjs/testing";
import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { applyTestEnv } from "../../../test/setup/env";
import { FakeClock } from "../../../test/support/fake-clock";
import { CLOCK } from "../../common/clock/clock";
import { ConfigModule } from "../../common/config/config.module";
import { AppError } from "../../common/errors/app-error";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis/redis.constants";
import { RedisModule } from "../../common/redis/redis.module";
import { SessionService } from "./session.service";

const DAY = 24 * 3600_000;
const meta = { ip: "9.9.9.9", userAgent: "jest" };

describe("SessionService", () => {
  let moduleRef: TestingModule;
  let sessions: SessionService;
  let prisma: PrismaService;
  let redis: Redis;
  const clock = new FakeClock();

  beforeAll(async () => {
    applyTestEnv({ DATABASE_URL: process.env.DATABASE_URL!, REDIS_URL: process.env.REDIS_URL! });
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PrismaModule, RedisModule],
      providers: [SessionService, { provide: CLOCK, useValue: clock }],
    }).compile();
    await moduleRef.init();
    sessions = moduleRef.get(SessionService);
    prisma = moduleRef.get(PrismaService);
    redis = moduleRef.get(REDIS);
  });

  afterAll(() => moduleRef?.close());

  const newUser = async () => (await prisma.user.create({ data: { email: `sess-${randomUUID()}@example.com` } })).id;
  const errOf = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as AppError;

  it("create: stores only the SHA-256 of a 32-byte base64url token, expiring in 30 days", async () => {
    const userId = await newUser();
    const { session, refreshToken } = await sessions.create(userId, meta);
    expect(Buffer.from(refreshToken, "base64url")).toHaveLength(32);
    expect(session.refreshHash).toBe(createHash("sha256").update(refreshToken).digest("hex"));
    expect(session.refreshHash).not.toContain(refreshToken);
    expect(session.expiresAt.getTime() - clock.now().getTime()).toBe(30 * DAY);
    expect(session.familyId).toBeTruthy();
  });

  it("rotate: issues a new token, keeps the same session and records the previous hash", async () => {
    const userId = await newUser();
    const { session, refreshToken } = await sessions.create(userId, meta);
    const rotated = await sessions.rotate(refreshToken, meta);
    expect(rotated).toMatchObject({ userId, sessionId: session.id });
    expect(rotated.refreshToken).not.toBe(refreshToken);
    const row = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.previousHash).toBe(createHash("sha256").update(refreshToken).digest("hex"));
    expect(row.refreshHash).toBe(createHash("sha256").update(rotated.refreshToken).digest("hex"));
    expect(row.rotatedAt).not.toBeNull();
  });

  it("REFRESH_RACE: old token inside 10 s is a 409 and the new token still works", async () => {
    const userId = await newUser();
    const { refreshToken: t0 } = await sessions.create(userId, meta);
    const { refreshToken: t1 } = await sessions.rotate(t0, meta);
    clock.advanceSec(10);
    const err = await errOf(sessions.rotate(t0, meta));
    expect(err.code).toBe("REFRESH_RACE");
    expect(err.status).toBe(409);
    await expect(sessions.rotate(t1, meta)).resolves.toMatchObject({ userId });
  });

  it("AUTH_TOKEN_REUSED: old token after 10 s revokes the whole family, including the new token", async () => {
    const userId = await newUser();
    const { session, refreshToken: t0 } = await sessions.create(userId, meta);
    const { refreshToken: t1 } = await sessions.rotate(t0, meta);
    clock.advance(10_001);
    const err = await errOf(sessions.rotate(t0, meta));
    expect(err.code).toBe("AUTH_TOKEN_REUSED");
    expect(err.status).toBe(401);
    expect((await errOf(sessions.rotate(t1, meta))).code).toBe("AUTH_SESSION_EXPIRED");
    expect(await sessions.isRevoked(session.id)).toBe(true);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).not.toBeNull();
  });

  it("family revocation covers every session of the family", async () => {
    const userId = await newUser();
    const a = await sessions.create(userId, meta);
    const sibling = await prisma.session.create({
      data: {
        userId,
        familyId: a.session.familyId,
        refreshHash: randomUUID(),
        userAgent: "x",
        ip: "x",
        lastUsedAt: clock.now(),
        expiresAt: new Date(clock.now().getTime() + DAY),
      },
    });
    await sessions.rotate(a.refreshToken, meta);
    clock.advance(11_000);
    await errOf(sessions.rotate(a.refreshToken, meta));
    expect((await prisma.session.findUniqueOrThrow({ where: { id: sibling.id } })).revokedAt).not.toBeNull();
    expect(await sessions.isRevoked(sibling.id)).toBe(true);
  });

  it("unknown token -> AUTH_SESSION_EXPIRED; expired session -> AUTH_SESSION_EXPIRED", async () => {
    expect((await errOf(sessions.rotate("nope", meta))).code).toBe("AUTH_SESSION_EXPIRED");
    const userId = await newUser();
    const { refreshToken } = await sessions.create(userId, meta);
    clock.advance(30 * DAY + 1000);
    const err = await errOf(sessions.rotate(refreshToken, meta));
    expect(err.code).toBe("AUTH_SESSION_EXPIRED");
    expect(err.status).toBe(401);
  });

  it("revoked session cannot rotate", async () => {
    const userId = await newUser();
    const { session, refreshToken } = await sessions.create(userId, meta);
    await sessions.revoke(session.id);
    expect((await errOf(sessions.rotate(refreshToken, meta))).code).toBe("AUTH_SESSION_EXPIRED");
  });

  it("concurrent rotations of one token: exactly one wins, the rest are REFRESH_RACE", async () => {
    const userId = await newUser();
    const { refreshToken } = await sessions.create(userId, meta);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => sessions.rotate(refreshToken, meta)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as AppError).code).toBe("REFRESH_RACE");
  });

  it("revoke sets sessions:revoked:{sid} with a 15 min TTL; revokeAllForUser honours exceptSessionId; list hides revoked", async () => {
    const userId = await newUser();
    const a = await sessions.create(userId, meta);
    const b = await sessions.create(userId, meta);
    const c = await sessions.create(userId, meta);
    await sessions.revoke(a.session.id);
    const ttl = await redis.ttl(`sessions:revoked:${a.session.id}`);
    expect(ttl).toBeGreaterThan(800);
    expect(ttl).toBeLessThanOrEqual(960);
    await sessions.revokeAllForUser(userId, b.session.id);
    expect(await sessions.isRevoked(c.session.id)).toBe(true);
    expect(await sessions.isRevoked(b.session.id)).toBe(false);
    const listed = await sessions.list(userId);
    expect(listed.map((s) => s.id)).toEqual([b.session.id]);
  });

  it("revoke with an owner id refuses other users' sessions", async () => {
    const owner = await newUser();
    const other = await newUser();
    const { session } = await sessions.create(owner, meta);
    expect(await sessions.revoke(session.id, other)).toBe(false);
    expect(await sessions.isRevoked(session.id)).toBe(false);
    expect(await sessions.revoke(session.id, owner)).toBe(true);
  });

  describe("Redis marker failures", () => {
    const failingRedis = { set: async () => { throw new Error("redis down"); }, exists: async () => 0 } as unknown as Redis;
    const flaky = () => new SessionService(prisma, failingRedis, clock);

    it("revoke: marker is written first; if Redis fails -> 503 and the DB session stays active", async () => {
      const userId = await newUser();
      const { session } = await sessions.create(userId, meta);
      const err = await errOf(flaky().revoke(session.id));
      expect(err.code).toBe("SERVICE_UNAVAILABLE");
      expect(err.status).toBe(503);
      expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).toBeNull();
    });

    it("revokeAllForUser: Redis failure -> 503 and nothing revoked in the DB", async () => {
      const userId = await newUser();
      const { session } = await sessions.create(userId, meta);
      expect((await errOf(flaky().revokeAllForUser(userId))).status).toBe(503);
      expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).toBeNull();
    });

    it("reuse detection still answers 401 AUTH_TOKEN_REUSED when marker writes fail, and the family is revoked in the DB", async () => {
      const svc = flaky();
      const userId = await newUser();
      const { session, refreshToken: t0 } = await svc.create(userId, meta);
      await svc.rotate(t0, meta);
      clock.advance(11_000);
      const err = await errOf(svc.rotate(t0, meta));
      expect(err.code).toBe("AUTH_TOKEN_REUSED");
      expect(err.status).toBe(401);
      expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).not.toBeNull();
    });

    it("retries the marker write 3 times before giving up", async () => {
      let calls = 0;
      let failures = 2;
      const redisFlaky = { set: async () => { calls++; if (failures-- > 0) throw new Error("blip"); return "OK"; } } as unknown as Redis;
      const userId = await newUser();
      const { session } = await sessions.create(userId, meta);
      await expect(new SessionService(prisma, redisFlaky, clock).revoke(session.id)).resolves.toBe(true);
      expect(calls).toBe(3);
    });
  });
});
