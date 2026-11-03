export type DomainEvent =
  | { type: "user.registered"; userId: string; email: string }
  | { type: "user.became_creator"; userId: string }
  | { type: "media.ready"; assetId: string; ownerId: string; purpose: string }
  | { type: "media.failed"; assetId: string; ownerId: string; reason: string; fileName?: string }
  | { type: "org.created"; orgId: string; ownerId: string }
  | { type: "org.member_invited"; orgId: string; email: string; inviteId: string }
  | { type: "role.granted"; userId: string; roleKey: string; grantedBy: string }
  | { type: "rbac.permissions_changed"; userIds: string[] }
  | {
      type: "subscription.changed";
      subscriptionId: string;
      ownerType: "USER" | "ORG";
      ownerId: string;
      planKey: string;
      planVersionId: string;
      status: string;
      /** What happened, so consumers (notifications, invoices) need not diff states. */
      change: "activated" | "renewed" | "payment_failed" | "cancel_requested" | "cancelled" | "expired" | "plan_changed" | "downgrade_scheduled";
      /** Razorpay payment id when the change is a successful charge (the invoice job keys on it). */
      paymentId?: string;
      /** Who to notify: the owner for USER subscriptions, the org owner/manager for ORG ones. */
      notifyUserId?: string;
    }
  | {
      type: "order.paid";
      orderId: string;
      buyerId: string;
      sellerOwnerType: "USER" | "ORG";
      sellerOwnerId: string;
      itemType: string;
      itemId: string;
      itemTitle: string;
      /** Paise as a decimal string (events are JSON). */
      totalPaise: string;
      currency: string;
      paidAt: string;
    }
  | {
      type: "order.fulfilment_failed";
      orderId: string;
      buyerId: string;
      itemType: string;
      itemId: string;
      itemTitle: string;
      totalPaise: string;
      /** Why the seller module refused: CODE: message. */
      error: string;
    }
  | {
      /** The hold on an order's seller share ended: PENDING moved to AVAILABLE. */
      type: "order.hold_released";
      orderId: string;
      sellerOwnerType: "USER" | "ORG";
      sellerOwnerId: string;
      itemTitle: string;
      /** The seller share moved, paise as a decimal string. */
      amountPaise: string;
    };

export type DomainEventType = DomainEvent["type"];
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;
