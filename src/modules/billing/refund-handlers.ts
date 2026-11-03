import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { EventBus } from "../../common/outbox/event-bus";
import { PrismaService } from "../../common/prisma/prisma.service";
import { NotificationsService } from "../notifications";
import { formatInr, fromApi } from "./money";
import { RefundsService } from "./refunds.service";
import { WebhookDispatcher, type WebhookEventContext } from "./webhook.dispatcher";

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const refundIdOf = (payload: Record<string, unknown>): string | null => {
  const id = asRecord(asRecord(asRecord(payload.payload)?.refund)?.entity)?.id;
  return typeof id === "string" && id ? id : null;
};

/** Wires refunds to their inputs: Razorpay refund webhooks, and the order events that start or announce a refund. All handlers are idempotent. */
@Injectable()
export class RefundHandlers implements OnModuleInit {
  private readonly logger = new Logger(RefundHandlers.name);

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly bus: EventBus,
    private readonly refunds: RefundsService,
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.dispatcher.on("refund.processed", (e) => this.withRefundId(e, (id) => this.refunds.onProcessed(id)));
    this.dispatcher.on("refund.failed", (e) => this.withRefundId(e, (id) => this.refunds.onFailed(id)));
    this.dispatcher.onExhausted("refund.processed", (e, err) => this.giveUp(e, err));
    this.dispatcher.onExhausted("refund.failed", (e, err) => this.giveUp(e, err));

    // A paid order the seller module could not deliver is refunded automatically (the buyer and finance were told by the order handlers).
    this.bus.on("order.fulfilment_failed", async (e) => void (await this.refunds.refundUndelivered(e.orderId)));

    this.bus.on("order.refunded", async (e, { eventId }) => {
      await this.notifications.notify(e.buyerId, {
        type: "refund.processed",
        title: "Refund processed",
        body: `Your refund of ${formatInr(fromApi(e.amountPaise))} for ${e.itemTitle} has been issued. It reaches your account in a few working days.`,
        link: `/orders/${e.orderId}`,
        data: { orderId: e.orderId, refundId: e.refundId },
        sourceEventId: eventId,
      });
    });
  }

  private async withRefundId(event: WebhookEventContext, run: (razorpayRefundId: string) => Promise<void>): Promise<void> {
    const id = refundIdOf(event.payload);
    if (!id) {
      this.logger.warn(`webhook ${event.webhookEventId} (${event.type}) has no refund id; ignored`);
      return;
    }
    await run(id);
  }

  /** Every attempt found the refund id unknown: close the event with a warning instead of leaving it failing forever. */
  private async giveUp(event: WebhookEventContext, err: Error): Promise<void> {
    this.logger.warn(`webhook ${event.webhookEventId} (${event.type}) given up: ${err.message}`);
    await this.prisma.webhookEvent.updateMany({
      where: { id: event.webhookEventId, processedAt: null },
      data: { processedAt: this.clock.now(), lastError: `Gave up after the last attempt, closed unprocessed: ${err.message}`.slice(0, 2000) },
    });
  }
}
