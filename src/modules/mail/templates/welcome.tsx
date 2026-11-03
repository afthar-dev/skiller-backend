import { Text } from "@react-email/components";
import type { MailData } from "../mail.types";
import { Layout } from "./layout";

export const welcomeSubject = (_data: MailData["welcome"]) => "Welcome to Skiller";

export function Welcome({ name }: MailData["welcome"]) {
  return (
    <Layout preview="Welcome to Skiller" title={`Welcome, ${name}`}>
      <Text>Your Skiller account is ready. Pick a course and start learning.</Text>
    </Layout>
  );
}
