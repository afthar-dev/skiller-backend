import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { REDIS } from "../../common/redis/redis.constants";
import { AccountService } from "../identity/account.service";
import { assetPrefix } from "./media.rules";
import { PLAYBACK_ACCESS_POLICY, type PlaybackAccessPolicy } from "./playback-policy";
import { PLAYBACK_TOKEN_TTL_SEC, signPlaybackToken } from "./playback-token";

export const PLAYBACKS_PER_HOUR = 120;

export interface PlaybackGrant {
  manifestUrl: string;
  expiresAt: string;
  /** Shown over the video by the player (the viewer's email) to discourage screen-recorded leaks. */
  watermark: string;
}

@Injectable()
export class PlaybackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    @Inject(PLAYBACK_ACCESS_POLICY) private readonly policies: PlaybackAccessPolicy[],
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Mints a 10-minute token for the private HLS of a READY lesson video. The Cloudflare playback gate verifies it. */
  async grant(userId: string, assetId: string): Promise<PlaybackGrant> {
    await consumeRateLimit(this.redis, `playback:${userId}`, PLAYBACKS_PER_HOUR, 3600);

    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset) throw new AppError("MEDIA_NOT_FOUND", 404, "Media not found");
    if (!(await this.allowed(userId, asset))) throw new AppError("FORBIDDEN", 403, "You do not have access to this media");
    if (asset.bucket !== "PRIVATE" || asset.purpose !== "COURSE_LESSON") {
      throw new AppError("MEDIA_NOT_PLAYABLE", 422, "Only private lesson videos can be played through signed playback");
    }
    if (asset.status !== "READY") throw new AppError("MEDIA_NOT_READY", 409, "This video is still processing");

    const email = await this.accounts.findEmail(userId);
    const exp = Math.floor(this.clock.now().getTime() / 1000) + PLAYBACK_TOKEN_TTL_SEC;
    const token = signPlaybackToken({ u: userId, a: asset.id, exp }, this.config.playbackSecret);
    return {
      manifestUrl: `${this.config.r2.playbackBaseUrl.replace(/\/+$/, "")}/${assetPrefix(asset)}/hls/index.m3u8?t=${token}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      watermark: email ?? userId,
    };
  }

  private async allowed(userId: string, asset: Parameters<PlaybackAccessPolicy["canPlay"]>[1]): Promise<boolean> {
    for (const policy of this.policies) {
      if (await policy.canPlay(userId, asset)) return true;
    }
    return false;
  }
}
