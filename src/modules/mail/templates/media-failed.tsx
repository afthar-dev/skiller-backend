import { Text } from "@react-email/components";
import type { MailData } from "../mail.types";
import { Layout } from "./layout";

export const mediaFailedSubject = (_data: MailData["media_failed"]) => "Your upload could not be processed";

export function MediaFailed({ fileName, reason }: MailData["media_failed"]) {
  return (
    <Layout preview="Your upload could not be processed" title="Upload failed">
      <Text>We could not process {fileName}.</Text>
      <Text>Reason: {reason}</Text>
      <Text>Please check the file and upload it again.</Text>
    </Layout>
  );
}
