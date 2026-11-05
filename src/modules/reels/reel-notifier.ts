import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../common/redis/redis.constants";
import { UserBlocks } from "../moderation";
import { NotificationsService, type NotifyInput } from "../notifications";

/** A creator hears about likes (or comments) on one reel at most once per this long. */
export const REEL_ACTIVITY_WINDOW_SEC = 10 * 60;

/** Tells creators and commenters about their reels. Best effort: a failed notification never undoes what happened. */
@Injectable()
export class ReelNotifier {
  private readonly logger = new Logger(ReelNotifier.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly blocks: UserBlocks,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** `actorId` = the member whose action this is about: nothing is sent between two members who blocked each other. */
  async notifyUser(userId: string, input: NotifyInput, actorId?: string): Promise<void> {
    try {
      if (actorId && (await this.blocks.isBlockedEitherWay(actorId, userId))) return;
      await this.notifications.notify(userId, input);
    } catch (err) {
      this.logger.error(`could not notify user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Batched: a Redis key per (kind, reel, creator) lets one notification through per REEL_ACTIVITY_WINDOW_SEC, however much happens in between
   * (the same pattern as course reviews). Never tells a creator about their own action, nor about a member they blocked or who blocked them.
   */
  async notifyCreatorOfActivity(
    kind: "like" | "comment",
    reel: { id: string; creatorId: string },
    actorId: string,
    input: Omit<NotifyInput, "data"> & { data?: Record<string, unknown> },
  ): Promise<void> {
    if (reel.creatorId === actorId) return;
    const key = `notify:reel-${kind}:${reel.id}:${reel.creatorId}`;
    try {
      if (await this.blocks.isBlockedEitherWay(actorId, reel.creatorId)) return;
      if ((await this.redis.set(key, "1", "EX", REEL_ACTIVITY_WINDOW_SEC, "NX")) !== "OK") return;
      try {
        await this.notifications.notify(reel.creatorId, { ...input, data: { ...input.data, reelId: reel.id, actorId } });
      } catch (err) {
        await this.redis.del(key).catch(() => undefined); // not told: let the next event try again
        throw err;
      }
    } catch (err) {
      this.logger.error(`could not notify the creator of reel ${reel.id} about a ${kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
