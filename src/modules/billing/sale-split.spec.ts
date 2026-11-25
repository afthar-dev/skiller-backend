import { saleLines, splitSale, type SaleLineKind } from "./sale-split";

const base = { listPaise: 100000n, commissionBps: 1000, gstBps: 1800 };

const netByKind = (s: ReturnType<typeof splitSale>) => {
  const out: Record<SaleLineKind, bigint> = { clearing: 0n, seller: 0n, revenue: 0n, tax: 0n };
  for (const l of saleLines(s)) out[l.kind] += l.amountPaise;
  return out;
};

describe("splitSale", () => {
  it("no coupon: 1000 INR at 10% -> seller 90000, fee 10000 split 8475 + 1525", () => {
    expect(splitSale({ ...base, discountPaise: 0n, fundedBy: null })).toEqual({
      totalPaise: 100000n,
      sellerPaise: 90000n,
      feeNetPaise: 8475n,
      feeTaxPaise: 1525n,
      platformDiscountPaise: 0n,
    });
  });

  it("creator-funded 20% off: commission is taken on the discounted price, the seller bears the discount", () => {
    expect(splitSale({ ...base, discountPaise: 20000n, fundedBy: "CREATOR" })).toEqual({
      totalPaise: 80000n,
      sellerPaise: 72000n,
      feeNetPaise: 6780n,
      feeTaxPaise: 1220n,
      platformDiscountPaise: 0n,
    });
  });

  it("platform-funded 10% off (below the 10% commission): seller keeps the LIST share when the buyer paid enough", () => {
    const s = splitSale({ ...base, discountPaise: 5000n, fundedBy: "PLATFORM" });
    expect(s).toEqual({ totalPaise: 95000n, sellerPaise: 90000n, feeNetPaise: 8475n, feeTaxPaise: 1525n, platformDiscountPaise: 5000n });
    expect(netByKind(s)).toEqual({ clearing: -95000n, seller: 90000n, revenue: 8475n - 5000n, tax: 1525n });
  });

  it("MON-1: platform-funded 30% off on a 10% plan never credits the seller more than the buyer paid", () => {
    const s = splitSale({ listPaise: 1_000_000n, discountPaise: 300_000n, fundedBy: "PLATFORM", commissionBps: 1000, gstBps: 1800 });
    expect(s.totalPaise).toBe(700_000n);
    expect(s.sellerPaise).toBe(700_000n);
    expect(s.sellerPaise <= s.totalPaise).toBe(true);
    // platform absorbs only the commission: no cash is left for it, so revenue nets to -tax
    expect(s.platformDiscountPaise).toBe(100_000n);
    expect(saleLines(s).reduce((sum, l) => sum + l.amountPaise, 0n)).toBe(0n);
  });

  it("platform-funded 20% off on a 10% plan: seller capped at what was paid (80000)", () => {
    const s = splitSale({ ...base, discountPaise: 20000n, fundedBy: "PLATFORM" });
    expect(s).toEqual({ totalPaise: 80000n, sellerPaise: 80000n, feeNetPaise: 8475n, feeTaxPaise: 1525n, platformDiscountPaise: 10000n });
    expect(netByKind(s)).toEqual({ clearing: -80000n, seller: 80000n, revenue: 8475n - 10000n, tax: 1525n });
  });

  it("the commission is floored so a remainder stays with the seller", () => {
    // 333 paise at 10%: fee = floor(33.3) = 33
    const s = splitSale({ listPaise: 333n, discountPaise: 0n, fundedBy: null, commissionBps: 1000, gstBps: 1800 });
    expect(s.sellerPaise).toBe(300n);
    expect(s.feeNetPaise + s.feeTaxPaise).toBe(33n);
  });

  it("every combination posts lines that sum to zero", () => {
    let seed = 12345;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let i = 0; i < 2000; i++) {
      const list = BigInt(100 + rnd(10_000_000));
      const fundedBy = (["CREATOR", "PLATFORM", null] as const)[rnd(3)];
      const discount = fundedBy ? BigInt(rnd(Number(list) - 99)) : 0n;
      const s = splitSale({ listPaise: list, discountPaise: discount, fundedBy, commissionBps: rnd(10_001), gstBps: rnd(3000) });
      expect(saleLines(s).reduce((sum, l) => sum + l.amountPaise, 0n)).toBe(0n);
      expect(s.totalPaise).toBe(list - discount);
      expect(s.sellerPaise).toBeGreaterThanOrEqual(0n);
      expect(s.sellerPaise).toBeLessThanOrEqual(s.totalPaise);
    }
  });

  it("rejects a discount above the list price", () => {
    expect(() => splitSale({ ...base, discountPaise: 100001n, fundedBy: "CREATOR" })).toThrow(RangeError);
  });
});
