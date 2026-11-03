import { documentNumber, financialYear } from "./fiscal-year";

describe("financialYear (April to March, IST)", () => {
  it.each([
    ["2026-04-01T00:00:00+05:30", "26-27"],
    ["2026-03-31T23:59:59+05:30", "25-26"],
    ["2027-03-31T23:59:59+05:30", "26-27"],
    ["2027-03-31T18:30:00Z", "27-28"], // 00:00 IST on 1 April
    ["2027-03-31T18:29:59Z", "26-27"],
    ["2026-12-31T20:00:00Z", "26-27"],
    ["2099-06-01T00:00:00Z", "99-00"],
  ])("%s -> %s", (at, fy) => expect(financialYear(new Date(at))).toBe(fy));

  it("formats document numbers with a six digit sequence and never exceeds the 16 characters GST allows", () => {
    expect(documentNumber("SKL", "26-27", 1)).toBe("SKL/26-27/000001");
    expect(documentNumber("SKC", "26-27", 123456)).toBe("SKC/26-27/123456");
    expect(documentNumber("SKL", "26-27", 1)).toHaveLength(16);
  });
});
