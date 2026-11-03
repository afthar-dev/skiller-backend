import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { EventBus } from "../../common/outbox/event-bus";
import { PrismaService } from "../../common/prisma/prisma.service";
import { NotificationsService } from "../notifications";
import { formatInr, fromApi } from "./money";
import { FinanceAlerts } from "./finance-alerts.service";
import { RefundsService, type RefundWebhookEntity } from "./refunds.service";
import { WebhookDispatcher, type WebhookEventContext } from "./webhook.dispatcher";

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const entityOf = (payload: Record<string, unknown>): RefundWebhookEntity | null => {
  const entity = asRecord(asRecord(asRecord(payload.payload)?.refund)?.entity);
  const id = entity?.id;
  if (typeof id !== "string" || !id) return null;
  const notes = asRecord(entity?.notes);
  return {
    id,
    paymentId: typeof entity?.payment_id === "string" ? entity.payment_id : null,
    refundIdNote: typeof notes?.refundId === "string" ? notes.refundId : null,
  };
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
    private readonly alerts: FinanceAlerts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.dispatcher.on("refund.processed", (e) => this.withEntity(e, (entity) => this.refunds.onProcessed(entity)));
    this.dispatcher.on("refund.failed", (e) => this.withEntity(e, (entity) => this.refunds.onFailed(entity)));
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

  private async withEntity(event: WebhookEventContext, run: (entity: RefundWebhookEntity) => Promise<void>): Promise<void> {
    const entity = entityOf(event.payload);
    if (!entity) {
      this.logger.warn(`webhook ${event.webhookEventId} (${event.type}) has no refund id; ignored`);
      return;
    }
    await run(entity);
  }

  /**
   * Every attempt failed. A refund id we never matched means money may have left (a refund made from the Razorpay dashboard, or one whose
   * record was lost) while the ledger and the order still say PAID: close the event and tell finance (alert + Sentry). Any other
   * persistent failure leaves the event unprocessed for replay, and finance is told as well.
   */
  private async giveUp(event: WebhookEventContext, err: Error): Promise<void> {
    const entity = entityOf(event.payload);
    const unmatched = /^unknown refund/i.test(err.message);
    this.logger.warn(`webhook ${event.webhookEventId} (${event.type}) given up: ${err.message}`);
    if (unmatched) {
      await this.prisma.webhookEvent.updateMany({
        where: { id: event.webhookEventId, processedAt: null },
        data: { processedAt: this.clock.now(), lastError: `Gave up after the last attempt, closed unprocessed: ${err.message}`.slice(0, 2000) },
      });
    }
    const order = entity?.paymentId ? await this.prisma.order.findUnique({ where: { razorpayPaymentId: entity.paymentId }, select: { id: true } }) : null;
    await this.alerts.raise({
      kind: unmatched ? "REFUND_UNMATCHED" : "REFUND_WEBHOOK_FAILED",
      ...(order ? { orderId: order.id } : {}),
      message: unmatched
        ? `Razorpay reported ${event.type} for refund ${entity?.id ?? "(no id)"}${entity?.paymentId ? ` on payment ${entity.paymentId}` : ""}, but no refund of ours matches it. Money may have been refunded outside Skiller (for example from the Razorpay dashboard): reconcile the order and the ledger by hand.`
        : `The ${event.type} webhook for refund ${entity?.id ?? "(no id)"} could not be processed after repeated attempts: ${err.message}`,
      dedupeKey: `refund-webhook:${event.webhookEventId}`,
      data: { razorpayRefundId: entity?.id ?? null, paymentId: entity?.paymentId ?? null, webhookEventId: event.webhookEventId },
    });
  }
}
