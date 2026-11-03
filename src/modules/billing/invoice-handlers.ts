import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { CreditNoteIssuer } from "./credit-note-issuer";
import { InvoiceIssuer } from "./invoice-issuer";

/**
 * Invoices follow money: one for every paid order (including one whose delivery failed and will be refunded) and one for every
 * subscription charge. Events are at-least-once; issuing is idempotent per order / payment.
 */
@Injectable()
export class InvoiceHandlers implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly issuer: InvoiceIssuer,
    private readonly creditNotes: CreditNoteIssuer,
  ) {}

  onModuleInit() {
    this.bus.on("order.paid", async (e) => void (await this.issuer.issueForOrder(e.orderId)));
    this.bus.on("order.fulfilment_failed", async (e) => void (await this.issuer.issueForOrder(e.orderId)));
    // A processed refund corrects the invoice with a credit note (GST: the tax on the refunded value is no longer payable).
    this.bus.on("order.refunded", async (e) => void (await this.creditNotes.issueForRefund(e.refundId)));
    this.bus.on("subscription.changed", async (e) => {
      if (!e.paymentId) return; // cancellations, expiries and failed renewals carry no payment
      await this.issuer.issueForSubscriptionCharge({ subscriptionId: e.subscriptionId, paymentId: e.paymentId, notifyUserId: e.notifyUserId });
    });
  }
}
