import { HttpRazorpayXClient } from "./razorpayx.client";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function client(respond: (seen: Seen) => { status?: number; json: unknown }) {
  const calls: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const seen: Seen = { url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(seen);
    const { status = 200, json } = respond(seen);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { calls, x: new HttpRazorpayXClient("rzp_key", "rzp_secret", "2323230000000001", { fetch: fetchFn }) };
}

describe("HttpRazorpayXClient", () => {
  it("authenticates with Basic auth against the Razorpay API base", async () => {
    const { x, calls } = client(() => ({ json: { id: "cont_1" } }));
    await x.createContact({ name: "Asha", referenceId: "USER:u1" });
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/contacts");
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from("rzp_key:rzp_secret").toString("base64")}`);
    expect(calls[0].body).toEqual({ name: "Asha", type: "vendor", reference_id: "USER:u1" });
  });

  it("sends a bank fund account with the full number and a vpa fund account with the address, and refuses an ambiguous one", async () => {
    const { x, calls } = client(() => ({ json: { id: "fa_1", account_type: "bank_account" } }));
    await x.createFundAccount({ contactId: "cont_1", bank: { name: "Asha Rao", ifsc: "HDFC0001234", accountNumber: "50100123456789" } });
    expect(calls[0].body).toEqual({ contact_id: "cont_1", account_type: "bank_account", bank_account: { name: "Asha Rao", ifsc: "HDFC0001234", account_number: "50100123456789" } });
    await x.createFundAccount({ contactId: "cont_1", vpa: { address: "asha@okhdfc" } });
    expect(calls[1].body).toEqual({ contact_id: "cont_1", account_type: "vpa", vpa: { address: "asha@okhdfc" } });
    await expect(x.createFundAccount({ contactId: "cont_1" })).rejects.toThrow(TypeError);
  });

  it("starts a validation from our account number with a Rs 1 penny drop", async () => {
    const { x, calls } = client(() => ({ json: { id: "fav_1", status: "created" } }));
    const v = await x.validateFundAccount({ fundAccountId: "fa_1", referenceId: "acc-1" });
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/fund_accounts/validations");
    expect(calls[0].body).toEqual({ account_number: "2323230000000001", fund_account: { id: "fa_1" }, amount: 100, currency: "INR", reference_id: "acc-1" });
    expect(v).toEqual({ id: "fav_1", fundAccountId: "fa_1", status: "created" });
  });

  it("creates a payout in integer paise with the idempotency header, the reference id and the mode", async () => {
    const { x, calls } = client(() => ({ json: { id: "pout_1", fund_account_id: "fa_1", amount: 99000, mode: "IMPS", reference_id: "p-1", status: "processing", utr: null } }));
    const p = await x.createPayout({ fundAccountId: "fa_1", amountPaise: 99000n, mode: "IMPS", referenceId: "p-1", idempotencyKey: "p-1", narration: "Skiller payout" });
    expect(calls[0].headers["X-Payout-Idempotency"]).toBe("p-1");
    expect(calls[0].body).toMatchObject({ account_number: "2323230000000001", fund_account_id: "fa_1", amount: 99000, currency: "INR", mode: "IMPS", purpose: "payout", reference_id: "p-1" });
    expect(p).toMatchObject({ id: "pout_1", amountPaise: 99000n, referenceId: "p-1", status: "processing" });
    await expect(x.createPayout({ fundAccountId: "fa_1", amountPaise: 0n, mode: "IMPS", referenceId: "p-2", idempotencyKey: "p-2" })).rejects.toThrow(RangeError);
  });

  it("finds a payout by our reference id and returns null when none matches", async () => {
    const { x, calls } = client((s) => ({ json: { items: s.url.includes("reference_id=known") ? [{ id: "pout_9", fund_account_id: "fa_1", amount: 5000, mode: "UPI", reference_id: "known", status: "queued" }] : [] } }));
    expect((await x.findPayoutByReference("known"))?.id).toBe("pout_9");
    expect(await x.findPayoutByReference("other")).toBeNull();
    expect(calls[0].url).toContain("account_number=2323230000000001");
  });

  it("raises RazorpayApiError with the status and code on a failure", async () => {
    const { x } = client(() => ({ status: 400, json: { error: { code: "BAD_REQUEST_ERROR", description: "nope" } } }));
    await expect(x.fetchPayout("pout_1")).rejects.toMatchObject({ name: "RazorpayApiError", status: 400, code: "BAD_REQUEST_ERROR" });
  });
});
