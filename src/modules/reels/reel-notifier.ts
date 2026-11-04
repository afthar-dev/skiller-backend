import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../common/redis/redis.constants";
import { NotificationsService, type NotifyInput } from "../notifications";

/** A creator hears about likes (or comments) on one reel at most once per this long. */
export const REEL_ACTIVITY_WINDOW_SEC = 10 * 60;

/** Tells creators and commenters about their reels. Best effort: a failed notification never undoes what happened. */
@Injectable()
export class ReelNotifier {
  private readonly logger = new Logger(ReelNotifier.name);

  constructor(
    private readonly notifications: NotificationsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async notifyUser(userId: string, input: NotifyInput): Promise<void> {
    try {
      await this.notifications.notify(userId, input);
    } catch (err) {
      this.logger.error(`could not notify user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Batched: a Redis key per (kind, reel, creator) lets one notification through per REEL_ACTIVITY_WINDOW_SEC, however much happens in between
   * (the same pattern as course reviews). Never tells a creator about their own action.
   */
  async notifyCreatorOfActivity(kind: "like" | "comment", reel: { id: string; creatorId: string }, actorId: string, input: Omit<NotifyInput, "data">): Promise<void> {
    if (reel.creatorId === actorId) return;
    const key = `notify:reel-${kind}:${reel.id}:${reel.creatorId}`;
    try {
      if ((await this.redis.set(key, "1", "EX", REEL_ACTIVITY_WINDOW_SEC, "NX")) !== "OK") return;
      try {
        await this.notifications.notify(reel.creatorId, { ...input, data: { reelId: reel.id } });
      } catch (err) {
        await this.redis.del(key).catch(() => undefined); // not told: let the next event try again
        throw err;
      }
    } catch (err) {
      this.logger.error(`could not notify the creator of reel ${reel.id} about a ${kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
