// Public surface of the mail module. Other modules import only from here.
export { MailService } from "./mail.service";
export { MailDelivery } from "./mail-delivery";
export { MailHooks } from "./mail-hooks";
export { ResendApiError } from "./resend.client";
export type { MailOutcome, MailRef, ResendEventNotice } from "./mail-hooks";
export { EmailSuppressions } from "./email-suppressions";
export type { MailCategory, MailData, MailTemplate } from "./mail.types";
export { MailModule } from "./mail.module";
