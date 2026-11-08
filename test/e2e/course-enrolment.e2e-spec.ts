import { randomUUID } from "node:crypto";
import request from "supertest";
import { EventBus } from "../../src/common/outbox/event-bus";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { FakeRazorpayClient, FulfilmentService, RAZORPAY_CLIENT } from "../../src/modules/billing";
import { COURSE_PROGRESS_READER, type CourseProgressReader } from "../../src/modules/courses";
import { PermissionService, RolesService } from "../../src/modules/rbac";
import { AuthTestApp, createAuthTestApp, uniqueIp } from "../support/auth-app";
import { checkDeclared, expectDeclared } from "../support/openapi-shape";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const DAY = 86_400_000;

async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Stands in for the Task 6 progress reader: tests set how much of a course a learner has completed. */
class FakeProgress implements CourseProgressReader {
  readonly pct = new Map<string, number>();
  async completedRequiredPct(userId: string, courseId: string) {
    return this.pct.get(`${userId}:${courseId}`) ?? 0;
  }
}

describe("course enrolment, sellable and refunds", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let bus: EventBus;
  let categoryId: string;
  let admin: Session | undefined;
  const progress = new FakeProgress();
  const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const creator = async () => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };
  async function grantRole(userId: string, roleKey: string, orgId?: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const grant = await prisma.userRole.create({ data: { userId, roleId: role.id, orgId: orgId ?? null } });
    await t.app.get(PermissionService).invalidateUser(userId);
    return grant;
  }
  /** A published course (state written straight to the table: the moderation flow has its own suite). */
  async function publishedCourse(owner: Session, over: Record<string, unknown> = {}, status: "PUBLISHED" | "DRAFT" = "PUBLISHED") {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Enrolment ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "49900", ...over });
    expect(res.status).toBe(201);
    const course = res.body as { id: string; slug: string };
    const section = await prisma.courseSection.create({ data: { courseId: course.id, title: "S", position: 0 } });
    await prisma.lesson.create({ data: { courseId: course.id, sectionId: section.id, title: "L", type: "ARTICLE", position: 0, articleBody: "hi" } });
    if (status === "PUBLISHED") await prisma.course.update({ where: { id: course.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
    return course;
  }
  async function orgWithLearner() {
    const owner = await creator();
    const learner = await t.login();
    const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
    await grantRole(owner.userId, "org_owner", org.id);
    const learnerGrant = await grantRole(learner.userId, "org_learner", org.id);
    return { owner, learner, org, learnerGrant };
  }

  const checkout = (buyer: Session, courseId: string) => http().post("/v1/checkout").set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ itemType: "COURSE", itemId: courseId });
  async function start(buyer: Session, courseId: string) {
    const res = await checkout(buyer, courseId);
    expect(res.status).toBe(201);
    return res.body as { orderId: string; razorpayOrderId: string; amountPaise: string };
  }
  const verify = async (buyer: Session, o: { orderId: string; razorpayOrderId: string }, paymentId: string) => checkDeclared(await http().post("/v1/checkout/verify").set(auth(buyer)).send({ orderId: o.orderId, razorpayOrderId: o.razorpayOrderId, razorpayPaymentId: paymentId, signature: fake.paymentSignature(o.razorpayOrderId, paymentId) }), "POST /v1/checkout/verify");
  async function buy(buyer: Session, courseId: string) {
    const o = await start(buyer, courseId);
    const payment = fake.capturePayment(o.razorpayOrderId);
    const res = await verify(buyer, o, payment.id);
    expect(res.status).toBe(200);
    return { ...o, paymentId: payment.id };
  }
  async function deliverCaptured(p: { id: string; orderId: string | null; amountPaise: bigint }) {
    const hook = fake.webhook("payment.captured", { payment: { entity: { id: p.id, order_id: p.orderId, amount: Number(p.amountPaise), status: "captured", notes: { nonce: randomUUID() } } } });
    let r = http().post("/v1/webhooks/razorpay");
    for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
    expect((await r.send(hook.body)).status).toBe(200);
    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "RAZORPAY", eventId: hook.headers["x-razorpay-event-id"] } } });
    await until(async () => (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt);
  }
  const enrolments = (courseId: string, userId?: string) => prisma.enrolment.findMany({ where: { courseId, ...(userId ? { userId } : {}) } });
  const enrolmentCount = async (courseId: string) => (await prisma.course.findUniqueOrThrow({ where: { id: courseId } })).enrolmentCount;
  const learning = async (s: Session) => (await http().get("/v1/me/learning").set(auth(s))).body.items as Array<{ courseId: string; source: string; progressPct: number; courseSlug: string; courseStatus: string; flagged: boolean }>;

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
  /** Request, approve and process a refund end to end; returns the response of the request. */
  async function refundOrder(buyer: Session, orderId: string) {
    const asked = await http().post(`/v1/orders/${orderId}/refund-requests`).set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ reason: "Changed my mind" });
    if (asked.status !== 201) return asked;
    const as = await finance();
    expect((await http().post(`/v1/admin/refunds/${asked.body.id}/approve`).set(auth(as)).send({})).status).toBe(200);
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: asked.body.id }, include: { order: true } });
    const hook = fake.webhook("refund.processed", { refund: { entity: { id: refund.razorpayRefundId!, payment_id: refund.order.razorpayPaymentId!, amount: Number(refund.amountPaise), status: "processed", notes: { nonce: randomUUID() } } } });
    let r = http().post("/v1/webhooks/razorpay");
    for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
    expect((await r.send(hook.body)).status).toBe(200);
    await until(async () => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status === "REFUNDED");
    return asked;
  }

  beforeAll(async () => {
    t = await createAuthTestApp({}, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake).overrideProvider(COURSE_PROGRESS_READER).useValue(progress));
    prisma = t.app.get(PrismaService);
    bus = t.app.get(EventBus);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("purchase", () => {
    it("buys a course through checkout: one PURCHASE enrolment tied to the order, the course count and the learner's list follow", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller);
      const buyer = await t.login();
      expect(await learning(buyer)).toEqual([]);

      const o = await buy(buyer, course.id);
      const rows = await enrolments(course.id, buyer.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: "PURCHASE", orderId: o.orderId, revokedAt: null, completedAt: null, progressPct: 0 });
      expect(await enrolmentCount(course.id)).toBe(1);
      expect(await learning(buyer)).toEqual([expect.objectContaining({ courseId: course.id, courseSlug: course.slug, source: "PURCHASE", progressPct: 0, courseStatus: "PUBLISHED", flagged: false })]);
      expect((await http().get("/v1/me/learning")).status).toBe(401);
    });

    it("Review Focus 2: a webhook that arrives before the browser verifies enrols exactly once", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller);
      const buyer = await t.login();
      const o = await start(buyer, course.id);
      const payment = fake.capturePayment(o.razorpayOrderId);

      await deliverCaptured(payment);
      expect(await enrolments(course.id, buyer.userId)).toHaveLength(1);
      await deliverCaptured(payment); // the gateway retries
      expect((await verify(buyer, o, payment.id)).status).toBe(200); // and the browser finally verifies
      expect(await enrolments(course.id, buyer.userId)).toHaveLength(1);
      expect(await enrolmentCount(course.id)).toBe(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("PAID");
    });

    it("Review Focus 3: a price change or an emptied curriculum after checkout does not change what the buyer pays or break delivery", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller, { pricePaise: "49900" });
      const buyer = await t.login();
      const o = await start(buyer, course.id);
      expect(o.amountPaise).toBe("49900");

      expect((await http().patch(`/v1/studio/courses/${course.id}`).set(auth(seller)).send({ pricePaise: "99900" })).status).toBe(200);
      await prisma.lesson.deleteMany({ where: { courseId: course.id } });
      await prisma.courseSection.deleteMany({ where: { courseId: course.id } });

      const payment = fake.capturePayment(o.razorpayOrderId);
      expect(payment.amountPaise).toBe(49900n);
      expect((await verify(buyer, o, payment.id)).status).toBe(200);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId }, include: { items: true } });
      expect(order).toMatchObject({ status: "PAID", listPricePaise: 49900n, totalPaise: 49900n, fulfilmentFailedAt: null });
      expect(order.items[0].unitPricePaise).toBe(49900n);
      expect(await enrolments(course.id, buyer.userId)).toHaveLength(1);
      // a buyer after the change pays the new price
      const later = await start(await t.login(), course.id);
      expect(later.amountPaise).toBe("99900");
    });

    it.each(["flagged", "archived", "back to draft"])("a course that is %s between checkout and payment still enrols the buyer", async (change) => {
      const seller = await creator();
      const course = await publishedCourse(seller);
      const buyer = await t.login();
      const o = await start(buyer, course.id);
      const data = change === "flagged" ? { flaggedAt: new Date(), flagReason: "x" } : change === "archived" ? { status: "ARCHIVED" as const } : { status: "DRAFT" as const };
      await prisma.course.update({ where: { id: course.id }, data });
      const payment = fake.capturePayment(o.razorpayOrderId);
      expect((await verify(buyer, o, payment.id)).status).toBe(200);
      expect(await enrolments(course.id, buyer.userId)).toHaveLength(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).fulfilmentFailedAt).toBeNull();
    });

    it("a course that no longer exists fails the fulfilment permanently (4xx) so the payment is refunded, and no enrolment is made", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller);
      const buyer = await t.login();
      const o = await start(buyer, course.id);
      await prisma.lesson.deleteMany({ where: { courseId: course.id } });
      await prisma.courseSection.deleteMany({ where: { courseId: course.id } });
      await prisma.course.delete({ where: { id: course.id } });

      const payment = fake.capturePayment(o.razorpayOrderId);
      const res = await verify(buyer, o, payment.id);
      expect(res.status).toBe(200);
      expect(res.body.fulfilment).toBe("FAILED");
      const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
      expect(order.fulfilmentFailedAt).not.toBeNull();
      expect(order.fulfilmentError).toContain("COURSE_NOT_FOUND");
      expect(await prisma.enrolment.count({ where: { userId: buyer.userId } })).toBe(0);
      expect(await prisma.outboxEvent.count({ where: { type: "order.fulfilment_failed", payload: { path: ["orderId"], equals: o.orderId } } })).toBe(1);
    });

    it("fulfilling the same order twice (retry) enrols once", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller);
      const buyer = await t.login();
      const o = await buy(buyer, course.id);
      const f = t.app.get(FulfilmentService);
      await f.fulfil(o.orderId, o.paymentId, "webhook");
      await f.fulfil(o.orderId, o.paymentId, "webhook");
      expect(await enrolments(course.id, buyer.userId)).toHaveLength(1);
      expect(await enrolmentCount(course.id)).toBe(1);
    });
  });

  describe("what can be bought", () => {
    const reason = (res: request.Response) => res.body.error.details?.reason;

    it("refuses with a specific reason: unpublished, flagged, archived, free, own, already enrolled", async () => {
      const seller = await creator();
      const buyer = await t.login();

      const draft = await publishedCourse(seller, {}, "DRAFT");
      const inReview = await publishedCourse(seller);
      await prisma.course.update({ where: { id: inReview.id }, data: { status: "IN_REVIEW" } });
      const flagged = await publishedCourse(seller);
      await prisma.course.update({ where: { id: flagged.id }, data: { flaggedAt: new Date(), flagReason: "x" } });
      const archived = await publishedCourse(seller);
      await prisma.course.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });
      for (const c of [draft, inReview, flagged, archived]) {
        const res = await checkout(buyer, c.id);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("ITEM_NOT_PURCHASABLE");
        expect(reason(res)).toBe("COURSE_NOT_AVAILABLE");
      }

      const free = await publishedCourse(seller, { pricePaise: "0" });
      expect(reason(await checkout(buyer, free.id))).toBe("COURSE_FREE");

      const mine = await publishedCourse(seller);
      expect(reason(await checkout(seller, mine.id))).toBe("COURSE_OWN");

      const owned = await publishedCourse(seller);
      await buy(buyer, owned.id);
      expect(reason(await checkout(buyer, owned.id))).toBe("COURSE_ALREADY_ENROLLED");

      expect((await checkout(buyer, randomUUID())).status).toBe(404);
    });

    it("an organization's authors get COURSE_OWN and its learners COURSE_ORG_SEAT; an outsider can buy", async () => {
      const { owner, learner, org } = await orgWithLearner();
      const instructor = await t.login();
      await grantRole(instructor.userId, "org_instructor", org.id);
      const course = await publishedCourse(owner, { ownerType: "ORG", orgId: org.id });
      expect(reason(await checkout(owner, course.id))).toBe("COURSE_OWN");
      expect(reason(await checkout(instructor, course.id))).toBe("COURSE_OWN");
      const seat = await checkout(learner, course.id);
      expect(seat.status).toBe(409);
      expect(reason(seat)).toBe("COURSE_ORG_SEAT");
      const outsider = await t.login();
      expect((await checkout(outsider, course.id)).status).toBe(201);
    });

    it("a flagged course is not purchasable, but a learner who already bought it keeps it in their list", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller);
      const buyer = await t.login();
      await buy(buyer, course.id);
      await prisma.course.update({ where: { id: course.id }, data: { flaggedAt: new Date(), flagReason: "complaint" } });
      expect(reason(await checkout(await t.login(), course.id))).toBe("COURSE_NOT_AVAILABLE");
      const mine = await learning(buyer);
      expect(mine).toEqual([expect.objectContaining({ courseId: course.id, flagged: true, courseStatus: "PUBLISHED" })]);
      await prisma.course.update({ where: { id: course.id }, data: { status: "ARCHIVED" } });
      expect((await learning(buyer))[0]).toMatchObject({ courseId: course.id, courseStatus: "ARCHIVED" });
    });
  });

  describe("enrol without checkout", () => {
    const enrol = async (s: Session, slug: string) => checkDeclared(await http().post(`/v1/courses/${slug}/enrol`).set(auth(s)), "POST /v1/courses/{slug}/enrol");

    it("anyone can enrol in a free published course; repeating is harmless", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller, { pricePaise: "0" });
      const learner = await t.login();
      const first = await enrol(learner, course.slug);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ courseId: course.id, source: "FREE", progressPct: 0 });
      const again = await enrol(learner, course.slug);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect(await enrolmentCount(course.id)).toBe(1);
      expect((await enrol(learner, "no-such-course")).status).toBe(404);
      expect((await http().post(`/v1/courses/${course.slug}/enrol`)).status).toBe(401);
    });

    it("a paid course needs payment (402); an author cannot enrol in their own course; unpublished and flagged courses are 404", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller);
      const learner = await t.login();
      const res = await enrol(learner, course.slug);
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe("COURSE_PAYMENT_REQUIRED");
      const own = await enrol(seller, course.slug);
      expect(own.status).toBe(409);
      expect(own.body.error.code).toBe("COURSE_OWN");

      const draft = await publishedCourse(seller, { pricePaise: "0" }, "DRAFT");
      expect((await enrol(learner, draft.slug)).status).toBe(404);
      const flagged = await publishedCourse(seller, { pricePaise: "0" });
      await prisma.course.update({ where: { id: flagged.id }, data: { flaggedAt: new Date(), flagReason: "x" } });
      expect((await enrol(learner, flagged.slug)).status).toBe(404);
      expect(await enrolmentCount(flagged.id)).toBe(0);
    });

    it("Review Focus 5: an org learner enrols in the organization's paid course without checkout, as an ORG_SEAT", async () => {
      const { owner, learner, org } = await orgWithLearner();
      const course = await publishedCourse(owner, { ownerType: "ORG", orgId: org.id, pricePaise: "250000" });
      const res = await enrol(learner, course.slug);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ courseId: course.id, source: "ORG_SEAT" });
      expect(await enrolmentCount(course.id)).toBe(1);
      expect(await prisma.order.count({ where: { buyerId: learner.userId } })).toBe(0);
      // someone who is only a learner of ANOTHER organization pays
      const other = await orgWithLearner();
      expect((await enrol(other.learner, course.slug)).status).toBe(402);
    });

    it("Review Focus 5: removing the learner from the organization revokes their seats but not what they bought; they can enrol again if they return", async () => {
      const { owner, learner, org } = await orgWithLearner();
      const viaSeat = await publishedCourse(owner, { ownerType: "ORG", orgId: org.id, pricePaise: "250000" });
      const bought = await publishedCourse(owner, { ownerType: "ORG", orgId: org.id, pricePaise: "99900" });
      const elsewhere = await publishedCourse(await creator(), { pricePaise: "0" });
      expect((await enrol(learner, viaSeat.slug)).status).toBe(201);
      // paid enrolment of an org course made while they were not (yet) a learner: simulate the PURCHASE row directly
      await prisma.enrolment.create({ data: { courseId: bought.id, userId: learner.userId, source: "PURCHASE", orderId: randomUUID() } });
      await prisma.course.update({ where: { id: bought.id }, data: { enrolmentCount: { increment: 1 } } });
      expect((await enrol(learner, elsewhere.slug)).status).toBe(201);

      const removed = await http().delete(`/v1/orgs/${org.slug}/members/${learner.userId}`).set(auth(owner));
      expect(removed.status).toBe(204);
      const event = (await prisma.outboxEvent.findMany({ where: { type: "org.member_removed" } })).find((e) => (e.payload as { userId?: string }).userId === learner.userId)!;
      expect(event.payload).toMatchObject({ orgId: org.id, userId: learner.userId });
      await bus.dispatch({ type: "org.member_removed", ...(event.payload as { orgId: string; userId: string }) }, event.id);
      await bus.dispatch({ type: "org.member_removed", ...(event.payload as { orgId: string; userId: string }) }, event.id); // redelivery

      const [seat] = await enrolments(viaSeat.id, learner.userId);
      expect(seat.revokedAt).not.toBeNull();
      expect(await enrolmentCount(viaSeat.id)).toBe(0);
      expect((await enrolments(bought.id, learner.userId))[0].revokedAt).toBeNull();
      expect((await enrolments(elsewhere.id, learner.userId))[0].revokedAt).toBeNull();
      expect((await learning(learner)).map((x) => x.courseId).sort()).toEqual([bought.id, elsewhere.id].sort());
      expect((await enrol(learner, viaSeat.slug)).status).toBe(402); // no longer a learner

      await grantRole(learner.userId, "org_learner", org.id);
      const back = await enrol(learner, viaSeat.slug);
      expect(back.status).toBe(201);
      expect(back.body.id).toBe(seat.id); // the same row, reactivated
      expect(await enrolmentCount(viaSeat.id)).toBe(1);
    });

    it("revoking the learner role (not the whole membership) also revokes the seats; a late event does not hurt a learner who has come back", async () => {
      const { owner, learner, org, learnerGrant } = await orgWithLearner();
      const course = await publishedCourse(owner, { ownerType: "ORG", orgId: org.id, pricePaise: "250000" });
      expect((await enrol(learner, course.slug)).status).toBe(201);

      await t.app.get(RolesService).revoke(owner.userId, learnerGrant.id, { userId: learner.userId });
      const event = (await prisma.outboxEvent.findMany({ where: { type: "org.member_removed" } })).find((e) => (e.payload as { userId?: string }).userId === learner.userId)!;
      expect(event).toBeDefined();

      // back before the event is processed: the seat stays
      await grantRole(learner.userId, "org_learner", org.id);
      await bus.dispatch({ type: "org.member_removed", ...(event.payload as { orgId: string; userId: string }) }, event.id);
      expect((await enrolments(course.id, learner.userId))[0].revokedAt).toBeNull();
    });
  });

  describe("refunds", () => {
    it("Review Focus 2/5: eligible within 7 days and below 30% completed; refused from 30%, and after the window, with the reason", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller);
      const buyer = await t.login();
      const o = await buy(buyer, course.id);
      const ask = (orderId: string) => http().post(`/v1/orders/${orderId}/refund-requests`).set(auth(buyer)).set("Idempotency-Key", randomUUID()).send({ reason: "Not for me" });

      progress.pct.set(`${buyer.userId}:${course.id}`, 35);
      const tooFar = await ask(o.orderId);
      expect(tooFar.status).toBe(422);
      expect(tooFar.body.error.code).toBe("REFUND_NOT_ELIGIBLE");
      expect(tooFar.body.error.details.reason).toMatch(/30%/);
      progress.pct.set(`${buyer.userId}:${course.id}`, 30);
      expect((await ask(o.orderId)).status).toBe(422);

      progress.pct.set(`${buyer.userId}:${course.id}`, 29.9);
      await prisma.order.update({ where: { id: o.orderId }, data: { paidAt: new Date(t.clock.now().getTime() - 8 * DAY) } });
      const late = await ask(o.orderId);
      expect(late.status).toBe(422);
      expect(late.body.error.details.reason).toMatch(/7 days/);
    });

    it("a refund through the real refund flow (order.refunded) revokes the learner's certificate, in step with the enrolment", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller);
      const buyer = await t.login();
      const first = await buy(buyer, course.id);
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: course.id, userId: buyer.userId } }, data: { completedAt: t.clock.now() } });
      const cert = await prisma.certificate.create({
        data: { code: Array.from({ length: 10 }, () => "23456789ABCDEFGHJKMNPQRSTUVWXYZ"[Math.floor(Math.random() * 31)]).join(""), courseId: course.id, userId: buyer.userId, learnerName: "Asha Verma", courseTitle: "T", issuerName: "I", issuedAt: t.clock.now(), objectKey: "certificates/x.pdf" },
      });
      expect(cert.revokedAt).toBeNull();
      expect((await refundOrder(buyer, first.orderId)).status).toBe(201);
      expect((await prisma.certificate.findUniqueOrThrow({ where: { id: cert.id } })).revokedAt).not.toBeNull();
      const verifyRes = await http().get("/v1/certificates/" + cert.code).set("X-Forwarded-For", uniqueIp());
      expect(verifyRes.body.status).toBe("REVOKED");
    });

    it("a refund revokes the enrolment at once; buying again reactivates the same row with the new order", async () => {
      const seller = await creator();
      const course = await publishedCourse(seller);
      const buyer = await t.login();
      const first = await buy(buyer, course.id);
      const [row] = await enrolments(course.id, buyer.userId);
      progress.pct.set(`${buyer.userId}:${course.id}`, 10);

      const asked = await refundOrder(buyer, first.orderId);
      expect(asked.status).toBe(201);
      const revoked = (await enrolments(course.id, buyer.userId))[0];
      expect(revoked.revokedAt).not.toBeNull();
      expect(await enrolmentCount(course.id)).toBe(0);
      expect(await learning(buyer)).toEqual([]);

      const second = await buy(buyer, course.id);
      const rows = await enrolments(course.id, buyer.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: row.id, source: "PURCHASE", orderId: second.orderId, revokedAt: null });
      expect(await enrolmentCount(course.id)).toBe(1);
      expect((await learning(buyer)).map((x) => x.courseId)).toEqual([course.id]);
    });
  });

  describe("learning list", () => {
    it("lists active enrolments newest first with a cursor", async () => {
      const seller = await creator();
      const learner = await t.login();
      const courses = [] as Array<{ id: string; slug: string }>;
      for (let i = 0; i < 3; i++) {
        const c = await publishedCourse(seller, { pricePaise: "0" });
        courses.push(c);
        expect((await http().post(`/v1/courses/${c.slug}/enrol`).set(auth(learner))).status).toBe(201);
      }
      const p1 = await http().get("/v1/me/learning").query({ limit: 2 }).set(auth(learner));
      expectDeclared(p1, "GET /v1/me/learning");
      expect(p1.body.items.map((x: { courseId: string }) => x.courseId)).toEqual([courses[2].id, courses[1].id]);
      const p2 = await http().get("/v1/me/learning").query({ limit: 2, cursor: p1.body.nextCursor }).set(auth(learner));
      expect(p2.body.items.map((x: { courseId: string }) => x.courseId)).toEqual([courses[0].id]);
      expect(p2.body.nextCursor).toBeNull();
    });
  });
});
