import { receiptDate } from "./order-handlers";

describe("receiptDate", () => {
  it("uses the IST day, not the UTC day", () => {
    expect(receiptDate("2026-12-04T19:30:00.000Z")).toBe("2026-12-05");
    expect(receiptDate("2026-12-04T18:29:59.000Z")).toBe("2026-12-04");
  });
});
