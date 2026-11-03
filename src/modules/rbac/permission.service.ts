import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis/redis.constants";

export const PERMISSION_CACHE_TTL_SEC = 10 * 60;
const cacheKey = (userId: string) => `perm:${userId}`;

export interface EffectivePermissions {
  /** Keys from grants with no org (apply everywhere). */
  platform: Set<string>;
  /** Keys from org-scoped grants, per org id. */
  byOrg: Map<string, Set<string>>;
}

interface CachedShape {
  platform: string[];
  byOrg: Record<string, string[]>;
}

@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async effective(userId: string): Promise<EffectivePermissions> {
    const cached = await this.redis.get(cacheKey(userId));
    if (cached) {
      try {
        return this.fromShape(JSON.parse(cached) as CachedShape);
      } catch {
        // corrupt entry: fall through and rebuild
      }
    }

    const now = this.clock.now();
    const grants = await this.prisma.userRole.findMany({
      where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: {
        orgId: true,
        expiresAt: true,
        role: { select: { rolePermissions: { select: { permission: { select: { key: true } } } } } },
      },
    });

    const platform = new Set<string>();
    const byOrg = new Map<string, Set<string>>();
    let soonestExpiry: number | null = null;
    for (const grant of grants) {
      const target = grant.orgId === null ? platform : (byOrg.get(grant.orgId) ?? byOrg.set(grant.orgId, new Set()).get(grant.orgId)!);
      for (const rp of grant.role.rolePermissions) target.add(rp.permission.key);
      if (grant.expiresAt && (soonestExpiry === null || grant.expiresAt.getTime() < soonestExpiry)) soonestExpiry = grant.expiresAt.getTime();
    }

    // A cached entry must never outlive the earliest grant expiry it contains.
    let ttl = PERMISSION_CACHE_TTL_SEC;
    if (soonestExpiry !== null) ttl = Math.max(1, Math.min(ttl, Math.floor((soonestExpiry - now.getTime()) / 1000)));
    const shape: CachedShape = {
      platform: [...platform],
      byOrg: Object.fromEntries([...byOrg].map(([org, keys]) => [org, [...keys]])),
    };
    await this.redis.set(cacheKey(userId), JSON.stringify(shape), "EX", ttl);
    return { platform, byOrg };
  }

  /** A platform grant satisfies any org. Without `orgId` only platform grants count. */
  async has(userId: string, key: string, orgId?: string): Promise<boolean> {
    const eff = await this.effective(userId);
    if (eff.platform.has(key)) return true;
    return orgId !== undefined && (eff.byOrg.get(orgId)?.has(key) ?? false);
  }

  async invalidateUser(userId: string): Promise<void> {
    await this.redis.del(cacheKey(userId));
  }

  async invalidateUsers(userIds: string[]): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length > 0) await this.redis.del(...unique.map(cacheKey));
  }

  /** Drops the cached permissions of everyone currently holding the role. */
  async invalidateRole(roleId: string): Promise<void> {
    const holders = await this.prisma.userRole.findMany({ where: { roleId }, select: { userId: true }, distinct: ["userId"] });
    await this.invalidateUsers(holders.map((h) => h.userId));
  }

  private fromShape(shape: CachedShape): EffectivePermissions {
    return {
      platform: new Set(shape.platform),
      byOrg: new Map(Object.entries(shape.byOrg).map(([org, keys]) => [org, new Set(keys)])),
    };
  }
}
