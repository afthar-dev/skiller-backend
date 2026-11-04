import { CERTIFICATE_CODE_ALPHABET, CERTIFICATE_CODE_LENGTH, certificateLines, generateCertificateCode, renderCertificatePdf, type CertificateFacts } from "./certificate-document";

const facts: CertificateFacts = {
  code: "AB23CD45EF",
  learnerName: "Asha Verma",
  courseTitle: "Modern TypeScript",
  issuerName: "Skiller Academy",
  issuedAt: "2026-11-04T20:30:00.000Z", // 02:00 on the 5th in India
  verifyUrl: "https://app.skiller.in/certificates/AB23CD45EF",
};

describe("generateCertificateCode", () => {
  it("is 10 characters from the unambiguous alphabet (no 0, 1, I, L, O)", () => {
    expect(CERTIFICATE_CODE_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTUVWXYZ");
    for (let i = 0; i < 500; i++) {
      const code = generateCertificateCode();
      expect(code).toHaveLength(CERTIFICATE_CODE_LENGTH);
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/);
    }
  });

  it("does not repeat (random, not a counter)", () => {
    expect(new Set(Array.from({ length: 300 }, generateCertificateCode)).size).toBe(300);
  });
});

describe("certificateLines", () => {
  it("prints the name, course, issuer, the Indian date, the code and the verify URL", () => {
    const text = certificateLines(facts).join("\n");
    expect(text).toContain("Asha Verma");
    expect(text).toContain("Modern TypeScript");
    expect(text).toContain("Skiller Academy");
    expect(text).toContain("5 November 2026");
    expect(text).toContain("AB23CD45EF");
    expect(text).toContain("https://app.skiller.in/certificates/AB23CD45EF");
  });
});

describe("renderCertificatePdf", () => {
  it("produces a PDF with embedded fonts, also for a Devanagari name", async () => {
    const latin = await renderCertificatePdf(facts);
    expect(latin.subarray(0, 5).toString()).toBe("%PDF-");
    const dev = await renderCertificatePdf({ ...facts, learnerName: "आशा वर्मा", courseTitle: "पायथन Programming" });
    expect(dev.subarray(0, 5).toString()).toBe("%PDF-");
    expect(dev.toString("latin1")).toMatch(/NotoSansDevanagari/);
    expect(dev.toString("latin1")).toMatch(/NotoSans/);
  });
});
