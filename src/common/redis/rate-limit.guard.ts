import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { Redis } from "ioredis";
import { AppError } from "../errors/app-error";
import { RATE_LIMIT_KEY, RateLimitOptions } from "./rate-limit.decorator";
import { REDIS } from "./redis.constants";

// Sliding window over a sorted set. Runs atomically in Redis; uses Redis TIME so
// multiple API instances agree on the clock. Returns {allowed, retryAfterMs}.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local member = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryMs = windowMs - (now - tonumber(oldest[2]))
  if retryMs < 1 then retryMs = 1 end
  return {0, retryMs}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)
return {1, 0}
`;

let seq = 0;

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions[] | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options || options.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    for (const option of options) await this.consume(req, option);
    return true;
  }

  private async consume(req: Request, options: RateLimitOptions): Promise<void> {
    const key = `rl:${options.key(req)}`;
    const member = `${Date.now()}-${process.pid}-${seq++}-${Math.random().toString(36).slice(2, 8)}`;
    const [allowed, retryMs] = (await this.redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      options.limit,
      options.windowSec * 1000,
      member,
    )) as [number, number];

    if (allowed === 1) return;
    const retryAfterSec = Math.min(options.windowSec, Math.max(1, Math.ceil(retryMs / 1000)));
    throw new AppError("RATE_LIMITED", 429, "Too many requests", { retryAfterSec });
  }
}
