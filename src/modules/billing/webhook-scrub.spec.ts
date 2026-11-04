import { scrubPayoutDetails } from "./webhook-scrub";

describe("scrubPayoutDetails", () => {
  it("cuts bank account numbers, masks UPI ids and PANs anywhere in the payload and keeps the rest", () => {
    const payload = {
      payload: {
        "fund_account.validation": {
          entity: {
            id: "fav_1",
            fund_account: { bank_account: { ifsc: "HDFC0001234", account_number: "50100123456789", name: "Asha Rao" }, vpa: { username: "asha", handle: "okhdfc", address: "asha@okhdfc" } },
            results: [{ pan: "ABCDE1234F" }],
          },
        },
      },
    };
    const text = JSON.stringify(scrubPayoutDetails(payload));
    for (const secret of ["50100123456789", "asha@okhdfc", "ABCDE1234F", '"username":"asha"', '"handle":"okhdfc"']) expect(text).not.toContain(secret);
    expect(text).toContain("****6789");
    expect(text).toContain("as***@okhdfc");
    expect(text).toContain("HDFC0001234");
    expect(text).toContain("fav_1");
  });

  it("masks a vpa that is a plain string or lacks `address`", () => {
    const out = JSON.stringify(scrubPayoutDetails({ vpa: "rahul.k@ybl", other: { vpa: { username: "rahul.k", handle: "ybl" } } }));
    expect(out).not.toContain("rahul.k");
    expect(out).toContain("ra***@ybl");
  });

  it("leaves scalars and null alone and does not mutate its input", () => {
    const input = { a: null, b: 3, c: { account_number: "123456789012" } };
    expect(scrubPayoutDetails(input)).toEqual({ a: null, b: 3, c: { account_number: "****9012" } });
    expect(input.c.account_number).toBe("123456789012");
  });
});
