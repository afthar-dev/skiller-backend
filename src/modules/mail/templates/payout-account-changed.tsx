import { Text } from "@react-email/components";
import type { MailData } from "../mail.types";
import { Layout } from "./layout";

export const payoutAccountChangedSubject = (data: MailData["payout_account_changed"]) => `The payout account of ${data.ownerLabel} was changed`;

export function PayoutAccountChanged({ ownerLabel, accountSummary, cooldownEnds, replaced }: MailData["payout_account_changed"]) {
  return (
    <Layout preview={`The payout account of ${ownerLabel} was changed`} title="Payout account changed">
      <Text>
        The payout account of {ownerLabel} was {replaced ? "replaced" : "set"}. New account: {accountSummary}.
      </Text>
      <Text>{replaced ? `As a safety measure, payouts are paused until ${cooldownEnds}.` : `Payouts to it can be requested once it is verified.`}</Text>
      <Text>If this was not you or someone you trust, sign in and review your account security now, and contact support before the pause ends.</Text>
    </Layout>
  );
}
