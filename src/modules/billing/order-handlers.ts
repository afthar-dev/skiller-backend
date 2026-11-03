import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error";
import { EventBus } from "../../common/outbox/event-bus";
import { PrismaService } from "../../common/prisma/prisma.service";
import { NotificationsService } from "../notifications";
import { FulfilmentService } from "./fulfilment.service";
import { fromApi } from "./money";
import { OrdersService } from "./orders.service";
import { WebhookDispatcher, type WebhookEventContext } from "./webhook.dispatcher";

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const paymentOf = (payload: Record<string, unknown>) => asRecord(asRecord(asRecord(payload.payload)?.payment)?.entity);

/** 12345 paise -> "INR 123.45". Integer arithmetic only. */
export const formatInr = (paise: bigint): string => `INR ${paise / 100n}.${(paise % 100n).toString().padStart(2, "0")}`;

/**
 * Wires orders to their inputs: Razorpay payment webhooks (through the dispatcher) and the order.paid outbox event
 * (receipt and new-sale notifications). Delivery is at-least-once, so everything behind these is idempotent.
 */
@Injectable()
export class OrderHandlers implements OnModuleInit {
  private readonly logger = new Logger(OrderHandlers.name);

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly fulfilment: FulfilmentService,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.dispatcher.on("payment.captured", (e) => this.onCaptured(e));
    this.dispatcher.on("payment.failed", (e) => this.onFailed(e));

    this.bus.on("order.paid", async (e, { eventId }) => {
      const amount = formatInr(fromApi(e.totalPaise));
      await this.notifications.notify(e.buyerId, {
        type: "order.receipt",
        title: "Payment received",
        body: `We received your payment of ${amount} for ${e.itemTitle}.`,
        link: `/orders/${e.orderId}`,
        data: { orderId: e.orderId },
        email: { template: "order_receipt", data: { orderId: e.orderId, itemTitle: e.itemTitle, amount, paidOn: e.paidAt.slice(0, 10) } },
        sourceEventId: eventId,
      });
      // Organization sellers have no single recipient yet; their sales show up in the wallet.
      if (e.sellerOwnerType === "USER") {
        await this.notifications.notify(e.sellerOwnerId, {
          type: "order.sale",
          title: "You made a sale",
          body: `New sale: ${e.itemTitle}.`,
          link: `/orders/${e.orderId}`,
          data: { orderId: e.orderId },
          sourceEventId: eventId,
        });
      }
    });
  }

  /**
   * The webhook path trusts the verified webhook for "this payment exists", but fulfilment still fetches the payment from the gateway
   * to check amount and status. Payments we have no order for (subscription charges, other products) are acknowledged, not retried.
   * An authorized-only payment throws so the queue retries it with backoff until it is captured.
   */
  private async onCaptured(event: WebhookEventContext): Promise<void> {
    const payment = paymentOf(event.payload);
    const paymentId = typeof payment?.id === "string" ? payment.id : null;
    const razorpayOrderId = typeof payment?.order_id === "string" ? payment.order_id : null;
    if (!paymentId || !razorpayOrderId) {
      this.logger.log(`webhook ${event.webhookEventId} (payment.captured) has no order reference; ignored`);
      return;
    }
    const order = await this.prisma.order.findUnique({ where: { razorpayOrderId }, select: { id: true } });
    if (!order) {
      this.logger.log(`webhook ${event.webhookEventId}: payment ${paymentId} is for Razorpay order ${razorpayOrderId}, which is not a checkout order; ignored`);
      return;
    }
    try {
      const result = await this.fulfilment.fulfil(order.id, paymentId, "webhook");
      if (result.outcome === "PENDING_CAPTURE") throw new Error(`payment ${paymentId} is not captured yet; retrying`);
    } catch (err) {
      // A 4xx outcome (amount mismatch, payment of another order, ...) is final and already alerted: retrying cannot change it.
      if (err instanceof AppError && err.status < 500) {
        this.logger.warn(`webhook ${event.webhookEventId}: payment ${paymentId} not fulfilled: ${err.code}`);
        return;
      }
      throw err;
    }
  }

  private async onFailed(event: WebhookEventContext): Promise<void> {
    const razorpayOrderId = paymentOf(event.payload)?.order_id;
    if (typeof razorpayOrderId !== "string") return;
    await this.orders.markFailedByRazorpayOrder(razorpayOrderId);
  }
}
