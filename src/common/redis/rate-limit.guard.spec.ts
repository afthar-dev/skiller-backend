import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import IORedis from "ioredis";
import { AppError } from "../errors/app-error";
import { OptionalAuth } from "../auth/optional-auth.decorator";
import { Public } from "../auth/public.decorator";
import { RateLimit } from "./rate-limit.decorator";
import { RateLimitGuard } from "./rate-limit.guard";

class Sample {
  @RateLimit({ key: (req) => `test:${req.body.k as string}`, limit: 3, windowSec: 60 })
  limited() {}

  unlimited() {}

  @Public()
  @RateLimit({ key: (req) => `pub:${req.ip}`, limit: 2, windowSec: 60 })
  publicRead() {}

  @RateLimit({ key: (req) => `priv:${req.ip}`, limit: 2, windowSec: 60 })
  privateRead() {}

  @OptionalAuth()
  @RateLimit({ key: (req) => `opt:${req.ip}`, limit: 2, windowSec: 60, anonymousOnly: true })
  optionalRead() {}
}

const SECRET = "s".repeat(40);

function ctx(handler: () => void, body: Record<string, unknown>, headers: Record<string, string> = {}, ip = "127.0.0.1", method = "GET") {
  const req = { body, ip, headers, method };
  const context = {
    getHandler: () => handler,
    getClass: () => Sample,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return Object.assign(context, { req });
}

describe("RateLimitGuard", () => {
  let container: StartedRedisContainer;
  let redis: IORedis;
  let guard: RateLimitGuard;
  const sample = new Sample();

  beforeAll(async () => {
    container = await new RedisContainer("redis:7-alpine").start();
    redis = new IORedis(container.getConnectionUrl());
    guard = new RateLimitGuard(new Reflector(), redis, { ssrSharedSecret: SECRET });
  });

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  it("allows `limit` calls then throws RATE_LIMITED with retryAfterSec", async () => {
    const k = `a-${Date.now()}`;
    for (let i = 0; i < 3; i++) await expect(guard.canActivate(ctx(sample.limited, { k }))).resolves.toBe(true);
    const err = await guard.canActivate(ctx(sample.limited, { k })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.status).toBe(429);
    const retry = e.details.retryAfterSec as number;
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
  });

  it("does not affect a different key", async () => {
    const k1 = `b-${Date.now()}`;
    for (let i = 0; i < 3; i++) await guard.canActivate(ctx(sample.limited, { k: k1 }));
    await expect(guard.canActivate(ctx(sample.limited, { k: k1 }))).rejects.toBeInstanceOf(AppError);
    await expect(guard.canActivate(ctx(sample.limited, { k: `c-${Date.now()}` }))).resolves.toBe(true);
  });

  it("ignores handlers without @RateLimit", async () => {
    await expect(guard.canActivate(ctx(sample.unlimited, {}))).resolves.toBe(true);
  });

  describe("optional-auth routes with an anonymous-only limit", () => {
    const fresh = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

    it("counts a request without a token per address and refuses past the limit", async () => {
      const ip = fresh();
      await guard.canActivate(ctx(sample.optionalRead, {}, {}, ip));
      await guard.canActivate(ctx(sample.optionalRead, {}, {}, ip));
      await expect(guard.canActivate(ctx(sample.optionalRead, {}, {}, ip))).rejects.toBeInstanceOf(AppError);
    });

    it("never counts or refuses a request that carries a token", async () => {
      const ip = fresh();
      for (let i = 0; i < 5; i++) await expect(guard.canActivate(ctx(sample.optionalRead, {}, { authorization: "Bearer x" }, ip))).resolves.toBe(true);
      expect(await redis.exists(`rl:opt:${ip}`)).toBe(0);
    });

    it("the trusted server with no visitor is not limited on a signed-out read; with a visitor named, that address is counted", async () => {
      const ip = fresh();
      const server = { "x-skiller-server": SECRET };
      for (let i = 0; i < 5; i++) await expect(guard.canActivate(ctx(sample.optionalRead, {}, server, ip))).resolves.toBe(true);
      expect(await redis.exists(`rl:opt:${ip}`)).toBe(0);
      const visitor = fresh();
      await guard.canActivate(ctx(sample.optionalRead, {}, { ...server, "x-skiller-client-ip": visitor }, ip));
      expect(await redis.exists(`rl:opt:${visitor}`)).toBe(1);
    });
  });

  describe("trusted web server", () => {
    const fresh = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

    it("with the secret and a client IP, limits count that address, not the caller's", async () => {
      const ip = fresh();
      const headers = { "x-skiller-server": SECRET, "x-skiller-client-ip": "203.0.113.9" };
      const c = ctx(sample.privateRead, {}, headers, ip);
      await guard.canActivate(c);
      expect(c.req.ip).toBe("203.0.113.9");
      expect(await redis.exists("rl:priv:203.0.113.9")).toBe(1);
      expect(await redis.exists(`rl:priv:${ip}`)).toBe(0);
      await redis.del("rl:priv:203.0.113.9");
    });

    it("with the secret and no client IP, a @Public read limit is skipped (a private one is not)", async () => {
      const ip = fresh();
      const headers = { "x-skiller-server": SECRET };
      for (let i = 0; i < 5; i++) await expect(guard.canActivate(ctx(sample.publicRead, {}, headers, ip))).resolves.toBe(true);
      expect(await redis.exists(`rl:pub:${ip}`)).toBe(0);
      await guard.canActivate(ctx(sample.privateRead, {}, headers, ip));
      expect(await redis.exists(`rl:priv:${ip}`)).toBe(1);
      // a public route that is not a read (POST) still counts
      await guard.canActivate(ctx(sample.publicRead, {}, headers, ip, "POST"));
      expect(await redis.exists(`rl:pub:${ip}`)).toBe(1);
    });

    it("with a wrong secret both headers are ignored and req.ip is used", async () => {
      const ip = fresh();
      const headers = { "x-skiller-server": "wrong".repeat(10), "x-skiller-client-ip": "203.0.113.10" };
      const c = ctx(sample.publicRead, {}, headers, ip);
      await guard.canActivate(c);
      expect(c.req.ip).toBe(ip);
      expect(await redis.exists(`rl:pub:${ip}`)).toBe(1);
      expect(await redis.exists("rl:pub:203.0.113.10")).toBe(0);
      await guard.canActivate(ctx(sample.publicRead, {}, headers, ip));
      await expect(guard.canActivate(ctx(sample.publicRead, {}, headers, ip))).rejects.toBeInstanceOf(AppError);
    });

    it("a client IP header without the secret is ignored", async () => {
      const ip = fresh();
      const c = ctx(sample.publicRead, {}, { "x-skiller-client-ip": "203.0.113.11" }, ip);
      await guard.canActivate(c);
      expect(c.req.ip).toBe(ip);
      expect(await redis.exists("rl:pub:203.0.113.11")).toBe(0);
    });

    it("a malformed client IP counts as none, and with no secret configured the headers mean nothing", async () => {
      const ip = fresh();
      const c = ctx(sample.privateRead, {}, { "x-skiller-server": SECRET, "x-skiller-client-ip": "not an ip" }, ip);
      await guard.canActivate(c);
      expect(c.req.ip).toBe(ip);
      const open = new RateLimitGuard(new Reflector(), redis, { ssrSharedSecret: undefined });
      const d = ctx(sample.privateRead, {}, { "x-skiller-server": "", "x-skiller-client-ip": "203.0.113.12" }, ip);
      await open.canActivate(d);
      expect(d.req.ip).toBe(ip);
    });
  });
});
