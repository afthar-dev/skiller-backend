import { renderMail } from "./index";
import { mailSafeName } from "./safe-name";

const evil = "Skiller Security: verify your payout account at https://skiller-verify.in/pay or www.evil.example now";

describe("org_invite mail with attacker-chosen names", () => {
  const data = { orgName: evil, inviterName: "Bob <b>admin@skiller-verify.in</b> http://x.co", acceptUrl: "https://skiller.in/org-invites/accept?token=abc" };

  it("renders no URL, domain or address from the names, in subject, html or text; the accept link is untouched", async () => {
    const mail = await renderMail("org_invite", data);
    for (const body of [mail.subject, mail.html, mail.text]) {
      expect(body).not.toMatch(/evil\.example|skiller-verify|x\.co|admin@/i);
    }
    expect(mail.html).toContain("https://skiller.in/org-invites/accept?token=abc");
  });

  it("caps the length", async () => {
    const mail = await renderMail("org_invite", { ...data, orgName: "A".repeat(500), inviterName: "B".repeat(500) });
    expect(mail.subject.length).toBeLessThan(120);
    expect(mail.text).not.toContain("A".repeat(61));
  });
});

describe("mailSafeName", () => {
  it("strips URLs, bare domains and addresses, collapses whitespace, caps length, falls back when nothing is left", () => {
    expect(mailSafeName("  Acme   Academy ", "x")).toBe("Acme Academy");
    expect(mailSafeName("Acme https://a.b/c", "x")).toBe("Acme");
    expect(mailSafeName("pay at skiller-verify.in", "x")).toBe("pay at");
    expect(mailSafeName("https://evil.example", "an organization")).toBe("an organization");
    expect(mailSafeName("x".repeat(100), "f")).toHaveLength(60);
    expect(mailSafeName("Dr. Smith & Co. Ltd", "f")).toBe("Dr. Smith & Co. Ltd");
  });
});
