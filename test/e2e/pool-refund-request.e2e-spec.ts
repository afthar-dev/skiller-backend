import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { FakeRazorpayClient, RAZORPAY_CLIENT } from "../../src/modules/billing";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { BURST, pinSmallPool, statuses } from "../support/small-pool";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

/**
 * A refund request for a course order is checked against the course's rule (the learner has completed less than 30% of it) inside the
 * request's transaction, which holds the order's row lock. That rule used to read the learner's progress through the global client, so
 * parallel requests on a small pool each held a connection while waiting for another (P2024, 500).
 */
describe("course refund requests with a small connection pool", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });

  /** A published paid course (state written straight to the table: other suites own the moderation flow). */
  async function course() {
    const owner = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(owner)).send({ acceptTerms: true })).status).toBe(200);
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Refundable ${randomUUID().slice(0, 8)}`, description: "A course", categoryId, language: "en", pricePaise: "49900" });
    expect(res.status).toBe(201);
    const c = res.body as { id: string };
    const section = await prisma.courseSection.create({ data: { courseId: c.id, title: "S", position: 0 } });
    await prisma.lesson.create({ data: { courseId: c.id, sectionId: section.id, title: "Read", type: "ARTICLE", position: 0, articleBody: "hi" } });
    await prisma.course.update({ where: { id: c.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
    return c.id;
  }
  async function buy(buyer: Session, courseId: string) {
    const res = await http().post("/v1/checkout").set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ itemType: "COURSE", itemId: courseId });
    expect(res.status).toBe(201);
    const o = res.body as { orderId: string; razorpayOrderId: string };
    const payment = fake.capturePayment(o.razorpayOrderId);
    const verified = await http().post("/v1/checkout/verify").set(auth(buyer)).send({ orderId: o.orderId, razorpayOrderId: o.razorpayOrderId, razorpayPaymentId: payment.id, signature: fake.paymentSignature(o.razorpayOrderId, payment.id) });
    expect(verified.status).toBe(200);
    return o.orderId;
  }
  const ask = (buyer: Session, orderId: string) => http().post(`/v1/orders/${orderId}/refund-requests`).set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ reason: "Changed my mind" });

  beforeAll(async () => {
    pinSmallPool();
    t = await createAuthTestApp({}, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  it("parallel refund requests for course orders all succeed", async () => {
    const courseId = await course();
    const buyers = await Promise.all(Array.from({ length: BURST }, () => t.login()));
    const orders: string[] = [];
    for (const b of buyers) orders.push(await buy(b, courseId));
    const res = await Promise.all(buyers.map((b, i) => ask(b, orders[i])));
    expect(statuses(res)).toEqual(Array(BURST).fill(201));
  });

  it("a learner past 30% of the course is still refused", async () => {
    const courseId = await course();
    const buyer = await t.login();
    const orderId = await buy(buyer, courseId);
    await prisma.enrolment.update({ where: { courseId_userId: { courseId, userId: buyer.userId } }, data: { progressPct: 60 } });
    const res = await ask(buyer, orderId);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("REFUND_NOT_ELIGIBLE");
  });
});
