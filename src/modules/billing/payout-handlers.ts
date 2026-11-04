import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { EventBus } from "../../common/outbox/event-bus";
import { PrismaService } from "../../common/prisma/prisma.service";
import { NotificationsService } from "../notifications";
import { PlatformRoleDirectory } from "../rbac";
import { FinanceAlerts } from "./finance-alerts.service";
import { formatIstDateTime } from "./ist";
import { formatInr, fromApi, fromGatewayAmount } from "./money";
import { PayoutsService, type PayoutWebhookEntity } from "./payouts.service";
import { WebhookDispatcher, type WebhookEventContext } from "./webhook.dispatcher";

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const FAILURE_TEXT: Record<string, string> = {
  BANK_REJECTED: "the bank rejected the payment",
  INVALID_ACCOUNT: "the payout account is not valid for payments",
  PROVIDER_ERROR: "the payment could not be completed",
  MANUAL_REVIEW_RETURNED: "finance checked and the payment did not reach your account",
};

const entityOf = (payload: Record<string, unknown>): PayoutWebhookEntity | null => {
  const entity = asRecord(asRecord(asRecord(payload.payload)?.payout)?.entity);
  const id = text(entity?.id);
  if (!entity || !id) return null;
  return {
    id,
    referenceId: text(entity.reference_id),
    amountPaise: entity.amount === undefined || entity.amount === null ? null : fromGatewayAmount(entity.amount),
    utr: text(entity.utr),
    failureReason: text(entity.failure_reason) ?? text(asRecord(entity.status_details)?.description),
  };
};

/**
 * Wires payouts to their inputs: the RazorpayX payout webhooks (through the dispatcher) and the payout outbox events (notifications).
 * Delivery is at-least-once, so everything behind these is idempotent.
 */
@Injectable()
export class PayoutHandlers implements OnModuleInit {
  private readonly logger = new Logger(PayoutHandlers.name);

  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly bus: EventBus,
    private readonly payouts: PayoutsService,
    private readonly notifications: NotificationsService,
    private readonly alerts: FinanceAlerts,
    private readonly prisma: PrismaService,
    private readonly roleDirectory: PlatformRoleDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.dispatcher.on("payout.processed", (e) => this.withEntity(e, (entity) => this.payouts.onProcessed(entity)));
    this.dispatcher.on("payout.reversed", (e) => this.withEntity(e, (entity) => this.payouts.onReturned(entity, "reversed")));
    this.dispatcher.on("payout.failed", (e) => this.withEntity(e, (entity) => this.payouts.onReturned(entity, "failed")));
    this.dispatcher.on("payout.rejected", (e) => this.withEntity(e, (entity) => this.payouts.onReturned(entity, "rejected")));
    for (const type of ["payout.processed", "payout.reversed", "payout.failed", "payout.rejected"]) this.dispatcher.onExhausted(type, (e, err) => this.giveUp(e, err));

