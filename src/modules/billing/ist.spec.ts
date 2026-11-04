import { addDays, istDateOf, istDayRange, previousIstDay } from "./ist";

describe("IST days", () => {
  it("an IST day runs from 18:30 UTC the evening before", () => {
    const { from, to } = istDayRange("2026-11-04");
    expect(from.toISOString()).toBe("2026-11-03T18:30:00.000Z");
    expect(to.toISOString()).toBe("2026-11-04T18:30:00.000Z");
  });
  it("names the IST date of an instant on both sides of the boundary", () => {
    expect(istDateOf(new Date("2026-11-03T18:29:59.999Z"))).toBe("2026-11-03");
    expect(istDateOf(new Date("2026-11-03T18:30:00.000Z"))).toBe("2026-11-04");
  });
  it("the 02:00 IST run reconciles the previous day", () => {
    expect(previousIstDay(new Date("2026-11-03T20:30:00.000Z"))).toBe("2026-11-03"); // 02:00 IST on the 4th
    expect(previousIstDay(new Date("2026-02-28T20:30:00.000Z"))).toBe("2026-02-28");
  });
  it("adds days across months and rejects non-dates", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => istDayRange("2026-02-30")).toThrow(RangeError);
    expect(() => istDayRange("11/04/2026")).toThrow(RangeError);
  });
});
