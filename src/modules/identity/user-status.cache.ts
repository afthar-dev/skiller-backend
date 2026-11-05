import { Inject, Injectable } from "@nestjs/common";
import type { UserStatus } from "@prisma/client";
import type { Redis } from "ioredis";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis/redis.constants";

export const USER_STATUS_TTL_SEC = 60;
const key = (userId: string) => `user:status:${userId}`;

/** 60 s read-through cache of User.status so AuthGuard does not hit Postgres on every request. */
@Injectable()
export class UserStatusCache {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Returns null if the user does not exist. */
  async get(userId: string): Promise<UserStatus | null> {
    const cached = await this.redis.get(key(userId));
    if (cached) return cached as UserStatus;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user) return null;
    await this.redis.set(key(userId), user.status, "EX", USER_STATUS_TTL_SEC);
    return user.status;
  }

  /**
   * Statuses of many users at once (one MGET, one query for the misses, which are cached like get()). Users that do not exist are absent from the map.
   * Anything that changes a status must put() or bust() it, as suspend and unsuspend do, or readers see the old one for up to 60 s.
   */
  async getMany(userIds: string[]): Promise<Map<string, UserStatus>> {
    const out = new Map<string, UserStatus>();
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return out;
    const cached = await this.redis.mget(unique.map(key));
    const missing: string[] = [];
    unique.forEach((id, i) => {
      const value = cached[i];
      if (value) out.set(id, value as UserStatus);
      else missing.push(id);
    });
    if (missing.length > 0) {
      const rows = await this.prisma.user.findMany({ where: { id: { in: missing } }, select: { id: true, status: true } });
      if (rows.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const r of rows) {
          out.set(r.id, r.status);
          pipeline.set(key(r.id), r.status, "EX", USER_STATUS_TTL_SEC);
        }
        await pipeline.exec();
      }
    }
    return out;
  }

  /**
   * Overwrites the cached value (retried). For suspension this replaces a bust: a stale ACTIVE can never survive a successful write,
   * and unlike DEL it needs no later read-through to become correct. Throws if every attempt fails.
   */
  async put(userId: string, status: UserStatus): Promise<void> {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.redis.set(key(userId), status, "EX", USER_STATUS_TTL_SEC);
        return;
      } catch (err) {
        last = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 25 * attempt));
      }
    }
    throw last;
  }

  /** Call after changing a user's status so the change takes effect immediately. */
  async bust(userId: string): Promise<void> {
    await this.redis.del(key(userId));
  }
}
