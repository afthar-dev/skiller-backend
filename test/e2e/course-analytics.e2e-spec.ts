import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { EntitlementsService, FakeRazorpayClient, RAZORPAY_CLIENT } from "../../src/modules/billing";
import { PermissionService, RolesService } from "../../src/modules/rbac";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";
import { givePlan } from "../support/billing";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("course analytics (creator studio)", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  let admin: Session | undefined;
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const analytics = (s: Session, courseId: string, query = "") => http().get(`/v1/studio/courses/${courseId}/analytics${query}`).set(auth(s));

  const creator = async () => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };
  async function grantRole(userId: string, roleKey: string, orgId?: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.userRole.create({ data: { userId, roleId: role.id, orgId: orgId ?? null } });
    await t.app.get(PermissionService).invalidateUser(userId);
  }
  /** A published course with `lessons` article lessons (state written straight to the table: other suites own the moderation flow). */
  async function course(owner: Session, lessons = 3, over: Record<string, unknown> = {}) {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Analytics ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "49900", ...over });
    expect(res.status).toBe(201);
    const c = res.body as { id: string };
    const section = await prisma.courseSection.create({ data: { courseId: c.id, title: "S", position: 0 } });
    const ids: string[] = [];
    for (let i = 0; i < lessons; i++) ids.push((await prisma.lesson.create({ data: { courseId: c.id, sectionId: section.id, title: `Lesson ${i}`, type: "ARTICLE", position: i, articleBody: "hi" } })).id);
    await prisma.course.update({ where: { id: c.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
    return { id: c.id, lessons: ids };
  }
  const enrol = (courseId: string, userId: string, over: Record<string, unknown> = {}) => prisma.enrolment.create({ data: { courseId, userId, source: "FREE", ...over } });

  const checkout = (buyer: Session, courseId: string) => http().post("/v1/checkout").set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ itemType: "COURSE", itemId: courseId });
  async function buy(buyer: Session, courseId: string) {
    const res = await checkout(buyer, courseId);
    expect(res.status).toBe(201);
    const o = res.body as { orderId: string; razorpayOrderId: string };
    const payment = fake.capturePayment(o.razorpayOrderId);
    const verified = await http().post("/v1/checkout/verify").set(auth(buyer)).send({ orderId: o.orderId, razorpayOrderId: o.razorpayOrderId, razorpayPaymentId: payment.id, signature: fake.paymentSignature(o.razorpayOrderId, payment.id) });
    expect(verified.status).toBe(200);
    return o;
  }
  async function finance(): Promise<Session> {
    if (!admin || t.clock.now().getTime() - (admin as Session & { at?: number }).at! > 3 * 60_000) {
      const a = await t.login();
      await t.app.get(RolesService).grantSystem(a.userId, "finance_admin");
      const before = t.mail.sent.filter((m) => m.to === a.email).length;
      const res = await http().post("/v1/auth/step-up/request").set(auth(a)).set("X-Forwarded-For", uniqueIp());
      expect(res.status).toBe(202);
      const code = await t.codeFor(a.email, before);
      await http().post("/v1/auth/step-up/verify").set(auth(a)).send({ challengeId: res.body.challengeId, code }).expect(204);
      admin = Object.assign(a, { at: t.clock.now().getTime() });
    }
    return admin;
  }
  async function refundOrder(buyer: Session, orderId: string) {
    const asked = await http().post(`/v1/orders/${orderId}/refund-requests`).set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ reason: "Changed my mind" });
    expect(asked.status).toBe(201);
    const as = await finance();
    expect((await http().post(`/v1/admin/refunds/${asked.body.id}/approve`).set(auth(as)).send({})).status).toBe(200);
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id }, include: { order: true } });
    const hook = fake.webhook("refund.processed", { refund: { entity: { id: refund.razorpayRefundId!, payment_id: refund.order.razorpayPaymentId!, amount: Number(refund.amountPaise), status: "processed", notes: { nonce: randomUUID() } } } });
    let r = http().post("/v1/webhooks/razorpay");
    for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
    expect((await r.send(hook.body)).status).toBe(200);
    await until(async () => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status === "REFUNDED");
  }
  /** What the ledger says the seller was credited for an order's sale (the PENDING line of the sale entry). */
  async function sellerShare(orderId: string): Promise<bigint> {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { refType_refId_description: { refType: "ORDER", refId: orderId, description: "sale" } }, include: { lines: { include: { account: true } } } });
    return entry.lines.filter((l) => l.account.kind === "PENDING" && l.account.ownerType === order.sellerOwnerType && l.account.ownerId === order.sellerOwnerId).reduce((s, l) => s + l.amountPaise, 0n);
  }

  beforeAll(async () => {
    t = await createAuthTestApp({}, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("access", () => {
    it("is for authors only: another creator and a stranger get 404, an org learner 403, anonymous 401", async () => {
      const owner = await creator();
      const c = await course(owner);
      expect((await analytics(owner, c.id)).status).toBe(200);
      expect((await analytics(await creator(), c.id)).status).toBe(404);
      expect((await http().get(`/v1/studio/courses/${c.id}/analytics`)).status).toBe(401);
      expect((await analytics(owner, randomUUID())).status).toBe(404);

      const orgOwner = await creator();
      const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: orgOwner.userId } });
      await grantRole(orgOwner.userId, "org_owner", org.id);
      const orgCourse = await course(orgOwner, 1, { ownerType: "ORG", orgId: org.id });
      const instructor = await t.login();
      await grantRole(instructor.userId, "org_instructor", org.id);
      const learner = await t.login();
      await grantRole(learner.userId, "org_learner", org.id);
      expect((await analytics(instructor, orgCourse.id)).status).toBe(200);
      expect((await analytics(learner, orgCourse.id)).status).toBe(403);
    });
  });

  describe("range", () => {
    it("defaults to the last 30 IST days and rejects ranges over 366 days, reversed ranges and bad dates", async () => {
      const owner = await creator();
      const c = await course(owner, 1);
      const res = await analytics(owner, c.id);
      expect(res.status).toBe(200);
      const days = res.body.enrolments.byDay as Array<{ date: string }>;
      expect(days).toHaveLength(30);
      expect(res.body.range).toEqual({ from: days[0].date, to: days[29].date });

      expect((await analytics(owner, c.id, "?from=2025-01-01&to=2026-06-01")).status).toBe(400);
      expect((await analytics(owner, c.id, "?from=2026-03-02&to=2026-03-01")).status).toBe(400);
      expect((await analytics(owner, c.id, "?from=2026-02-30&to=2026-03-01")).status).toBe(400);
      expect((await analytics(owner, c.id, "?from=yesterday")).status).toBe(400);
      expect((await analytics(owner, c.id, "?from=2025-01-01&to=2026-01-01")).status).toBe(200); // 366 days inclusive
    });
  });

  describe("enrolments", () => {
    it("counts enrolments per IST day and per source; a learner enrolling at 00:30 IST belongs to the next IST day", async () => {
      const owner = await creator();
      const c = await course(owner, 1);
      const learners = [await t.login(), await t.login(), await t.login(), await t.login()];
      await enrol(c.id, learners[0].userId, { source: "FREE", createdAt: new Date("2026-03-10T19:00:00Z") }); // 11 Mar 00:30 IST
      await enrol(c.id, learners[1].userId, { source: "PURCHASE", createdAt: new Date("2026-03-10T18:00:00Z") }); // 10 Mar 23:30 IST
      await enrol(c.id, learners[2].userId, { source: "PURCHASE", createdAt: new Date("2026-03-11T05:00:00Z"), revokedAt: new Date("2026-03-12T05:00:00Z") });
      await enrol(c.id, learners[3].userId, { source: "ORG_SEAT", createdAt: new Date("2026-03-13T05:00:00Z") }); // outside the range
      const res = await analytics(owner, c.id, "?from=2026-03-10&to=2026-03-12");
      expect(res.status).toBe(200);
      expect(res.body.enrolments.byDay).toEqual([
        { date: "2026-03-10", FREE: 0, PURCHASE: 1, ORG_SEAT: 0, total: 1 },
        { date: "2026-03-11", FREE: 1, PURCHASE: 1, ORG_SEAT: 0, total: 2 },
        { date: "2026-03-12", FREE: 0, PURCHASE: 0, ORG_SEAT: 0, total: 0 },
      ]);
      expect(res.body.enrolments.total).toBe(3);
    });
  });

  describe("completion and rating", () => {
    it("completion rate = completed / active enrolments (refunded ones leave both sides); the rating shows from 3 reviews", async () => {
      const owner = await creator();
      const c = await course(owner, 1);
      const users = [await t.login(), await t.login(), await t.login(), await t.login()];
      await enrol(c.id, users[0].userId, { completedAt: new Date(), progressPct: 100 });
      await enrol(c.id, users[1].userId);
      await enrol(c.id, users[2].userId, { completedAt: new Date(), progressPct: 100, revokedAt: new Date() });
      await enrol(c.id, users[3].userId);
      let res = await analytics(owner, c.id);
      expect(res.body).toMatchObject({ activeEnrolments: 3, completedEnrolments: 1 });
      expect(res.body.completionRate).toBeCloseTo(1 / 3, 5);
      expect(res.body.rating).toEqual({ avg: null, count: 0 });

      await prisma.course.update({ where: { id: c.id }, data: { ratingAvg: "4.50", ratingCount: 2 } });
      expect((await analytics(owner, c.id)).body.rating).toEqual({ avg: null, count: 2 });
      await prisma.course.update({ where: { id: c.id }, data: { ratingAvg: "4.33", ratingCount: 3 } });
      res = await analytics(owner, c.id);
      expect(res.body.rating).toEqual({ avg: 4.33, count: 3 });
    });

    it("a course nobody is enrolled in has a completion rate of 0, not NaN", async () => {
      const owner = await creator();
      const c = await course(owner, 1);
      const res = await analytics(owner, c.id);
      expect(res.body).toMatchObject({ activeEnrolments: 0, completionRate: 0 });
    });
  });

  describe("per-lesson drop-off and watch time", () => {
    async function seeded(planKey?: string) {
      const owner = await creator();
      if (planKey) await givePlan(prisma, "USER", owner.userId, planKey);
      const c = await course(owner, 3);
      const users = [await t.login(), await t.login(), await t.login()];
      for (const u of users) await enrol(c.id, u.userId);
      const refunded = await t.login();
      await enrol(c.id, refunded.userId, { revokedAt: new Date() });
      const progress = (user: string, lessonId: string, watchedSec: number, done: boolean) => prisma.lessonProgress.create({ data: { userId: user, lessonId, courseId: c.id, watchedSec, completedAt: done ? new Date() : null } });
      // lesson 0: all three finished; lesson 1: two; lesson 2: one. The refunded learner's rows must not count.
      for (const u of users) await progress(u.userId, c.lessons[0], 100, true);
      await progress(users[0].userId, c.lessons[1], 60, true);
      await progress(users[1].userId, c.lessons[1], 40, true);
      await progress(users[2].userId, c.lessons[1], 10, false);
      await progress(users[0].userId, c.lessons[2], 30, true);
      await progress(refunded.userId, c.lessons[0], 9999, true);
      return { owner, c };
    }

    it("basic plan: both are omitted and upgradeRequired is true", async () => {
      const { owner, c } = await seeded();
      const res = await analytics(owner, c.id);
      expect(res.status).toBe(200);
      expect(res.body.upgradeRequired).toBe(true);
      expect(res.body).not.toHaveProperty("lessons");
      expect(res.body.enrolments).toBeDefined();
    });

    it("standard plan: the share of active enrolments that completed each lesson, and total watch seconds, in curriculum order", async () => {
      const { owner, c } = await seeded("pro");
      const res = await analytics(owner, c.id);
      expect(res.status).toBe(200);
      expect(res.body.upgradeRequired).toBe(false);
      expect(res.body.lessons).toEqual([
        { lessonId: c.lessons[0], title: "Lesson 0", type: "ARTICLE", completedCount: 3, completionShare: 1, watchSeconds: 300 },
        { lessonId: c.lessons[1], title: "Lesson 1", type: "ARTICLE", completedCount: 2, completionShare: 2 / 3, watchSeconds: 110 },
        { lessonId: c.lessons[2], title: "Lesson 2", type: "ARTICLE", completedCount: 1, completionShare: 1 / 3, watchSeconds: 30 },
      ]);
    });

    it("an ORG course follows the organization's plan, not the instructor's", async () => {
      const orgOwner = await creator();
      const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: orgOwner.userId } });
      await grantRole(orgOwner.userId, "org_owner", org.id);
      await givePlan(prisma, "USER", orgOwner.userId, "business"); // a personal plan must not matter
      const c = await course(orgOwner, 1, { ownerType: "ORG", orgId: org.id });
      expect((await analytics(orgOwner, c.id)).body.upgradeRequired).toBe(true);
      await givePlan(prisma, "ORG", org.id, "org_starter");
      await t.app.get(EntitlementsService).invalidate({ ownerType: "ORG", ownerId: org.id });
      const res = await analytics(orgOwner, c.id);
      expect(res.body.upgradeRequired).toBe(false);
      expect(res.body.lessons).toHaveLength(1);
    });
  });

  describe("revenue", () => {
    it("equals the seller share posted for the course's paid orders; a refund takes it back; other courses and the platform fee are not counted", async () => {
      const owner = await creator();
      const c = await course(owner, 1, { pricePaise: "49900" });
      const other = await course(owner, 1, { pricePaise: "99900" });
      const buyerA = await t.login();
      const buyerB = await t.login();
      const orderA = await buy(buyerA, c.id);
      const orderB = await buy(buyerB, c.id);
      await buy(buyerA, other.id);

      const shareA = await sellerShare(orderA.orderId);
      const shareB = await sellerShare(orderB.orderId);
      expect(shareA).toBeGreaterThan(0n);
      expect(shareA).toBeLessThan(49900n); // commission was taken

      let res = await analytics(owner, c.id);
      expect(res.status).toBe(200);
      expect(res.body.revenue).toEqual({ currency: "INR", soldPaise: (shareA + shareB).toString(), refundedPaise: "0", netPaise: (shareA + shareB).toString() });

      await refundOrder(buyerB, orderB.orderId);
      res = await analytics(owner, c.id);
      expect(res.body.revenue).toEqual({ currency: "INR", soldPaise: (shareA + shareB).toString(), refundedPaise: shareB.toString(), netPaise: shareA.toString() });
    });

    it("only entries posted inside the range count", async () => {
      const owner = await creator();
      const c = await course(owner, 1);
      await buy(await t.login(), c.id);
      const past = await analytics(owner, c.id, "?from=2020-01-01&to=2020-01-31");
      expect(past.body.revenue).toEqual({ currency: "INR", soldPaise: "0", refundedPaise: "0", netPaise: "0" });
      expect(BigInt((await analytics(owner, c.id)).body.revenue.netPaise)).toBeGreaterThan(0n);
    });
  });
});
