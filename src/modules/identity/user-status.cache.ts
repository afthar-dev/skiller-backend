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
