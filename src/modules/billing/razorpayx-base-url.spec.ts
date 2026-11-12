import "../billing";
import type { AppConfig } from "../../common/config/config.schema";
import { BILLING_CORE_PROVIDERS } from "./billing.module";
import { RAZORPAYX_CLIENT, type RazorpayXClient } from "./razorpayx.client";

describe("RazorpayX client wiring", () => {
  const real = global.fetch;
  afterEach(() => {
    global.fetch = real;
  });

  it("talks to the configured Razorpay base URL, so a stand-in server can answer payouts too", async () => {
    const seen: string[] = [];
    global.fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ id: "cont_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = BILLING_CORE_PROVIDERS.find((p) => typeof p === "object" && "provide" in p && p.provide === RAZORPAYX_CLIENT) as { useFactory: (c: AppConfig) => RazorpayXClient };
    const config = { razorpay: { keyId: "k", keySecret: "s", baseUrl: "http://127.0.0.1:4320/v1" }, razorpayx: { accountNumber: "1" } } as unknown as AppConfig;
    await provider.useFactory(config).createContact({ name: "Asha", referenceId: "USER:u1" });
    expect(seen).toEqual(["http://127.0.0.1:4320/v1/contacts"]);
  });
});
