import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { EventBus } from "../../common/outbox/event-bus";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis/redis.constants";
import { AccountService } from "../identity/account.service";
import { MailService } from "../mail/mail.service";

const REASONS: Record<string, string> = {
  DURATION_EXCEEDED: "The video is longer than the 90 seconds allowed for reels.",
  NO_VIDEO_STREAM: "The file does not contain a video track.",
  INVALID_MEDIA: "The file is damaged or in a format we cannot read.",
  INVALID_IMAGE: "The image is damaged or in a format we cannot read.",
  UPLOAD_SIZE_MISMATCH: "The upload was incomplete.",
};
const DEFAULT_REASON = "Something went wrong while processing the file.";
const DEDUPE_TTL_SEC = 7 * 24 * 3600;

/** Tells the owner when an upload fails. The outbox is at-least-once, so a Redis marker keeps a redelivered event from mailing twice. */
@Injectable()
export class MediaFailedMailHandler implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly mail: MailService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    this.bus.on("media.failed", async (e) => {
      const marker = `media-failed-mail:${e.assetId}`;
      if ((await this.redis.set(marker, "1", "EX", DEDUPE_TTL_SEC, "NX")) !== "OK") return;
      try {
        const [email, asset] = await Promise.all([
          this.accounts.findEmail(e.ownerId),
          this.prisma.mediaAsset.findUnique({ where: { id: e.assetId }, select: { filename: true } }),
        ]);
        if (!email) return;
        await this.mail.send("media_failed", email, { fileName: asset?.filename ?? "your file", reason: REASONS[e.reason] ?? DEFAULT_REASON });
      } catch (err) {
        await this.redis.del(marker);
        throw err;
      }
    });
  }
}
