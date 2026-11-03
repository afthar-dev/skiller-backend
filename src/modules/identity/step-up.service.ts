import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { REDIS } from "../../common/redis/redis.constants";

export const STEP_UP_TTL_SEC = 300;
const key = (sessionId: string) => `stepup:${sessionId}`;

/**
 * Per-session proof of a recent second factor. Redis holds `stepup:{sessionId}` with a 300 s TTL; the value is the
 * expiry timestamp so validity is also checked against the injectable Clock (not only Redis wall time).
 */
@Injectable()
export class StepUpService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async grant(sessionId: string): Promise<void> {
    const expiresAt = this.clock.now().getTime() + STEP_UP_TTL_SEC * 1000;
    await this.redis.set(key(sessionId), String(expiresAt), "EX", STEP_UP_TTL_SEC);
  }

  async isActive(sessionId: string): Promise<boolean> {
    const value = await this.redis.get(key(sessionId));
    if (!value) return false;
    const expiresAt = Number(value);
    return Number.isFinite(expiresAt) && expiresAt > this.clock.now().getTime();
  }
}
