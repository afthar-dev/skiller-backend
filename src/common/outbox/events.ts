export type DomainEvent =
  | { type: "user.registered"; userId: string; email: string }
  | { type: "user.became_creator"; userId: string }
  | { type: "media.ready"; assetId: string; ownerId: string; purpose: string }
  | { type: "media.failed"; assetId: string; ownerId: string; reason: string; fileName?: string }
  | { type: "org.created"; orgId: string; ownerId: string }
  /** A member lost an organization role (all of them, or one): consumers re-check what the role gave access to. */
  | { type: "org.member_removed"; orgId: string; userId: string }
  | { type: "course.published"; courseId: string; ownerType: "USER" | "ORG"; ownerId: string; slug: string; title: string }
  /** A learner finished every required lesson of a course and passed every quiz in it (emitted once per enrolment). */
  | { type: "course.completed"; userId: string; courseId: string }
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
    }
  | {
      type: "order.refunded";
      orderId: string;
      refundId: string;
      buyerId: string;
      sellerOwnerType: "USER" | "ORG";
      sellerOwnerId: string;
      itemType: string;
      itemId: string;
      itemTitle: string;
      amountPaise: string;
    }
  | {
      /** A seller asked to withdraw: the amount is locked (AVAILABLE -> PAYOUT_LOCKED) and waits for finance. */
      type: "payout.requested";
      payoutId: string;
      ownerType: "USER" | "ORG";
      ownerId: string;
      /** The user who asked (and who is told about every step). */
      requestedBy: string;
      /** Paise as decimal strings (events are JSON). */
      amountPaise: string;
      tdsPaise: string;
      netPaise: string;
    }
  | { type: "payout.approved"; payoutId: string; ownerType: "USER" | "ORG"; ownerId: string; requestedBy: string; amountPaise: string; tdsPaise: string; netPaise: string }
  | { type: "payout.rejected"; payoutId: string; ownerType: "USER" | "ORG"; ownerId: string; requestedBy: string; amountPaise: string; tdsPaise: string; netPaise: string; note: string | null }
  | {
      /** The money reached the bank (RazorpayX payout.processed). */
      type: "payout.settled";
      payoutId: string;
      ownerType: "USER" | "ORG";
      ownerId: string;
      requestedBy: string;
      amountPaise: string;
      tdsPaise: string;
      netPaise: string;
      utr: string | null;
    }
  | {
      /** The payout did not reach the bank, or came back: the funds are in AVAILABLE again. */
      type: "payout.failed";
      payoutId: string;
      ownerType: "USER" | "ORG";
      ownerId: string;
      requestedBy: string;
      amountPaise: string;
      tdsPaise: string;
      netPaise: string;
      outcome: "FAILED" | "REVERSED";
      reason: string;
    }
  | {
      /** An owner's payout account was set or replaced: the owner (USER) or every org_owner (ORG) is told. Carries masked data only. */
      type: "payout_account.changed";
      payoutAccountId: string;
      ownerType: "USER" | "ORG";
      ownerId: string;
      changedBy: string;
      /** ISO instant until which payouts are paused (equal to the change time for a first account). */
      cooldownUntil: string;
      replaced: boolean;
      /** Masked, e.g. "bank account ending 6789" or "UPI id as***@okhdfc". */
      accountSummary: string;
    };

export type DomainEventType = DomainEvent["type"];
export type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;
