import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import IORedis from "ioredis";
import { AppError } from "../errors/app-error";
import { RateLimit } from "./rate-limit.decorator";
import { RateLimitGuard } from "./rate-limit.guard";

class Sample {
  @RateLimit({ key: (req) => `test:${req.body.k as string}`, limit: 3, windowSec: 60 })
  limited() {}

  unlimited() {}
}

function ctx(handler: () => void, body: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Sample,
    switchToHttp: () => ({ getRequest: () => ({ body, ip: "127.0.0.1" }) }),
  } as unknown as ExecutionContext;
}

describe("RateLimitGuard", () => {
  let container: StartedRedisContainer;
  let redis: IORedis;
  let guard: RateLimitGuard;
  const sample = new Sample();

  beforeAll(async () => {
    container = await new RedisContainer("redis:7-alpine").start();
    redis = new IORedis(container.getConnectionUrl());
    guard = new RateLimitGuard(new Reflector(), redis);
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
});
