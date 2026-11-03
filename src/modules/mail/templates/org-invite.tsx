import { Button, Text } from "@react-email/components";
import type { MailData } from "../mail.types";
import { Layout } from "./layout";

export const orgInviteSubject = (data: MailData["org_invite"]) => `You are invited to join ${data.orgName} on Skiller`;

export function OrgInvite({ orgName, inviterName, acceptUrl }: MailData["org_invite"]) {
  return (
    <Layout preview={`${inviterName} invited you to ${orgName}`} title={`Join ${orgName}`}>
      <Text>
        {inviterName} invited you to join {orgName} on Skiller.
      </Text>
      <Button href={acceptUrl} style={{ backgroundColor: "#111111", borderRadius: 6, color: "#ffffff", padding: "10px 18px" }}>
        Accept invitation
      </Button>
      <Text>Or open this link: {acceptUrl}</Text>
    </Layout>
  );
}
