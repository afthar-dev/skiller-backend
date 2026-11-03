import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import type { ReactNode } from "react";

export function Layout({ preview, title, children }: { preview: string; title: string; children: ReactNode }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: "#f6f6f9", fontFamily: "Helvetica, Arial, sans-serif", margin: 0, padding: "24px 0" }}>
        <Container style={{ backgroundColor: "#ffffff", borderRadius: 8, maxWidth: 480, padding: 32 }}>
          <Heading as="h1" style={{ fontSize: 20, margin: "0 0 16px" }}>
            {title}
          </Heading>
          {children}
          <Text style={{ color: "#8a8a94", fontSize: 12, marginTop: 32 }}>Skiller</Text>
        </Container>
      </Body>
    </Html>
  );
}
