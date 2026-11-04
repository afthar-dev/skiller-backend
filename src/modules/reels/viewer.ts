import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { SessionService, TokenService } from "../identity";

/** Public routes that show more to a signed-in viewer (liked by me, my own unpublished reel): a valid bearer token names the viewer; anything else is anonymous. */
@Injectable()
export class ViewerResolver {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
  ) {}

  async viewerId(req: Request): Promise<string | null> {
    const match = typeof req.headers.authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization) : null;
    if (!match) return null;
    try {
      const { sub, sid } = this.tokens.verifyAccess(match[1]);
      return (await this.sessions.isRevoked(sid)) ? null : sub;
    } catch {
      return null;
    }
  }
}
