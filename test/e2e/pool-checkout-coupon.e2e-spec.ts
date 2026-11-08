import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { REDIS } from "../../src/common/redis/redis.constants";
import { CouponsService, EntitlementsService, FakeRazorpayClient, RAZORPAY_CLIENT } from "../../src/modules/billing";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { givePlan } from "../support/billing";
import { BURST, pinSmallPool, statuses } from "../support/small-pool";
import { createTestItem, TestItemProvider } from "../support/test-item";

/**
 * A checkout with a creator-funded coupon asks whether the seller's plan still includes creator coupons, while the transaction that holds
 * the coupon's row lock is open. The plan is normally served from Redis, but whenever it is not (expired entry, Redis unavailable) that
 * is a database read, and it used to happen inside the transaction: a second pooled connection while the first is held. With a small
 * pool and parallel checkouts, every connection was held and nobody could get another (P2024, 500).
 */
describe("checkout with a creator coupon on a small connection pool", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let redis: Redis;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  afterEach(() => jest.restoreAllMocks());

  /** Plan reads fall through to Postgres, as when the cached entries expired or Redis is unavailable. */
  function planCacheUnavailable() {
    const original = redis.get.bind(redis) as (key: string) => Promise<string | null>;
    jest.spyOn(redis, "get").mockImplementation(((key: string) => (key.startsWith("ent:") ? Promise.reject(new Error("redis unavailable")) : original(key))) as never);
  }

  /** A Pro seller with an item and a creator-funded 10% coupon on their items. */
  async function listing(plan = "pro") {
    const seller = await t.login();
    await givePlan(prisma, "USER", seller.userId, plan);
    await t.app.get(EntitlementsService).invalidate({ ownerType: "USER", ownerId: seller.userId });
    const itemId = createTestItem({ sellerOwnerId: seller.userId, pricePaise: 100000n });
    const code = `POOL${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    if (plan === "pro") await t.app.get(CouponsService).create({ code, kind: "PERCENT", value: 1000n, fundedBy: "CREATOR", ownerType: "USER", ownerId: seller.userId, scope: "SELLER" });
    else await prisma.coupon.create({ data: { code, kind: "PERCENT", value: 1000n, fundedBy: "CREATOR", ownerType: "USER", ownerId: seller.userId, scope: "SELLER" } });
    return { seller, itemId, code };
  }
  const checkout = (buyer: { accessToken: string }, itemId: string, couponCode: string) =>
    http().post("/v1/checkout").set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ itemType: "TEST_ITEM", itemId, couponCode });

  beforeAll(async () => {
    pinSmallPool();
    t = await createAuthTestApp({ providers: [TestItemProvider] }, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = t.app.get(PrismaService);
    redis = t.app.get<Redis>(REDIS);
  });
  afterAll(() => t?.close());

  it("parallel checkouts with creator coupons all succeed when the plan is not cached", async () => {
    const listings = [];
    for (let i = 0; i < BURST; i++) listings.push(await listing());
    const buyers = await Promise.all(listings.map(() => t.login()));
    planCacheUnavailable();
    const res = await Promise.all(listings.map((l, i) => checkout(buyers[i], l.itemId, l.code)));
    expect(statuses(res)).toEqual(Array(BURST).fill(201));
    expect(res.map((r) => r.body.amountPaise)).toEqual(Array(BURST).fill("90000"));
  });

  it("a creator coupon of a seller whose plan has no creator coupons is still refused", async () => {
    const l = await listing("free");
    const buyer = await t.login();
    planCacheUnavailable();
    const res = await checkout(buyer, l.itemId, l.code);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("COUPON_NOT_APPLICABLE");
  });
});
