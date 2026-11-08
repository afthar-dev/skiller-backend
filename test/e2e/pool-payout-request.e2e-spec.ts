import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { REDIS } from "../../src/common/redis/redis.constants";
import { FakeRazorpayClient, FakeRazorpayXClient, RAZORPAY_CLIENT, RAZORPAYX_CLIENT } from "../../src/modules/billing";
import { AccountsService, LedgerService } from "../../src/modules/wallet";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { payoutHelpers, type Session } from "../support/payouts";
import { BURST, pinSmallPool, statuses } from "../support/small-pool";

/**
 * Requesting a payout to a UPI account compares the net amount with the platform's UPI limit. That setting is cached for a minute and
 * read from the database on a miss; it used to be read inside the request's transaction, which holds a connection and the owner's lock.
 * With a small pool, parallel requests each held a connection while waiting for another (P2024, 500).
 */
describe("payout requests with a small connection pool", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let redis: Redis;
  let h: ReturnType<typeof payoutHelpers>;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const fakeX = new FakeRazorpayXClient({ webhookSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  async function fund(userId: string, paise: bigint) {
    const accts = t.app.get(AccountsService);
    await prisma.$transaction(async (tx) => {
      const seller = await accts.ensureSellerAccounts(tx, "USER", userId);
      const clearing = await accts.platformAccount("GATEWAY_CLEARING", tx);
      await t.app.get(LedgerService).post(tx, { refType: "TEST_FUND", refId: randomUUID(), description: "fund", lines: [{ accountId: clearing, amountPaise: -paise }, { accountId: seller.AVAILABLE, amountPaise: paise }] });
    });
  }
  /** A creator with a verified UPI account, money available and a fresh step-up. */
  async function ready(paise = 200_000n): Promise<Session> {
    const s = await h.creatorWithAccount(h.upiBody());
    await fund(s.userId, paise);
    await h.stepUp(s);
    return s;
  }
  const requestPayout = (s: Session, amountPaise: string) => http().post("/v1/wallet/payouts").set(auth(s)).set("Idempotency-Key", randomUUID()).send({ amountPaise });

  beforeAll(async () => {
    pinSmallPool();
    t = await createAuthTestApp({}, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake).overrideProvider(RAZORPAYX_CLIENT).useValue(fakeX));
    prisma = t.app.get(PrismaService);
    redis = t.app.get<Redis>(REDIS);
    h = payoutHelpers(t, prisma, fakeX);
  });
  afterAll(() => t?.close());

  it("parallel UPI payout requests all succeed when the UPI limit is not cached", async () => {
    const owners: Session[] = [];
    for (let i = 0; i < BURST; i++) owners.push(await ready());
    await redis.del("settings:upi_max_payout_paise");
    const res = await Promise.all(owners.map((s) => requestPayout(s, "100000")));
    expect(statuses(res)).toEqual(Array(BURST).fill(201));
  });

  it("the UPI limit still refuses an amount above it", async () => {
    const s = await ready(5_000_000n);
    await prisma.platformSetting.upsert({ where: { key: "upi_max_payout_paise" }, create: { key: "upi_max_payout_paise", value: 150_000 }, update: { value: 150_000 } });
    await redis.del("settings:upi_max_payout_paise");
    try {
      const res = await requestPayout(s, "200000");
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: "PAYOUT_ABOVE_UPI_LIMIT", details: { maxPaise: "150000" } });
      expect((await requestPayout(s, "100000")).status).toBe(201);
    } finally {
      await prisma.platformSetting.deleteMany({ where: { key: "upi_max_payout_paise" } });
      await redis.del("settings:upi_max_payout_paise");
    }
  });
});
