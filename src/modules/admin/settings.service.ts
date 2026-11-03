import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis/redis.constants";
import { AuditService } from "../audit/audit.service";
import type { MutationMeta } from "../rbac/roles.service";
import { SETTING_KEYS, SETTINGS, type SettingKey, type SettingValue } from "./settings.registry";

export const SETTINGS_CACHE_TTL_SEC = 60;
const cacheKey = (key: SettingKey) => `settings:${key}`;

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Stored value (validated on write) or the registry default. Cached 60 s; a Redis outage falls back to Postgres. */
  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    try {
      const cached = await this.redis.get(cacheKey(key));
      if (cached !== null) return JSON.parse(cached) as SettingValue<K>;
    } catch {
      // cache unavailable: read through
    }
    const row = await this.prisma.platformSetting.findUnique({ where: { key } });
    let value: SettingValue<K> = SETTINGS[key].default as SettingValue<K>;
    if (row) {
      const parsed = SETTINGS[key].schema.safeParse(row.value);
      if (parsed.success) value = parsed.data as SettingValue<K>;
      else this.logger.error(`stored setting ${key} is invalid; using the default`);
    }
    await this.redis.set(cacheKey(key), JSON.stringify(value), "EX", SETTINGS_CACHE_TTL_SEC).catch(() => undefined);
    return value;
  }

  async list() {
    const rows = await this.prisma.platformSetting.findMany();
    const stored = new Map(rows.map((r) => [r.key, r]));
    return {
      items: SETTING_KEYS.map((key) => {
        const row = stored.get(key);
        const parsed = row ? SETTINGS[key].schema.safeParse(row.value) : null;
        return {
          key,
          value: parsed?.success ? parsed.data : SETTINGS[key].default,
          default: SETTINGS[key].default,
          updatedAt: row?.updatedAt.toISOString() ?? null,
        };
      }),
    };
  }

  /** Validates against the key's schema (ZodError -> 400 VALIDATION_FAILED), writes with an audit row, then busts the cache. */
  async set(actorId: string, key: SettingKey, value: unknown, meta: MutationMeta = {}) {
    const parsed = SETTINGS[key].schema.parse(value);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.platformSetting.findUnique({ where: { key } });
      await tx.platformSetting.upsert({ where: { key }, create: { key, value: parsed }, update: { value: parsed } });
      await this.audit.record(tx, {
        actorId,
        action: "setting.update",
        targetType: "platform_setting",
        targetId: key,
        before: before ? { value: before.value } : { value: SETTINGS[key].default, isDefault: true },
        after: { value: parsed } as Prisma.InputJsonValue,
        ...meta,
      });
    });
    await this.redis.del(cacheKey(key)).catch((err: unknown) => this.logger.error(`could not bust cache for setting ${key}: ${(err as Error).message}`));
    return { key, value: parsed };
  }
}
