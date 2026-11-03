import { Inject, Injectable } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";

export const ACCESS_TTL_SEC = 15 * 60;
const ISSUER = "skiller";

export interface AccessClaims {
  sub: string;
  sid: string;
}

@Injectable()
export class TokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  signAccess(p: AccessClaims): string {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    return jwt.sign({ sid: p.sid, iat }, this.config.jwtSecret, {
      algorithm: "HS256",
      subject: p.sub,
      issuer: ISSUER,
      expiresIn: ACCESS_TTL_SEC,
    });
  }

  verifyAccess(token: string): AccessClaims {
    try {
      const payload = jwt.verify(token, this.config.jwtSecret, {
        algorithms: ["HS256"],
        issuer: ISSUER,
        clockTimestamp: Math.floor(this.clock.now().getTime() / 1000),
      });
      if (typeof payload === "string" || typeof payload.sub !== "string" || typeof payload.sid !== "string") {
        throw new AppError("AUTH_TOKEN_INVALID", 401, "Invalid access token");
      }
      return { sub: payload.sub, sid: payload.sid };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof jwt.TokenExpiredError) throw new AppError("AUTH_TOKEN_EXPIRED", 401, "Access token expired");
      throw new AppError("AUTH_TOKEN_INVALID", 401, "Invalid access token");
    }
  }
}
