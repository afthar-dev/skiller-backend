import { randomUUID } from "node:crypto";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
// Import order matters (cycle between billing, courses and organizations): billing, then courses, then rbac, as in course-enrolment.
import { FakeRazorpayClient, RAZORPAY_CLIENT } from "../../src/modules/billing";
import { EnrolmentsService } from "../../src/modules/courses";
import { PermissionService } from "../../src/modules/rbac";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Final-review fixes of Phase 3: lock order, last required lesson, expired seats, plain-text titles.
describe("course final-review fixes", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let enrolments: EnrolmentsService;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const base = (id: string) => `/v1/studio/courses/${id}`;

  const creator = async () => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };
  async function grantRole(userId: string, roleKey: string, orgId?: string, expiresAt?: Date) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const grant = await prisma.userRole.create({ data: { userId, roleId: role.id, orgId: orgId ?? null, expiresAt: expiresAt ?? null } });
    await t.app.get(PermissionService).invalidateUser(userId);
    return grant;
  }
  /** A PUBLISHED course (state written straight to the table) with one required and one optional article lesson. */
  async function liveCourse(owner: Session, over: Record<string, unknown> = {}) {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Final ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "49900", ...over });
    expect(res.status).toBe(201);
    const course = res.body as { id: string; slug: string };
    const section = await prisma.courseSection.create({ data: { courseId: course.id, title: "S", position: 0 } });
    const required = await prisma.lesson.create({ data: { courseId: course.id, sectionId: section.id, title: "Required", type: "ARTICLE", position: 0, articleBody: "hi", isRequired: true } });
    const optional = await prisma.lesson.create({ data: { courseId: course.id, sectionId: section.id, title: "Optional", type: "ARTICLE", position: 1, articleBody: "hi", isRequired: false } });
    await prisma.course.update({ where: { id: course.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
    return { ...course, sectionId: section.id, requiredId: required.id, optionalId: optional.id };
  }
  async function orgWithOwner() {
    const owner = await creator();
    const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
    await grantRole(owner.userId, "org_owner", org.id);
    return { owner, org };
  }
  const reason = (res: { body: { error?: { code?: string } } }) => res.body.error?.code;
  const checkoutReason = (res: request.Response) => res.body.error.details?.reason;

  beforeAll(async () => {
    const fake = new FakeRazorpayClient({ keySecret: "razorpay-key-secret-for-tests", webhookSecret: "razorpay-webhook-secret-for-tests", webhookXSecret: "razorpayx-webhook-secret-for-tests" });
    t = await createAuthTestApp({}, (b) => b.overrideProvider(RAZORPAY_CLIENT).useValue(fake));
    prisma = t.app.get(PrismaService);
    enrolments = t.app.get(EnrolmentsService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("lock order: course row before enrolment rows", () => {
    /**
     * Models a curriculum edit's recompute: it holds the course row, then locks the course's active enrolments. `revoke` runs on another
     * connection while the edit holds the course; with enrolment-first locking the two wait for each other (Postgres 40P01).
     */
    async function raceWithRecompute(courseId: string, revoke: () => Promise<unknown>) {
      let revoking: Promise<unknown> = Promise.resolve();
      let started!: () => void;
      const revokeStarted = new Promise<void>((r) => (started = r));
      const edit = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "courses" WHERE "id" = ${courseId} FOR UPDATE`;
          revoking = revoke();
          revoking.catch(() => undefined);
          started();
          await sleep(500); // the revoke now holds whatever it locks before it asks for the course
          await tx.$queryRaw`SELECT "id" FROM "enrolments" WHERE "courseId" = ${courseId} AND "revokedAt" IS NULL ORDER BY "id" FOR UPDATE`;
        },
        { timeout: 30_000 },
      );
      const results = await Promise.allSettled([edit, revokeStarted.then(() => revoking)]);
      return results.map((r) => (r.status === "rejected" ? String((r.reason as Error).message) : "ok"));
    }

    it("a refund (onRefunded) racing a curriculum recompute: both succeed", async () => {
      const owner = await creator();
      const course = await liveCourse(owner);
      const buyer = await t.login();
      const orderId = randomUUID();
      await prisma.enrolment.create({ data: { courseId: course.id, userId: buyer.userId, source: "PURCHASE", orderId } });
      await prisma.course.update({ where: { id: course.id }, data: { enrolmentCount: 1 } });

      const outcome = await raceWithRecompute(course.id, () => prisma.$transaction((tx) => enrolments.revokeForOrder(tx, { courseId: course.id, userId: buyer.userId, orderId })));
      expect(outcome).toEqual(["ok", "ok"]);
      expect((await prisma.enrolment.findUniqueOrThrow({ where: { courseId_userId: { courseId: course.id, userId: buyer.userId } } })).revokedAt).not.toBeNull();
      expect((await prisma.course.findUniqueOrThrow({ where: { id: course.id } })).enrolmentCount).toBe(0);
    });

    it("an organization seat revocation racing a curriculum recompute: both succeed", async () => {
      const { owner, org } = await orgWithOwner();
      const course = await liveCourse(owner, { ownerType: "ORG", orgId: org.id });
      const learner = await t.login(); // holds no org_learner grant any more
      await prisma.enrolment.create({ data: { courseId: course.id, userId: learner.userId, source: "ORG_SEAT" } });
      await prisma.course.update({ where: { id: course.id }, data: { enrolmentCount: 1 } });

      const outcome = await raceWithRecompute(course.id, () => enrolments.revokeOrgSeats(org.id, learner.userId));
      expect(outcome).toEqual(["ok", "ok"]);
      expect((await prisma.enrolment.findUniqueOrThrow({ where: { courseId_userId: { courseId: course.id, userId: learner.userId } } })).revokedAt).not.toBeNull();
    });

    it("re-enrolling a revoked learner (grant) racing a curriculum recompute: both succeed", async () => {
      const owner = await creator();
      const course = await liveCourse(owner);
      const buyer = await t.login();
      await prisma.enrolment.create({ data: { courseId: course.id, userId: buyer.userId, source: "PURCHASE", orderId: randomUUID(), revokedAt: new Date() } });

      const outcome = await raceWithRecompute(course.id, () => prisma.$transaction((tx) => enrolments.grant(tx, { courseId: course.id, userId: buyer.userId, source: "PURCHASE", orderId: randomUUID() })));
      expect(outcome).toEqual(["ok", "ok"]);
      expect((await prisma.enrolment.findUniqueOrThrow({ where: { courseId_userId: { courseId: course.id, userId: buyer.userId } } })).revokedAt).toBeNull();
    });
  });

  describe("a live course keeps at least one required lesson", () => {
    it("refuses making the last required lesson optional, deleting it, or deleting its section; allowed once another is required", async () => {
      const owner = await creator();
      const c = await liveCourse(owner);
      const lessonUrl = (id: string) => `${base(c.id)}/lessons/${id}`;

      const optionalise = await http().patch(lessonUrl(c.requiredId)).set(auth(owner)).send({ isRequired: false });
      expect(optionalise.status).toBe(409);
      expect(reason(optionalise)).toBe("COURSE_REQUIRED_LESSON");
      const del = await http().delete(lessonUrl(c.requiredId)).set(auth(owner));
      expect(del.status).toBe(409);
      expect(reason(del)).toBe("COURSE_REQUIRED_LESSON");
      const delSection = await http().delete(`${base(c.id)}/sections/${c.sectionId}`).set(auth(owner));
      expect(delSection.status).toBe(409);
      expect(reason(delSection)).toBe("COURSE_REQUIRED_LESSON");
      expect(await prisma.lesson.count({ where: { courseId: c.id } })).toBe(2);
      expect((await prisma.lesson.findUniqueOrThrow({ where: { id: c.requiredId } })).isRequired).toBe(true);

      // another required lesson first, then the first may go optional and be deleted
      expect((await http().patch(lessonUrl(c.optionalId)).set(auth(owner)).send({ isRequired: true })).status).toBe(200);
      expect((await http().patch(lessonUrl(c.requiredId)).set(auth(owner)).send({ isRequired: false })).status).toBe(200);
      expect((await http().patch(lessonUrl(c.requiredId)).set(auth(owner)).send({ isRequired: true })).status).toBe(200);
      expect((await http().delete(lessonUrl(c.requiredId)).set(auth(owner))).status).toBe(204);
    });

    it("a flagged course is live too; a draft may do anything", async () => {
      const owner = await creator();
      const flagged = await liveCourse(owner);
      await prisma.course.update({ where: { id: flagged.id }, data: { flaggedAt: new Date(), flagReason: "x" } });
      const res = await http().patch(`${base(flagged.id)}/lessons/${flagged.requiredId}`).set(auth(owner)).send({ isRequired: false });
      expect(reason(res)).toBe("COURSE_REQUIRED_LESSON");

      const draft = await liveCourse(owner);
      await prisma.course.update({ where: { id: draft.id }, data: { status: "DRAFT", publishedAt: null } });
      expect((await http().patch(`${base(draft.id)}/lessons/${draft.requiredId}`).set(auth(owner)).send({ isRequired: false })).status).toBe(200);
      expect((await http().delete(`${base(draft.id)}/lessons/${draft.requiredId}`).set(auth(owner))).status).toBe(204);
    });
  });

  describe("an organization seat without a live grant counts as no relation", () => {
    it("before the sweep: the user can buy the course (the seat row becomes a PURCHASE)", async () => {
      const { owner, org } = await orgWithOwner();
      const course = await liveCourse(owner, { ownerType: "ORG", orgId: org.id });
      const learner = await t.login();
      await grantRole(learner.userId, "org_learner", org.id, new Date(t.clock.now().getTime() - 60_000)); // expired, no event emitted
      await prisma.enrolment.create({ data: { courseId: course.id, userId: learner.userId, source: "ORG_SEAT" } });
      await prisma.course.update({ where: { id: course.id }, data: { enrolmentCount: 1 } });

      const checkout = await http().post("/v1/checkout").set(auth(learner)).set("Idempotency-Key", randomUUID()).send({ itemType: "COURSE", itemId: course.id });
      expect(checkout.status).toBe(201);

      const row = () => prisma.enrolment.findUniqueOrThrow({ where: { courseId_userId: { courseId: course.id, userId: learner.userId } } });
      await t.app.get(PrismaService).$transaction((tx) => enrolments.grant(tx, { courseId: course.id, userId: learner.userId, source: "PURCHASE", orderId: randomUUID() }));
      expect(await row()).toMatchObject({ source: "PURCHASE", revokedAt: null });
      expect(await prisma.enrolment.count({ where: { courseId: course.id, userId: learner.userId } })).toBe(1);
      expect((await prisma.course.findUniqueOrThrow({ where: { id: course.id } })).enrolmentCount).toBe(1);
      // the sweep leaves a purchase alone
      await enrolments.sweepOrgSeats();
      expect((await row()).revokedAt).toBeNull();
    });

    it("before the sweep: a paid course answers 402 on enrol (not the stale enrolment), a free one re-enrols the row as FREE", async () => {
      const { owner, org } = await orgWithOwner();
      const paid = await liveCourse(owner, { ownerType: "ORG", orgId: org.id });
      const free = await liveCourse(owner, { ownerType: "ORG", orgId: org.id, pricePaise: "0" });
      const learner = await t.login();
      await grantRole(learner.userId, "org_learner", org.id, new Date(t.clock.now().getTime() - 60_000));
      for (const c of [paid, free]) await prisma.enrolment.create({ data: { courseId: c.id, userId: learner.userId, source: "ORG_SEAT" } });
      await prisma.course.updateMany({ where: { id: { in: [paid.id, free.id] } }, data: { enrolmentCount: 1 } });

      const noSeat = await http().post(`/v1/courses/${paid.slug}/enrol`).set(auth(learner));
      expect(noSeat.status).toBe(402);
      const again = await http().post(`/v1/courses/${free.slug}/enrol`).set(auth(learner));
      expect(again.status).toBe(201);
      expect(again.body).toMatchObject({ courseId: free.id, source: "FREE" });
      expect((await prisma.course.findUniqueOrThrow({ where: { id: free.id } })).enrolmentCount).toBe(1);
      await enrolments.sweepOrgSeats();
      expect((await prisma.enrolment.findUniqueOrThrow({ where: { courseId_userId: { courseId: free.id, userId: learner.userId } } })).revokedAt).toBeNull();
    });

    it("a learner with a live grant keeps ENROLLED (seat still valid)", async () => {
      const { owner, org } = await orgWithOwner();
      const course = await liveCourse(owner, { ownerType: "ORG", orgId: org.id });
      const learner = await t.login();
      await grantRole(learner.userId, "org_learner", org.id);
      const res = await http().post(`/v1/courses/${course.slug}/enrol`).set(auth(learner));
      expect(res.status).toBe(201);
      const again = await http().post(`/v1/courses/${course.slug}/enrol`).set(auth(learner));
      expect(again.status).toBe(200);
      const checkout = await http().post("/v1/checkout").set(auth(learner)).set("Idempotency-Key", randomUUID()).send({ itemType: "COURSE", itemId: course.id });
      expect(checkoutReason(checkout)).toBe("COURSE_ALREADY_ENROLLED");
    });
  });

  describe("course, section and lesson titles are single-line plain text", () => {
    const dirty = "Line one\nLine\ttwo‮​  end";
    const clean = "Line one Line two end";

    it("create and update sanitise the title and subtitle; a title that is empty afterwards is refused", async () => {
      const c = await creator();
      const res = await http().post("/v1/studio/courses").set(auth(c)).send({ title: dirty, subtitle: "Sub\r\ntitle x", description: "d", categoryId, language: "en" });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe(clean);
      expect(res.body.subtitle).toBe("Sub title x");
      const patched = await http().patch(base(res.body.id)).set(auth(c)).send({ title: `${dirty} 2`, subtitle: "A\nB" });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ title: `${clean} 2`, subtitle: "A B" });
      const empty = await http().post("/v1/studio/courses").set(auth(c)).send({ title: "​​​​", description: "d", categoryId, language: "en" });
      expect(empty.status).toBe(400);
    });

    it("section and lesson titles are sanitised on create and update", async () => {
      const c = await creator();
      const course = (await http().post("/v1/studio/courses").set(auth(c)).send({ title: `Titles ${uniq()}`, description: "d", categoryId, language: "en" })).body;
      const section = await http().post(`${base(course.id)}/sections`).set(auth(c)).send({ title: "Sec\ntion‮" });
      expect(section.status).toBe(201);
      expect(section.body.title).toBe("Sec tion");
      expect((await http().patch(`${base(course.id)}/sections/${section.body.id}`).set(auth(c)).send({ title: "New\nname​" })).body.title).toBe("New name");
      const lesson = await http().post(`${base(course.id)}/lessons`).set(auth(c)).send({ sectionId: section.body.id, title: "Les\nson‮ one", type: "ARTICLE" });
      expect(lesson.status).toBe(201);
      expect(lesson.body.title).toBe("Les son one");
      const patched = await http().patch(`${base(course.id)}/lessons/${lesson.body.id}`).set(auth(c)).send({ title: "Two\r\nlines" });
      expect(patched.body.title).toBe("Two lines");
    });
  });
});
