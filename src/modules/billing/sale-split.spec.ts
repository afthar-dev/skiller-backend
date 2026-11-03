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

  it("platform-funded 20% off: buyer pays 80000, seller still gets 90000 of the LIST price, platform revenue absorbs 20000", () => {
    const s = splitSale({ ...base, discountPaise: 20000n, fundedBy: "PLATFORM" });
    expect(s).toEqual({ totalPaise: 80000n, sellerPaise: 90000n, feeNetPaise: 8475n, feeTaxPaise: 1525n, platformDiscountPaise: 20000n });
    const net = netByKind(s);
    expect(net).toEqual({ clearing: -80000n, seller: 90000n, revenue: 8475n - 20000n, tax: 1525n });
    expect(saleLines(s).filter((l) => l.kind === "revenue").map((l) => l.amountPaise)).toEqual([8475n, -20000n]);
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
    }
  });

  it("rejects a discount above the list price", () => {
    expect(() => splitSale({ ...base, discountPaise: 100001n, fundedBy: "CREATOR" })).toThrow(RangeError);
  });
});
