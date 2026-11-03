import { Injectable, OnModuleInit } from "@nestjs/common";
import { EventBus } from "../../common/outbox/event-bus";
import { SubscriptionsService } from "./subscriptions.service";
import { WebhookDispatcher } from "./webhook.dispatcher";

/**
 * Wires subscriptions to their two inputs: Razorpay subscription webhooks (via the dispatcher) and outbox events.
 * Everything behind these is idempotent (delivery is at-least-once).
 */
@Injectable()
export class SubscriptionHandlers implements OnModuleInit {
  constructor(
    private readonly dispatcher: WebhookDispatcher,
    private readonly bus: EventBus,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  onModuleInit() {
    this.dispatcher.on("subscription.activated", (e) => this.subscriptions.onCharged(e));
    this.dispatcher.on("subscription.charged", (e) => this.subscriptions.onCharged(e));
    this.dispatcher.on("subscription.halted", (e) => this.subscriptions.onPaymentFailed(e));
    this.dispatcher.on("subscription.pending", (e) => this.subscriptions.onPaymentFailed(e));
    this.dispatcher.on("subscription.cancelled", (e) => this.subscriptions.onCancelled(e));
    this.dispatcher.on("subscription.completed", (e) => this.subscriptions.onCompleted(e));

    // Every creator and organization starts on a Free subscription row.
    this.bus.on("user.became_creator", (e) => this.subscriptions.ensureFreeFor({ ownerType: "USER", ownerId: e.userId }));
    this.bus.on("org.created", (e) => this.subscriptions.ensureFreeFor({ ownerType: "ORG", ownerId: e.orgId }));
    this.bus.on("subscription.changed", (e, meta) => this.subscriptions.onChanged(e, meta.eventId));
  }
}
