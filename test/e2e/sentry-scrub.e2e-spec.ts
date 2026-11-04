import * as Sentry from "@sentry/nestjs";
import { initSentry } from "../../src/common/observability/sentry";
import { FakeRazorpayXClient, RAZORPAYX_CLIENT, RazorpayApiError } from "../../src/modules/billing";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { createAuthTestApp, type AuthTestApp } from "../support/auth-app";
import { payoutHelpers, randomAccountNumber, randomPan } from "../support/payouts";

describe("Sentry never receives request bodies or payout details", () => {
  let t: AuthTestApp;
  let h: ReturnType<typeof payoutHelpers>;
  const fakeX = new FakeRazorpayXClient({ webhookSecret: "razorpayx-webhook-secret-for-tests" });
  const sent: string[] = [];

  beforeAll(async () => {
    initSentry({
      dsn: "https://public@o0.ingest.sentry.io/1",
      environment: "test",
      transport: () => ({
        send: async (envelope) => {
          sent.push(JSON.stringify(envelope));
          return {};
        },
        flush: async () => true,
      }),
    });
    t = await createAuthTestApp({}, (b) => b.overrideProvider(RAZORPAYX_CLIENT).useValue(fakeX));
    h = payoutHelpers(t, t.app.get(PrismaService), fakeX);
  });
  afterAll(async () => {
    await Sentry.close(1000);
    await t?.close();
  });

  it("a 502 on PUT /v1/wallet/payout-account is reported without body, headers, PAN or account number", async () => {
    const s = await h.creator();
    await h.stepUp(s);
    const accountNumber = randomAccountNumber();
    const pan = randomPan();
    // What the SDK's HTTP integration records for an incoming request (body, cookies, headers, query string).
    const url = "http://localhost/v1/wallet/payout-account";
    Sentry.getGlobalScope().setSDKProcessingMetadata({
      normalizedRequest: {
        method: "PUT",
        url,
        query_string: `pan=${pan}`,
        headers: { authorization: `Bearer ${s.accessToken}`, cookie: "skiller_rt=secret-refresh-token" },
        cookies: { skiller_rt: "secret-refresh-token" },
        data: JSON.stringify(h.bankBody({ accountNumber, pan })),
      },
    });
    fakeX.failNext.set("createContact", new RazorpayApiError(503, "SERVER_ERROR", `down while creating ${accountNumber}`));
    const res = await h.putAccount(s, h.bankBody({ accountNumber, pan }));
    expect(res.status).toBe(502);
    await Sentry.flush(2000);

    expect(sent.length).toBeGreaterThan(0);
    const all = sent.join("\n");
    expect(all).toContain("PUT");
    expect(all).toContain("/v1/wallet/payout-account");
    for (const secret of [accountNumber, pan, s.accessToken, "secret-refresh-token"]) expect(all).not.toContain(secret);
    Sentry.getGlobalScope().setSDKProcessingMetadata({ normalizedRequest: undefined });
  });
});
