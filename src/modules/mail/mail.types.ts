export type MailTemplate = "otp" | "welcome" | "org_invite" | "media_failed" | "order_receipt";

export type MailCategory = "transactional" | "promotional";

export interface MailData {
  otp: { code: string; purpose: "LOGIN" | "STEP_UP"; expiresInMin: 10 };
  welcome: { name: string };
  org_invite: { orgName: string; inviterName: string; acceptUrl: string };
  media_failed: { fileName: string; reason: string };
  /** amount is display text (e.g. "INR 800.00"), formatted from integer paise by the sender. */
  order_receipt: { orderId: string; itemTitle: string; amount: string; paidOn: string };
}
