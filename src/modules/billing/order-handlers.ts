import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { istDateOf } from "../../common/clock/ist";
import { AppError } from "../../common/errors/app-error";
import { EventBus } from "../../common/outbox/event-bus";
import { PrismaService } from "../../common/prisma/prisma.service";
import { NotificationsService } from "../notifications";
import { FinanceAlerts } from "./finance-alerts.service";
import { FulfilmentService } from "./fulfilment.service";
import { formatInr, fromApi } from "./money";
import { OrdersService } from "./orders.service";
import { WebhookDispatcher, type WebhookEventContext } from "./webhook.dispatcher";

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const paymentOf = (payload: Record<string, unknown>) => asRecord(asRecord(asRecord(payload.payload)?.payment)?.entity);

const FINAL_CODES = new Set(["PAYMENT_AMOUNT_MISMATCH", "PAYMENT_ORDER_MISMATCH", "PAYMENT_NOT_CAPTURED", "PAYMENT_NOT_FOUND", "ORDER_NOT_FOUND"]);

/**
 * Wires orders to their inputs: Razorpay payment webhooks (through the dispatcher) and the order.paid outbox event
 * (receipt and new-sale notifications). Delivery is at-least-once, so everything behind these is idempotent.
 */
/** The IST calendar day of an ISO instant, as printed on the receipt (the invoice uses IST too). */
export const receiptDate = (paidAtIso: string): string => istDateOf(new Date(paidAtIso));

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
    private readonly alerts: FinanceAlerts,
  ) {}

  onModuleInit() {
    this.dispatcher.on("payment.captured", (e) => this.onCaptured(e));
    this.dispatcher.on("payment.failed", (e) => this.onFailed(e));
    this.dispatcher.onExhausted("payment.captured", (e, err) => this.onCapturedExhausted(e, err));

    // The seller module permanently refused to deliver a paid order: tell the buyer and finance (a refund follows).
    this.bus.on("order.fulfilment_failed", async (e, { eventId }) => {
      await this.notifications.notify(e.buyerId, {
        type: "order.fulfilment_failed",
        title: "We could not deliver your purchase",
        body: `We could not deliver ${e.itemTitle}; a refund is on its way.`,
        link: `/orders/${e.orderId}`,
        data: { orderId: e.orderId },
        sourceEventId: eventId,
      });
      await this.alerts.raise({
        kind: "FULFILMENT_FAILED",
        orderId: e.orderId,
        message: `Order ${e.orderId} is paid but could not be delivered (${e.error}). An automatic refund has been started; check it completes.`,
        dedupeKey: `fulfilment-failed:${e.orderId}`,
        data: { error: e.error },
      });
    });

    // The hold ended: the seller can now withdraw this order's earnings. Organization sellers have no single recipient yet.
    this.bus.on("order.hold_released", async (e, { eventId }) => {
      if (e.sellerOwnerType !== "USER") return;
      await this.notifications.notify(e.sellerOwnerId, {
        type: "earnings.available",
        title: "Earnings available",
        body: `${formatInr(fromApi(e.amountPaise))} from ${e.itemTitle} is now available to withdraw.`,
        link: "/wallet",
        data: { orderId: e.orderId },
        sourceEventId: eventId,
      });
    });

    this.bus.on("order.paid", async (e, { eventId }) => {
      const amount = formatInr(fromApi(e.totalPaise));
      await this.notifications.notify(e.buyerId, {
        type: "order.receipt",
        title: "Payment received",
        body: `We received your payment of ${amount} for ${e.itemTitle}.`,
        link: `/orders/${e.orderId}`,
        data: { orderId: e.orderId },
        email: { template: "order_receipt", data: { orderId: e.orderId, itemTitle: e.itemTitle, amount, paidOn: receiptDate(e.paidAt) } },
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
      // Only these outcomes are final (already alerted, or harmless): retrying cannot change them. Anything else, including a 4xx from the
      // seller module, is handled inside fulfilment or retried.
      if (err instanceof AppError && FINAL_CODES.has(err.code)) {
        this.logger.warn(`webhook ${event.webhookEventId}: payment ${paymentId} not fulfilled: ${err.code}`);
        return;
      }
      throw err;
    }
  }

  /** Every retry failed: the buyer has paid and nothing was delivered. A human must look. */
  private async onCapturedExhausted(event: WebhookEventContext, err: Error): Promise<void> {
    const payment = paymentOf(event.payload);
    const razorpayOrderId = typeof payment?.order_id === "string" ? payment.order_id : null;
    const paymentId = typeof payment?.id === "string" ? payment.id : null;
    if (!razorpayOrderId) return;
    const order = await this.prisma.order.findUnique({ where: { razorpayOrderId }, select: { id: true, status: true } });
    if (!order || order.status === "PAID") return;
    await this.alerts.raise({
      kind: "FULFILMENT_FAILED",
      orderId: order.id,
      message: `Payment ${paymentId} was captured but order ${order.id} could not be fulfilled after repeated retries: ${err.message}`,
      dedupeKey: `fulfilment-exhausted:${order.id}`,
      data: { paymentId },
    });
  }

  private async onFailed(event: WebhookEventContext): Promise<void> {
    const razorpayOrderId = paymentOf(event.payload)?.order_id;
    if (typeof razorpayOrderId !== "string") return;
    await this.orders.markFailedByRazorpayOrder(razorpayOrderId);
  }
}
