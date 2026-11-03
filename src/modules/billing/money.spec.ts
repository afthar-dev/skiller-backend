import { fromApi, gstSplit, splitBps, toApi } from "./money";

describe("splitBps", () => {
  it("10% of 100000 paise is 10000", () => {
    expect(splitBps(100000n, 1000)).toEqual({ part: 10000n, rest: 90000n });
  });
  it("rounds half-up on the part", () => {
    expect(splitBps(1n, 1000)).toEqual({ part: 0n, rest: 1n });
    expect(splitBps(5n, 1000)).toEqual({ part: 1n, rest: 4n }); // 0.5 -> 1
    expect(splitBps(4n, 1000)).toEqual({ part: 0n, rest: 4n }); // 0.4 -> 0
    expect(splitBps(15n, 1000)).toEqual({ part: 2n, rest: 13n }); // 1.5 -> 2
  });
  it("part + rest always equals the amount", () => {
    for (const amount of [0n, 1n, 7n, 99999n, 123456789012345678n]) {
      for (const bps of [0, 1, 500, 700, 1000, 3333, 10000]) {
        const { part, rest } = splitBps(amount, bps);
        expect(part + rest).toBe(amount);
        expect(part >= 0n && rest >= 0n).toBe(true);
      }
    }
  });
  it("rejects negative amounts and invalid bps", () => {
    expect(() => splitBps(-1n, 1000)).toThrow(RangeError);
    expect(() => splitBps(100n, -1)).toThrow(RangeError);
    expect(() => splitBps(100n, 10001)).toThrow(RangeError);
    expect(() => splitBps(100n, 10.5)).toThrow(RangeError);
  });
});

describe("gstSplit", () => {
  it("splits a GST-inclusive fee: 10000 at 18% is net 8475 + tax 1525", () => {
    expect(gstSplit(10000n, 1800)).toEqual({ net: 8475n, tax: 1525n });
  });
  it("net + tax equals the fee; zero rate leaves everything as net", () => {
    expect(gstSplit(1n, 1800)).toEqual({ net: 1n, tax: 0n });
    expect(gstSplit(12345n, 0)).toEqual({ net: 12345n, tax: 0n });
    for (const fee of [0n, 1n, 59n, 99900n, 299900n]) {
      const { net, tax } = gstSplit(fee, 1800);
      expect(net + tax).toBe(fee);
    }
  });
  it("rejects negative fees and invalid rates", () => {
    expect(() => gstSplit(-1n, 1800)).toThrow(RangeError);
    expect(() => gstSplit(100n, -1)).toThrow(RangeError);
    expect(() => gstSplit(100n, 1.5)).toThrow(RangeError);
  });
});

describe("toApi / fromApi", () => {
  it("round-trips decimal strings", () => {
    expect(toApi(123400n)).toBe("123400");
    expect(toApi(-5n)).toBe("-5");
    expect(fromApi("123400")).toBe(123400n);
    expect(fromApi("0")).toBe(0n);
    expect(fromApi(toApi(9007199254740993n))).toBe(9007199254740993n);
  });
  it("rejects anything that is not a plain integer string", () => {
    for (const bad of ["1.5", "1.0", "", " 1", "1 ", "1e3", "0x10", "+5", "abc", "1_000", "-", "007", "-0"]) {
      expect(() => fromApi(bad)).toThrow(RangeError);
    }
    expect(() => fromApi(5 as unknown as string)).toThrow(RangeError);
  });
  it("rejects negatives unless allowed", () => {
    expect(() => fromApi("-5")).toThrow(RangeError);
    expect(fromApi("-5", { allowNegative: true })).toBe(-5n);
  });
});
