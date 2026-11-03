export type MailTemplate = "otp" | "welcome" | "org_invite" | "media_failed";

export type MailCategory = "transactional" | "promotional";

export interface MailData {
  otp: { code: string; purpose: "LOGIN" | "STEP_UP"; expiresInMin: 10 };
  welcome: { name: string };
  org_invite: { orgName: string; inviterName: string; acceptUrl: string };
  media_failed: { fileName: string; reason: string };
}
