import { Hr, Link, Text } from "@react-email/components";
import MarkdownIt from "markdown-it";
import type { MailData } from "../mail.types";
import { Layout } from "./layout";

export const promoCampaignSubject = (data: MailData["promo_campaign"]) => data.subject;

// Same rule as the author-Markdown renderer clients use: no raw HTML, and only http(s), mailto, tel or relative link destinations.
const md = new MarkdownIt({ html: false, linkify: false });
md.validateLink = (url) => {
  if (/^[/\\]{2}/.test(url) || url.startsWith("\\")) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  return scheme ? ["http", "https", "mailto", "tel"].includes(scheme[1].toLowerCase()) : true;
};

/**
 * A promotional campaign: the admin's Markdown body (validated when the campaign was saved, rendered here with raw HTML off) and a footer that is always
 * there and not part of the body, so no text an admin writes can remove the unsubscribe link.
 */
export function PromoCampaign({ subject, bodyMarkdown, unsubscribeUrl }: MailData["promo_campaign"]) {
  return (
    <Layout preview={subject} title={subject}>
      <div dangerouslySetInnerHTML={{ __html: md.render(bodyMarkdown) }} />
      <Hr />
      <Text style={{ color: "#8a8a94", fontSize: 12 }}>
        You are receiving this promotional email because you have a Skiller account. <Link href={unsubscribeUrl}>Unsubscribe</Link> to stop promotional emails: {unsubscribeUrl}
      </Text>
    </Layout>
  );
}
