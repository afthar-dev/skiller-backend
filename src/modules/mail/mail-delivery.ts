import { Inject, Injectable } from "@nestjs/common";
import type { MailData, MailTemplate } from "./mail.types";
import { RESEND_CLIENT, type ResendClient } from "./resend.client";
import { renderMail } from "./templates";

/** Promotional mail carries the one-click unsubscribe headers (RFC 8058) next to the footer link in its body. */
function headersFor<T extends MailTemplate>(template: T, data: MailData[T]): Record<string, string> | undefined {
  if (template !== "promo_campaign") return undefined;
  const { unsubscribeUrl } = data as MailData["promo_campaign"];
  return { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

/**
 * Renders a template and hands it to Resend, now. Used by the mail workers only (the transactional `mail` queue and the promotional `mail-promo` queue);
 * everything else queues through MailService. Errors are Resend's own (ResendApiError, network errors) so the caller decides what is worth a retry.
 */
@Injectable()
export class MailDelivery {
  constructor(@Inject(RESEND_CLIENT) private readonly client: ResendClient) {}

  async deliver<T extends MailTemplate>(template: T, to: string, data: MailData[T], opts: { idempotencyKey?: string } = {}): Promise<{ id: string }> {
    const { subject, html, text } = await renderMail(template, data);
    return this.client.send({ to, subject, html, text, headers: headersFor(template, data), idempotencyKey: opts.idempotencyKey });
  }
}
