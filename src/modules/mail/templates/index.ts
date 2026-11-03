import { convert } from "html-to-text";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MailData, MailTemplate } from "../mail.types";
import { MediaFailed, mediaFailedSubject } from "./media-failed";
import { OrderReceipt, orderReceiptSubject } from "./order-receipt";
import { OrgInvite, orgInviteSubject } from "./org-invite";
import { Otp, otpSubject } from "./otp";
import { Welcome, welcomeSubject } from "./welcome";

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

export async function renderMail<T extends MailTemplate>(template: T, data: MailData[T]): Promise<RenderedMail> {
  const [subject, element] = pick(template, data);
  return { subject, ...renderElement(element) };
}

// @react-email/render dynamic-imports react-dom/server, which breaks under Jest's CJS runtime,
// so we do the same two steps (static markup + html-to-text) directly.
function renderElement(element: ReactElement): { html: string; text: string } {
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">${renderToStaticMarkup(element)}`;
  const text = convert(html, {
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "[data-skip-in-text=true]", format: "skip" },
      { selector: "a", options: { linkBrackets: false } },
    ],
  });
  return { html, text };
}

function pick<T extends MailTemplate>(template: T, data: MailData[T]) {
  switch (template) {
    case "otp": {
      const d = data as MailData["otp"];
      return [otpSubject(d), createElement(Otp, d)] as const;
    }
    case "welcome": {
      const d = data as MailData["welcome"];
      return [welcomeSubject(d), createElement(Welcome, d)] as const;
    }
    case "org_invite": {
      const d = data as MailData["org_invite"];
      return [orgInviteSubject(d), createElement(OrgInvite, d)] as const;
    }
    case "media_failed": {
      const d = data as MailData["media_failed"];
      return [mediaFailedSubject(d), createElement(MediaFailed, d)] as const;
    }
    case "order_receipt": {
      const d = data as MailData["order_receipt"];
      return [orderReceiptSubject(d), createElement(OrderReceipt, d)] as const;
    }
    default:
      throw new Error(`Unknown mail template: ${String(template)}`);
  }
}
