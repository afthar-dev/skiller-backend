import { financialYear, invoiceNumber } from "./fiscal-year";

describe("financialYear (April to March, IST)", () => {
  it.each([
    ["2026-04-01T00:00:00+05:30", "2026-27"],
    ["2026-03-31T23:59:59+05:30", "2025-26"],
    ["2027-03-31T23:59:59+05:30", "2026-27"],
    ["2027-03-31T18:30:00Z", "2027-28"], // 00:00 IST on 1 April
    ["2027-03-31T18:29:59Z", "2026-27"],
    ["2026-12-31T20:00:00Z", "2026-27"],
    ["2099-06-01T00:00:00Z", "2099-00"],
  ])("%s -> %s", (at, fy) => expect(financialYear(new Date(at))).toBe(fy));

  it("formats the invoice number with a six digit sequence", () => {
    expect(invoiceNumber("2026-27", 1)).toBe("SKL/2026-27/000001");
    expect(invoiceNumber("2026-27", 123456)).toBe("SKL/2026-27/123456");
  });
});
