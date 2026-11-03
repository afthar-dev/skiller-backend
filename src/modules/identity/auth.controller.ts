import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { CookieOptions, Request, Response } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { AuthService } from "./auth.service";
import { OtpService, normalizeEmail } from "./otp.service";
import { SESSION_TTL_MS, SessionMeta, SessionService } from "./session.service";

export const REFRESH_COOKIE = "skiller_rt";

const requestSchema = z.object({ email: z.string().trim().email().max(254) });
const verifySchema = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/, "code must be 6 digits") });

const WINDOW_15_MIN = 15 * 60;

const emailKey = (req: Request) => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" && email.length <= 254 ? normalizeEmail(email) : `invalid:${req.ip}`;
};

const metaOf = (req: Request): SessionMeta => ({ ip: req.ip ?? "unknown", userAgent: String(req.headers["user-agent"] ?? "unknown") });

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post("otp/request")
  @HttpCode(202)
  @RateLimit(
    { key: (req) => `otp:email:${emailKey(req)}`, limit: 5, windowSec: WINDOW_15_MIN },
    { key: (req) => `otp:ip:${req.ip}`, limit: 20, windowSec: WINDOW_15_MIN },
  )
  async requestOtp(@Body() body: unknown, @Req() req: Request) {
    const { email } = requestSchema.parse(body);
    // Identical flow for known and unknown emails: nothing here looks the user up.
    const { challengeId, expiresAt } = await this.otp.request({ email, purpose: "LOGIN", ip: req.ip ?? "unknown" });
    return { challengeId, expiresAt: expiresAt.toISOString() };
  }

  @Public()
  @Post("otp/verify")
  @HttpCode(200)
  async verifyOtp(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { challengeId, code } = verifySchema.parse(body);
    const result = await this.auth.verifyLogin(challengeId, code, metaOf(req));
    this.setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[REFRESH_COOKIE];
    if (!token) throw new AppError("AUTH_SESSION_EXPIRED", 401, "Session expired; please sign in again");
    try {
      const result = await this.auth.refresh(token, metaOf(req));
      this.setRefreshCookie(res, result.refreshToken);
      return { accessToken: result.accessToken };
    } catch (err) {
      // A dead cookie is useless, so drop it. REFRESH_RACE keeps it: the winning request is setting the new one.
      if (err instanceof AppError && err.code !== "REFRESH_RACE") this.clearRefreshCookie(res);
      throw err;
    }
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(user.sessionId, user.id);
    this.clearRefreshCookie(res);
  }

  @Post("step-up/request")
  @HttpCode(202)
  async requestStepUp(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.auth.requestStepUp(user.id, req.ip ?? "unknown");
  }

  @Post("step-up/verify")
  @HttpCode(204)
  async verifyStepUp(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { challengeId, code } = verifySchema.parse(body);
    await this.auth.verifyStepUp(user.id, user.sessionId, challengeId, code);
  }

  @Get("sessions")
  async listSessions(@CurrentUser() user: AuthUser) {
    const rows = await this.sessions.list(user.id);
    return {
      items: rows.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ip: s.ip,
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        current: s.id === user.sessionId,
      })),
    };
  }

  @Post("sessions/revoke-others")
  @HttpCode(204)
  async revokeOthers(@CurrentUser() user: AuthUser) {
    await this.sessions.revokeAllForUser(user.id, user.sessionId);
  }

  @Delete("sessions/:id")
  @HttpCode(204)
  async revokeSession(@CurrentUser() user: AuthUser, @Param("id") id: string, @Res({ passthrough: true }) res: Response) {
    const ok = await this.sessions.revoke(id, user.id);
    if (!ok) throw new AppError("NOT_FOUND", 404, "Session not found");
    if (id === user.sessionId) this.clearRefreshCookie(res);
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.nodeEnv !== "development",
      sameSite: "lax",
      path: "/v1/auth",
      domain: this.config.cookieDomain,
    };
  }

  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, { ...this.cookieOptions(), maxAge: SESSION_TTL_MS });
  }

  private clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }
}
