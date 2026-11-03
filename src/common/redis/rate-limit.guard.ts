import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { Redis } from "ioredis";
import { RATE_LIMIT_KEY, RateLimitOptions } from "./rate-limit.decorator";
import { consumeRateLimit } from "./rate-limiter";
import { REDIS } from "./redis.constants";

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

  private consume(req: Request, options: RateLimitOptions): Promise<void> {
    return consumeRateLimit(this.redis, options.key(req), options.limit, options.windowSec);
  }
}
