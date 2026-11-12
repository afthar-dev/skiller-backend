import type { PayoutAccount } from "@prisma/client";
import { toPayoutAccountView } from "./payout-accounts.service";

const row = (over: Partial<PayoutAccount> = {}) =>
  ({
    id: "pa1",
    type: "BANK",
    status: "VERIFIED",
    holderName: "Asha Rao",
    ifsc: "HDFC0001234",
    accountLast4: "6789",
    vpaMasked: null,
    panLast4: "234F",
    panNameMatch: null,
    failureReason: null,
    verifiedAt: null,
    cooldownUntil: new Date("2026-11-13T00:00:00.000Z"),
    createdAt: new Date("2026-11-12T00:00:00.000Z"),
    reviewFlag: null,
    ...over,
  }) as PayoutAccount;

describe("toPayoutAccountView", () => {
  it("says whether payouts are held for review, without exposing the flag's name", () => {
    expect(toPayoutAccountView(row()).underReview).toBe(false);
    const held = toPayoutAccountView(row({ reviewFlag: "DUPLICATE_PAN" }));
    expect(held.underReview).toBe(true);
    expect(JSON.stringify(held)).not.toContain("DUPLICATE_PAN");
  });
});
