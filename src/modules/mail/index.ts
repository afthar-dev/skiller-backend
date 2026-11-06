// Public surface of the mail module. Other modules import only from here.
export { MailService } from "./mail.service";
export { MailHooks } from "./mail-hooks";
export type { MailOutcome, MailRef, ResendEventNotice } from "./mail-hooks";
export { EmailSuppressions } from "./email-suppressions";
export type { MailCategory, MailData, MailTemplate } from "./mail.types";
export { MailModule } from "./mail.module";
