import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ReelPublisher } from "./reel-publisher";

/** A reel waits for its video: it goes live on media.ready and fails on media.failed. Both handlers are idempotent (at-least-once delivery). */
@Injectable()
export class ReelEventHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly publisher: ReelPublisher,
  ) {}

  onModuleInit() {
    this.bus.on("media.ready", async (e, { eventId }) => {
      const reel = await this.prisma.reel.findUnique({ where: { mediaAssetId: e.assetId }, select: { id: true } });
      if (reel) await this.publisher.publish(reel.id, { eventId });
    });
    this.bus.on("media.failed", async (e, { eventId }) => {
      const reel = await this.prisma.reel.findUnique({ where: { mediaAssetId: e.assetId }, select: { id: true, creatorId: true } });
      if (reel) await this.publisher.fail(reel, e.reason, eventId);
    });
  }
}
