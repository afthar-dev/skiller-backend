import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { FakeRazorpayClient, RAZORPAY_CLIENT } from "../../src/modules/billing";
import { CreatorService } from "../../src/modules/users";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { BURST, pinSmallPool, statuses } from "../support/small-pool";

/**
 * The first checkout of a plan version creates its Razorpay plan under a per-version lock. That used to be a second transaction opened
 * from inside the per-owner checkout transaction: a second pooled connection while the first is held. With a small pool and parallel
 * checkouts by different owners, every connection was held and nobody could get another (P2024, 500).
 */
describe("subscription checkout with a small connection pool", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const creator = async () => {
    const s = await t.login();
    await t.app.get(CreatorService).becomeCreator(s.userId);
    return s;
  };
  const proVersion = () => prisma.planVersion.findFirstOrThrow({ where: { plan: { key: "pro" }, interval: "MONTH" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });

  beforeAll(async () => {
    pinSmallPool();
    t = await createAuthTestApp({}, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = t.app.get(PrismaService);
  });
  afterAll(() => t?.close());

  it("parallel first checkouts of a plan version by different owners all succeed and create one Razorpay plan", async () => {
    const version = await proVersion();
    await prisma.planVersion.update({ where: { id: version.id }, data: { razorpayPlanId: null } });
    const owners = await Promise.all(Array.from({ length: BURST }, () => creator()));
    const plansBefore = fake.plans.size;
    const res = await Promise.all(owners.map((s) => http().post("/v1/subscriptions/checkout").set(auth(s)).send({ planVersionId: version.id })));
    expect(statuses(res)).toEqual(Array(BURST).fill(201));
    expect((await prisma.planVersion.findUniqueOrThrow({ where: { id: version.id } })).razorpayPlanId).toMatch(/^plan_/);
    expect(fake.plans.size - plansBefore).toBe(1);
  });

  it("a double click by one owner still gets the same pending subscription back", async () => {
    const version = await proVersion();
    const s = await creator();
    const [a, b] = await Promise.all([1, 2].map(() => http().post("/v1/subscriptions/checkout").set(auth(s)).send({ planVersionId: version.id })));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.subscriptionId).toBe(b.body.subscriptionId);
  });
});
