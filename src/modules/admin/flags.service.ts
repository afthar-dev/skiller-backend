import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { z } from "zod";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis/redis.constants";
import { AuditService } from "../audit";
import type { MutationMeta } from "../rbac";

export const FLAG_CACHE_TTL_SEC = 60;
const cacheKey = (key: string) => `flags:${key}`;

export const flagRulesSchema = z
  .object({
    allowUserIds: z.array(z.string().min(1).max(100)).max(1000).optional(),
    percent: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type FlagRules = z.infer<typeof flagRulesSchema>;

interface FlagState {
  enabled: boolean;
  rules: FlagRules | null;
}

/** Stable bucket 0-99 for (flag, user): the same user always lands in the same bucket for a flag. */
export const flagBucket = (key: string, userId: string): number => createHash("sha256").update(`${key}:${userId}`).digest().readUInt32BE(0) % 100;

@Injectable()
export class FlagsService {
  private readonly logger = new Logger(FlagsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * `enabled=false` (or an unknown flag) is always off. Enabled without rules is on for everyone. With rules the user must be in
   * `allowUserIds` or fall in the first `percent` buckets; without a userId only percent 100 matches.
   */
  async isEnabled(key: string, ctx: { userId?: string } = {}): Promise<boolean> {
    const flag = await this.load(key);
    if (!flag || !flag.enabled) return false;
    const rules = flag.rules;
    if (!rules || (rules.allowUserIds === undefined && rules.percent === undefined)) return true;
    if (ctx.userId && rules.allowUserIds?.includes(ctx.userId)) return true;
    if (rules.percent !== undefined) {
      if (rules.percent >= 100) return true;
      if (ctx.userId) return flagBucket(key, ctx.userId) < rules.percent;
    }
    return false;
  }

  async list() {
    const rows = await this.prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
    return { items: rows.map((r) => ({ key: r.key, enabled: r.enabled, rules: r.rules, updatedAt: r.updatedAt.toISOString() })) };
  }

  async set(actorId: string, key: string, input: { enabled: boolean; rules?: FlagRules | null }, meta: MutationMeta = {}) {
    const rules = input.rules ?? null;
    const row = await this.prisma.$transaction(async (tx) => {
      const before = await tx.featureFlag.findUnique({ where: { key } });
      const data = { enabled: input.enabled, rules: (rules ?? Prisma.DbNull) as Prisma.InputJsonValue };
      const saved = await tx.featureFlag.upsert({ where: { key }, create: { key, ...data }, update: data });
      await this.audit.record(tx, {
        actorId,
        action: "flag.update",
        targetType: "feature_flag",
        targetId: key,
        before: before ? { enabled: before.enabled, rules: before.rules } : null,
        after: { enabled: saved.enabled, rules: saved.rules },
        ...meta,
      });
      return saved;
    });
    await this.redis.del(cacheKey(key)).catch((err: unknown) => this.logger.error(`could not bust cache for flag ${key}: ${(err as Error).message}`));
    return { key: row.key, enabled: row.enabled, rules: row.rules, updatedAt: row.updatedAt.toISOString() };
  }

  private async load(key: string): Promise<FlagState | null> {
    try {
      const cached = await this.redis.get(cacheKey(key));
      if (cached !== null) return JSON.parse(cached) as FlagState | null;
    } catch {
      // read through
    }
    const row = await this.prisma.featureFlag.findUnique({ where: { key } });
    const parsed = row?.rules ? flagRulesSchema.safeParse(row.rules) : null;
    const state: FlagState | null = row ? { enabled: row.enabled, rules: parsed?.success ? parsed.data : null } : null;
    // An invalid stored rules blob must not widen access: treat the flag as off.
    const safe = row && row.rules && parsed && !parsed.success ? { enabled: false, rules: null } : state;
    await this.redis.set(cacheKey(key), JSON.stringify(safe), "EX", FLAG_CACHE_TTL_SEC).catch(() => undefined);
    return safe;
  }
}

