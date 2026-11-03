import type { Redis } from "ioredis";
import { AppError } from "../errors/app-error";

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

/** Consumes one slot of a sliding-window limit; throws RATE_LIMITED (429, details.retryAfterSec) when exhausted. */
export async function consumeRateLimit(redis: Redis, key: string, limit: number, windowSec: number): Promise<void> {
  const member = `${Date.now()}-${process.pid}-${seq++}-${Math.random().toString(36).slice(2, 8)}`;
  const [allowed, retryMs] = (await redis.eval(SLIDING_WINDOW_LUA, 1, `rl:${key}`, limit, windowSec * 1000, member)) as [number, number];
  if (allowed === 1) return;
  const retryAfterSec = Math.min(windowSec, Math.max(1, Math.ceil(retryMs / 1000)));
  throw new AppError("RATE_LIMITED", 429, "Too many requests", { retryAfterSec });
}
