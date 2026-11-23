import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Request } from "express";
import type { Redis } from "ioredis";
import { OPTIONAL_AUTH_KEY } from "../auth/optional-auth.decorator";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
import { APP_CONFIG } from "../config/config.module";
import type { AppConfig } from "../config/config.schema";
import { RATE_LIMIT_KEY, RateLimitOptions } from "./rate-limit.decorator";
import { consumeRateLimit } from "./rate-limiter";
import { REDIS } from "./redis.constants";

/** Sent by the web app's server on every call it makes; compared with SSR_SHARED_SECRET. */
export const SERVER_SECRET_HEADER = "x-skiller-server";
/** Who the web app's server is calling for (the visitor's address). Only read when the secret matches. */
export const CLIENT_IP_HEADER = "x-skiller-client-ip";

const digest = (value: string) => createHash("sha256").update(value).digest();

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, "ssrSharedSecret">,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    // The web app's server calls from a handful of addresses on behalf of every visitor: with its secret it names the visitor, and limits count that address.
    // Only on public reads: that is all the web app's server needs it for, and honouring it elsewhere would let a leaked secret
    // erase every per-IP limit (otp/request, otp/verify, admin writes) and forge the addresses stored in sessions and audit rows.
    const publicRead = this.isPublicRead(context, req);
    const trusted = publicRead && this.isTrustedServer(req);
    const clientIp = trusted ? this.clientIpOf(req) : undefined;
    if (clientIp) Object.defineProperty(req, "ip", { value: clientIp, configurable: true, enumerable: true, writable: true });

    const options = this.reflector.getAllAndOverride<RateLimitOptions[] | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options || options.length === 0) return true;
    // Server-side rendering with no visitor behind it (a build, a revalidation): counting its own address would throttle the site itself.
    if (trusted && !clientIp) return true;

    for (const option of options) {
      if (option.anonymousOnly && req.headers?.authorization) continue;
      await this.consume(req, option);
    }
    return true;
  }

  private isTrustedServer(req: Request): boolean {
    const expected = this.config.ssrSharedSecret;
    const sent = req.headers?.[SERVER_SECRET_HEADER];
    if (!expected || typeof sent !== "string" || sent.length === 0) return false;
    return timingSafeEqual(digest(sent), digest(expected));
  }

  private clientIpOf(req: Request): string | undefined {
    const raw = req.headers?.[CLIENT_IP_HEADER];
    const value = typeof raw === "string" ? raw.trim() : "";
    return isIP(value) !== 0 ? value : undefined;
  }

  private isPublicRead(context: ExecutionContext, req: Request): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true) return true;
    // A signed-out read of an optional-auth route is a public read; with a token it is a signed-in call and keeps its limits.
    return this.reflector.getAllAndOverride<boolean | undefined>(OPTIONAL_AUTH_KEY, targets) === true && !req.headers?.authorization;
  }

  private consume(req: Request, options: RateLimitOptions): Promise<void> {
    return consumeRateLimit(this.redis, options.key(req), options.limit, options.windowSec);
  }
}
