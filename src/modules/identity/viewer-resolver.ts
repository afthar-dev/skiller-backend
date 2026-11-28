import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { SessionService } from "./session.service";
import { TokenService } from "./token.service";
import { UserStatusCache } from "./user-status.cache";

/** Public routes that show more to a signed-in viewer (liked by me, my own unpublished reel): a valid bearer token names the viewer; anything else is anonymous. */
@Injectable()
export class ViewerResolver {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly statuses: UserStatusCache,
  ) {}

  async viewerId(req: Request): Promise<string | null> {
    const match = typeof req.headers.authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization) : null;
    if (!match) return null;
    try {
      const { sub, sid } = this.tokens.verifyAccess(match[1]);
      if (await this.sessions.isRevoked(sid)) return null;
      // Same rule as AuthGuard: a suspended or deleted account is anonymous even while its token is still inside its 15 minutes.
      return (await this.statuses.get(sub)) === "ACTIVE" ? sub : null;
    } catch {
      return null;
    }
  }
}
