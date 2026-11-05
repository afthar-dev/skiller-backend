import { assertValidPackagePrice, reasonsNotPublishable } from "./gig-rules";

describe("gig package prices", () => {
  it("accept 99 to 10,00,000 rupees in paise, edges included", () => {
    for (const p of [9_900n, 9_901n, 49_900n, 99_999_999n, 100_000_000n]) expect(() => assertValidPackagePrice(p)).not.toThrow();
  });

  it("refuse everything outside it with GIG_PRICE_INVALID", () => {
    for (const p of [0n, 1n, 9_899n, 100_000_001n, 99_999_999_999n]) expect(() => assertValidPackagePrice(p)).toThrow(expect.objectContaining({ code: "GIG_PRICE_INVALID", status: 422 }));
  });
});

describe("gig readiness", () => {
  it("lists what is missing", () => {
    expect(reasonsNotPublishable({ description: "  ", coverAssetId: null }, [])).toEqual([
      expect.objectContaining({ code: "NO_DESCRIPTION" }),
      expect.objectContaining({ code: "NO_BASIC_PACKAGE" }),
      expect.objectContaining({ code: "NO_COVER" }),
    ]);
    expect(reasonsNotPublishable({ description: "x", coverAssetId: "a" }, ["STANDARD"])).toEqual([expect.objectContaining({ code: "NO_BASIC_PACKAGE" })]);
    expect(reasonsNotPublishable({ description: "x", coverAssetId: "a" }, ["BASIC"])).toEqual([]);
  });
});
