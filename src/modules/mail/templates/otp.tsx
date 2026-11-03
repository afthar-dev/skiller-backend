import { Text } from "@react-email/components";
import type { MailData } from "../mail.types";
import { Layout } from "./layout";

export const otpSubject = (data: MailData["otp"]) =>
  data.purpose === "LOGIN" ? "Your Skiller sign-in code" : "Your Skiller verification code";

export function Otp({ code, purpose, expiresInMin }: MailData["otp"]) {
  const title = purpose === "LOGIN" ? "Sign in to Skiller" : "Confirm it is you";
  return (
    <Layout preview={`Your code is ${code}`} title={title}>
      <Text>Use this code to continue. It expires in {expiresInMin} minutes.</Text>
      <Text style={{ fontSize: 32, fontWeight: 700, letterSpacing: 6 }}>{code}</Text>
      <Text>If you did not request this code, you can ignore this email.</Text>
    </Layout>
  );
}
