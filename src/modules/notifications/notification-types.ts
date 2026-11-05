/**
 * Registry of notification types and their preference defaults. In-app defaults to on for every type;
 * email defaults to on only for transactional types. OTP mail is not a notification and never goes through here.
 */
export const NOTIFICATION_TYPES = {
  welcome: { transactional: true },
  "media.ready": { transactional: false },
  "media.failed": { transactional: true },
  "role.granted": { transactional: false },
  "subscription.activated": { transactional: true },
  "subscription.payment_failed": { transactional: true },
  "subscription.expired": { transactional: true },
  "order.receipt": { transactional: true },
  "order.sale": { transactional: false },
  "order.fulfilment_failed": { transactional: true },
  "earnings.available": { transactional: false },
  "refund.processed": { transactional: true },
  "refund.rejected": { transactional: true },
  "finance.alert": { transactional: false },
  "payout.requested": { transactional: true },
  "payout.approved": { transactional: true },
  "payout.rejected": { transactional: true },
  "payout.paid": { transactional: true },
  "payout.failed": { transactional: true },
  "payout.review": { transactional: false },
  "payout_account.changed": { transactional: true },
  "course.submitted": { transactional: false },
  "course.approved": { transactional: false },
  "course.rejected": { transactional: false },
  "course.flagged": { transactional: false },
  "course.unflagged": { transactional: false },
  "certificate.issued": { transactional: false },
  "certificate.name_needed": { transactional: false },
  "course.review": { transactional: false },
  "course.review_reply": { transactional: false },
  "course.question": { transactional: false },
  "course.answer": { transactional: false },
  "reel.published": { transactional: false },
  "reel.failed": { transactional: false },
  "reel.limit_reached": { transactional: false },
  "reel.restricted": { transactional: false },
  "reel.like": { transactional: false },
  "reel.comment": { transactional: false },
  "reel.reply": { transactional: false },
  "message.new": { transactional: false },
  "moderation.hidden": { transactional: false },
  "moderation.removed": { transactional: false },
  "moderation.restored": { transactional: false },
  "moderation.strike": { transactional: false },
  "moderation.restricted": { transactional: false },
} as const;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES) as [NotificationType, ...NotificationType[]];

export interface EffectivePreference {
  type: NotificationType;
  inApp: boolean;
  email: boolean;
}

export const defaultPreference = (type: NotificationType): EffectivePreference => ({
  type,
  inApp: true,
  email: NOTIFICATION_TYPES[type].transactional,
});
