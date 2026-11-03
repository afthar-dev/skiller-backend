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

  /** Call after changing a user's status so the change takes effect immediately. */
  async bust(userId: string): Promise<void> {
    await this.redis.del(key(userId));
  }
}
