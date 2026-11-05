import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { EventBus } from "../../common/outbox/event-bus";
import type { EventOf } from "../../common/outbox/events";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis";
import { CourseCategories } from "../courses";
import { InterestsService } from "./interests.service";

/** How much each kind of engagement says about interest. */
export const ENGAGEMENT_WEIGHT: Record<EventOf<"reel.engaged">["kind"], number> = { like: 1, save: 2, comment: 1.5, share: 2, view: 0.5 };
/** Processed event ids are remembered this long; the outbox redelivers within minutes. */
const PROCESSED_TTL_SEC = 7 * 24 * 3600;
export const processedKey = (eventId: string) => `interest:event:${eventId}`;

/**
 * reel.engaged -> interest weights on the reel's hashtags and its linked course's category. Delivery is at-least-once, so the event id is
 * claimed first (SET NX); if the write then fails the claim is released so the retry does the work. A crash between the write and the end of
 * the handler cannot double count: the claim is already there.
 */
@Injectable()
export class InterestEventHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly interests: InterestsService,
    private readonly categories: CourseCategories,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.bus.on("reel.engaged", async (e, { eventId }) => {
      const claimed = await this.redis.set(processedKey(eventId), "1", "EX", PROCESSED_TTL_SEC, "NX");
      if (claimed !== "OK") return;
      try {
        await this.apply(e);
      } catch (err) {
        await this.redis.del(processedKey(eventId));
        throw err;
      }
    });
  }

  private async apply(e: EventOf<"reel.engaged">): Promise<void> {
    const reel = await this.prisma.reel.findUnique({ where: { id: e.reelId }, select: { creatorId: true, hashtags: true, linkedCourseId: true } });
    if (!reel || reel.creatorId === e.userId) return; // a reel that is gone, or the creator's own
    const keys = reel.hashtags.map((tag) => `tag:${tag}`);
    if (reel.linkedCourseId) {
      const category = (await this.categories.ofCourses([reel.linkedCourseId])).get(reel.linkedCourseId);
      if (category) keys.push(`cat:${category}`);
    }
    await this.interests.add(e.userId, keys, ENGAGEMENT_WEIGHT[e.kind], this.clock.now());
  }
}
