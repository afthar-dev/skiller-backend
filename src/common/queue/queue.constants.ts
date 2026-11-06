export const QueueNames = {
  outbox: "outbox",
  mail: "mail",
  // Promotional campaign mail only: its own queue and rate limit, so a campaign can never delay an OTP or a receipt (which stay on `mail`).
  mailPromo: "mail-promo",
  mediaTranscode: "media-transcode",
  mediaLight: "media-light",
  maintenance: "maintenance",
  // Razorpay / RazorpayX webhook processing (and later money jobs): its own queue so slow or retrying payment work never shares concurrency with domain events.
  billing: "billing",
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

export const QUEUE_CONNECTION = Symbol("QUEUE_CONNECTION");

export const queueToken = (name: QueueName) => `QUEUE:${name}`;
