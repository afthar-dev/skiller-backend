import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import IORedis, { type Redis } from "ioredis";
import { APP_CONFIG } from "../config/config.module";
import type { AppConfig } from "../config/config.schema";
import { RateLimitGuard } from "./rate-limit.guard";
import { REDIS } from "./redis.constants";

@Global()
@Module({
  providers: [
    { provide: REDIS, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new IORedis(config.redisUrl) },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown() {
    if (typeof this.redis.quit === "function") await this.redis.quit().catch(() => undefined);
  }
}