    this.bus.on("payout_account.changed", async (e, { eventId }) => {
      let recipients: string[];
      let ownerLabel = "your account";
      if (e.ownerType === "USER") recipients = [e.ownerId];
      else {
        recipients = await this.roleDirectory.userIdsWithRoleInOrg("org_owner", e.ownerId);
        const org = await this.prisma.organization.findUnique({ where: { id: e.ownerId }, select: { name: true } });
        ownerLabel = org?.name ?? "your organization";
      }
      const until = new Date(e.cooldownUntil);
      const cooldownEnds = formatIstDateTime(until);
      const body = e.replaced
        ? `The payout account of ${ownerLabel} was replaced (${e.accountSummary}). Payouts are paused for 24 hours, until ${cooldownEnds}. If this was not you, contact support right away.`
        : `A payout account was added for ${ownerLabel} (${e.accountSummary}). If this was not you, contact support right away.`;
      for (const userId of recipients) {
        await this.notifications.notify(userId, {
          type: "payout_account.changed",
          title: e.replaced ? "Payout account replaced" : "Payout account added",
          body,
          link: e.ownerType === "USER" ? "/wallet" : undefined,
          data: { payoutAccountId: e.payoutAccountId, cooldownUntil: e.cooldownUntil, ownerType: e.ownerType, ownerId: e.ownerId, changedBy: e.changedBy },
          email: { template: "payout_account_changed", data: { ownerLabel, accountSummary: e.accountSummary, cooldownEnds, replaced: e.replaced } },
          sourceEventId: eventId,
        });
      }
    });
    this.bus.on("payout.requested", async (e, { eventId }) => {
      const amount = formatInr(fromApi(e.amountPaise));
      await this.notifications.notify(e.requestedBy, {
        type: "payout.requested",
        title: "Payout requested",
        body: `Your payout of ${amount} is waiting for approval.`,
        link: "/wallet",
        data: { payoutId: e.payoutId },
        sourceEventId: eventId,
      });
      await this.alerts.broadcast({
        type: "payout.review",
        title: "Payout awaiting approval",
        body: `A payout of ${amount} (${e.ownerType} ${e.ownerId}) needs approval.`,
        link: "/admin/payouts?status=REQUESTED",
        data: { payoutId: e.payoutId },
        sourceKey: `payout-requested:${e.payoutId}`,
      });
    });
    this.bus.on("payout.approved", async (e, { eventId }) => {
      await this.notifications.notify(e.requestedBy, {
        type: "payout.approved",
        title: "Payout approved",
        body: `Your payout of ${formatInr(fromApi(e.amountPaise))} was approved and is on its way.`,
        link: "/wallet",
        data: { payoutId: e.payoutId },
        sourceEventId: eventId,
      });
    });
    this.bus.on("payout.rejected", async (e, { eventId }) => {
      await this.notifications.notify(e.requestedBy, {
        type: "payout.rejected",
        title: "Payout declined",
        body: `Your payout of ${formatInr(fromApi(e.amountPaise))} was declined${e.note === "PAYOUT_ACCOUNT_CHANGED" ? " because your payout account changed after you asked. Please request it again" : e.note ? `: ${e.note}` : ""}. The money is back in your available balance.`,
        link: "/wallet",
        data: { payoutId: e.payoutId },
        sourceEventId: eventId,
      });
    });
    this.bus.on("payout.settled", async (e, { eventId }) => {
      const tds = fromApi(e.tdsPaise);
      await this.notifications.notify(e.requestedBy, {
        type: "payout.paid",
        title: "Payout sent",
        body: `${formatInr(fromApi(e.netPaise))} has been sent to your account${tds > 0n ? ` (after ${formatInr(tds)} tax deducted)` : ""}.${e.utr ? ` Reference: ${e.utr}.` : ""}`,
        link: "/wallet",
        data: { payoutId: e.payoutId },
        sourceEventId: eventId,
      });
    });
    this.bus.on("payout.failed", async (e, { eventId }) => {
      await this.notifications.notify(e.requestedBy, {
        type: "payout.failed",
        title: e.outcome === "REVERSED" ? "Payout returned" : "Payout failed",
        body: `Your payout of ${formatInr(fromApi(e.amountPaise))} ${e.outcome === "REVERSED" ? "was returned by the bank" : "could not be completed"} (${FAILURE_TEXT[e.reason] ?? FAILURE_TEXT.PROVIDER_ERROR}). The money is back in your available balance.`,
        link: "/wallet",
        data: { payoutId: e.payoutId },
        sourceEventId: eventId,
      });
    });
  }

  private async withEntity(event: WebhookEventContext, run: (entity: PayoutWebhookEntity) => Promise<void>): Promise<void> {
    // Only the RazorpayX endpoint (its own secret) may move payout money; the same type from the Razorpay endpoint is ignored.
    if (event.provider !== "RAZORPAYX") {
      this.logger.warn(`webhook ${event.webhookEventId} (${event.type}) came from ${event.provider}, not RAZORPAYX; ignored`);
      return;
    }
    const entity = entityOf(event.payload);
    if (!entity) {
      this.logger.warn(`webhook ${event.webhookEventId} (${event.type}) has no payout id; ignored`);
      return;
    }
    await run(entity);
  }

  /**
   * Every attempt failed. A payout id we never matched means money may have left outside Skiller (a payout made from the RazorpayX dashboard):
   * close the event and tell finance. Any other persistent failure leaves the event unprocessed for replay, and finance is told as well.
   */
  private async giveUp(event: WebhookEventContext, err: Error): Promise<void> {
    let entity: PayoutWebhookEntity | null = null;
    try {
      entity = entityOf(event.payload);
    } catch {
      entity = null;
    }
    const unmatched = /^unknown payout/i.test(err.message);
    this.logger.warn(`webhook ${event.webhookEventId} (${event.type}) given up: ${err.message}`);
    if (unmatched) {
      await this.prisma.webhookEvent.updateMany({
        where: { id: event.webhookEventId, processedAt: null },
        data: { processedAt: this.clock.now(), lastError: `Gave up after the last attempt, closed unprocessed: ${err.message}`.slice(0, 2000) },
      });
    }
    await this.alerts.raise({
      kind: unmatched ? "PAYOUT_UNMATCHED" : "PAYOUT_WEBHOOK_FAILED",
      message: unmatched
        ? `RazorpayX reported ${event.type} for payout ${entity?.id ?? "(no id)"}, but no payout of ours matches it. Money may have been paid outside Skiller (for example from the RazorpayX dashboard): reconcile it by hand.`
        : `The ${event.type} webhook for payout ${entity?.id ?? "(no id)"} could not be processed after repeated attempts: ${err.message}`,
      dedupeKey: `payout-webhook:${event.webhookEventId}`,
      link: "/admin/payouts",
      data: { razorpayxPayoutId: entity?.id ?? null, webhookEventId: event.webhookEventId },
    });
  }
}
