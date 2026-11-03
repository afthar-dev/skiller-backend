import { ACCOUNT_NUMBER_PATTERN, IFSC_PATTERN, last4, maskVpa, namesMatch, PAN_PATTERN, panHash, VPA_PATTERN } from "./kyc";

describe("kyc helpers", () => {
  it("masks a UPI id but keeps the handle", () => {
    expect(maskVpa("asha@okhdfc")).toBe("as***@okhdfc");
    expect(maskVpa("a@okhdfc")).toBe("a***@okhdfc");
    expect(maskVpa("garbage")).toBe("***");
  });

  it("hashes a PAN with a key, case-insensitively, and differently per pepper", () => {
    const pepper = "p".repeat(40);
    expect(panHash(pepper, "ABCDE1234F")).toBe(panHash(pepper, "abcde1234f"));
    expect(panHash(pepper, "ABCDE1234F")).not.toBe(panHash(pepper, "ABCDE1234G"));
    expect(panHash(pepper, "ABCDE1234F")).not.toBe(panHash("q".repeat(40), "ABCDE1234F"));
    expect(panHash(pepper, "ABCDE1234F")).not.toContain("ABCDE1234F");
  });

  it("validates PAN, IFSC, account number and UPI id shapes", () => {
    expect(PAN_PATTERN.test("ABCDE1234F")).toBe(true);
    expect(PAN_PATTERN.test("ABCDE12345")).toBe(false);
    expect(IFSC_PATTERN.test("HDFC0001234")).toBe(true);
    expect(IFSC_PATTERN.test("HDFC1001234")).toBe(false);
    expect(ACCOUNT_NUMBER_PATTERN.test("50100123456789")).toBe(true);
    expect(ACCOUNT_NUMBER_PATTERN.test("1234")).toBe(false);
    expect(VPA_PATTERN.test("asha.rao@okhdfc")).toBe(true);
    expect(VPA_PATTERN.test("no-at-sign")).toBe(false);
    expect(last4("50100123456789")).toBe("6789");
  });

  it("matches names loosely", () => {
    expect(namesMatch("Asha Rao", "ASHA RAO")).toBe(true);
    expect(namesMatch("Asha Kumari Rao", "Asha Rao")).toBe(true);
    expect(namesMatch("Asha Rao", "Ravi Rao")).toBe(false);
    expect(namesMatch("", "Asha")).toBe(false);
  });
});
