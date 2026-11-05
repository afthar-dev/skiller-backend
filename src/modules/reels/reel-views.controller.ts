import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { Public } from "../../common/auth/public.decorator";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { ReelViewTracker } from "./reel-view-tracker";
import { ViewerResolver } from "./viewer";

export const DEVICE_COOKIE = "skiller_did";
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/; // 128 random bits, base64url
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const viewSchema = z.object({ watchedSec: z.number().finite().min(0).max(86_400) }).strict();

@ApiTags("Reels")
@Controller()
export class ReelViewsController {
  constructor(
    private readonly tracker: ReelViewTracker,
    private readonly viewer: ViewerResolver,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  // Anyone can call this, so it has its own burst cap on top of the hourly cap on anonymous beacons.
  @RateLimit({ key: (req) => `reels:views:${req.ip}`, limit: 600, windowSec: 60 })
  @Post("reels/:id/views")
  @HttpCode(202)
  @ApiOperation({
    summary:
      "Beacon: the viewer has watched `watchedSec` seconds of a published reel. Counts one view per viewer per reel per IST day once it reaches 3 s (the answer says whether it counted). Signed-in viewers are identified by their token, others by the `skiller_did` device cookie (issued here)",
  })
  @ApiZodBody(viewSchema)
  async view(@Param("id") id: string, @Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { watchedSec } = viewSchema.parse(body);
    const userId = await this.viewer.viewerId(req);

    const cookie = (req.cookies as Record<string, unknown> | undefined)?.[DEVICE_COOKIE];
    const deviceId = typeof cookie === "string" && DEVICE_ID.test(cookie) ? cookie : null;
    let issuedDeviceId: string | null = null;
    if (!deviceId && !userId) {
      // Missing or malformed: hand out a new one (a bad value is replaced, never trusted).
      issuedDeviceId = randomBytes(16).toString("base64url");
      res.cookie(DEVICE_COOKIE, issuedDeviceId, { httpOnly: true, secure: this.config.nodeEnv !== "development", sameSite: "lax", path: "/", domain: this.config.cookieDomain, maxAge: ONE_YEAR_MS });
    }
    return this.tracker.record({ reelId: id, watchedSec, userId, deviceId, issuedDeviceId, ip: req.ip ?? "unknown", userAgent: String(req.headers["user-agent"] ?? "") });
  }
}
