import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { AuthUser } from "../../common/auth/auth-user";
import { OPTIONAL_AUTH_KEY } from "../../common/auth/optional-auth.decorator";
import { IS_PUBLIC_KEY } from "../../common/auth/public.decorator";
import { AppError } from "../../common/errors/app-error";
import { SessionService } from "./session.service";
import { TokenService } from "./token.service";
import { UserStatusCache } from "./user-status.cache";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly statuses: UserStatusCache,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    // Optional-auth routes let a request with no Authorization header through as a visitor; one that sends a token is checked in full below.
    if (!header && this.reflector.getAllAndOverride<boolean | undefined>(OPTIONAL_AUTH_KEY, [context.getHandler(), context.getClass()])) return true;
    if (!match) throw new AppError("AUTH_REQUIRED", 401, "Authentication required");

    const { sub, sid } = this.tokens.verifyAccess(match[1]);

    // Status first: suspending also revokes the sessions, and the client must see 403 (suspended), not a generic 401.
    const status = await this.statuses.get(sub);
    if (!status) throw new AppError("AUTH_TOKEN_INVALID", 401, "Invalid access token");
    if (status !== "ACTIVE") throw new AppError("AUTH_ACCOUNT_SUSPENDED", 403, "Account is suspended");

    if (await this.sessions.isRevoked(sid)) throw new AppError("AUTH_SESSION_REVOKED", 401, "Session has been revoked");

    req.user = { id: sub, sessionId: sid };
    return true;
  }
}
