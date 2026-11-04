import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { EnrolmentsService } from "../../src/modules/courses";
import { PermissionService } from "../../src/modules/rbac/permission.service";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("course reviews and lesson Q&A", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  let moderator: Session;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const creator = async () => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };
  async function grantRole(userId: string, roleKey: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.userRole.create({ data: { userId, roleId: role.id, orgId: null } });
    await t.app.get(PermissionService).invalidateUser(userId);
  }
  /** A published free course with a free-preview article lesson and a members-only article lesson. */
  async function course(owner: Session) {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Reviewed ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "0" });
    expect(res.status).toBe(201);
    const c = res.body as { id: string; slug: string; title: string };
    const section = await prisma.courseSection.create({ data: { courseId: c.id, title: "S", position: 0 } });
    const preview = await prisma.lesson.create({ data: { courseId: c.id, sectionId: section.id, title: "Free", type: "ARTICLE", position: 0, articleBody: "t", isFreePreview: true } });
    const members = await prisma.lesson.create({ data: { courseId: c.id, sectionId: section.id, title: "Members", type: "ARTICLE", position: 1, articleBody: "t" } });
    await prisma.course.update({ where: { id: c.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
    return { ...c, previewLessonId: preview.id, lessonId: members.id };
  }
  async function learner(c: { slug: string }) {
    const s = await t.login();
    expect((await http().post(`/v1/courses/${c.slug}/enrol`).set(auth(s))).status).toBe(201);
    return s;
  }
  const review = (s: Session, slug: string, body: Record<string, unknown>) => http().put(`/v1/courses/${slug}/reviews/mine`).set(auth(s)).send(body);
  const publicCourse = async (slug: string) => (await http().get(`/v1/courses/${slug}`)).body as { ratingAvg: number | null; ratingCount: number };
  const rowOf = (courseId: string) => prisma.course.findUniqueOrThrow({ where: { id: courseId } });
  const notifications = (userId: string, type: string) => prisma.notification.findMany({ where: { userId, type } });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
    moderator = await t.login();
    await grantRole(moderator.userId, "moderator");
  });
  afterAll(() => t?.close());

  describe("reviews", () => {
    it("lets only active enrolled learners review: strangers and authors get 403", async () => {
      const owner = await creator();
      const c = await course(owner);
      const stranger = await t.login();
      const res = await review(stranger, c.slug, { rating: 5 });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("REVIEW_NOT_ALLOWED");
      expect((await review(owner, c.slug, { rating: 5 })).status).toBe(403);
      expect((await http().put(`/v1/courses/${c.slug}/reviews/mine`).send({ rating: 5 })).status).toBe(401);
    });

    it("a second review is an update, never a duplicate; text is plain and sanitised", async () => {
      const c = await course(await creator());
      const me = await learner(c);
      const first = await review(me, c.slug, { rating: 4, body: "Good‮ course\u0000\n\n\n\nreally" });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ rating: 4, body: "Good course\n\nreally" });
      const second = await review(me, c.slug, { rating: 2, body: "Changed my mind" });
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(await prisma.review.count({ where: { courseId: c.id } })).toBe(1);
      expect((await http().get(`/v1/courses/${c.slug}/reviews/mine`).set(auth(me))).body).toMatchObject({ rating: 2, body: "Changed my mind" });
    });

    it("validates the rating (1-5) and the length of the text (2000)", async () => {
      const c = await course(await creator());
      const me = await learner(c);
      for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 3.5 }, { rating: "5" }, {}, { rating: 5, body: "x".repeat(2001) }, { rating: 5, extra: 1 }]) {
        expect((await review(me, c.slug, bad)).status).toBe(400);
      }
      expect((await review(me, c.slug, { rating: 5, body: "x".repeat(2000) })).status).toBe(200);
      expect((await review(me, c.slug, { rating: 5, body: "   " })).body.body).toBeNull();
    });

    it("keeps the average hidden until three learners rated, then shows it with two decimals", async () => {
      const c = await course(await creator());
      const a = await learner(c);
      const b = await learner(c);
      const d = await learner(c);
      await review(a, c.slug, { rating: 5 });
      await review(b, c.slug, { rating: 4 });
      expect(await publicCourse(c.slug)).toMatchObject({ ratingAvg: null, ratingCount: 2 });
      expect(Number((await rowOf(c.id)).ratingAvg)).toBe(4.5); // stored from the first review on
      await review(d, c.slug, { rating: 4 });
      expect(await publicCourse(c.slug)).toMatchObject({ ratingAvg: 4.33, ratingCount: 3 });
      await review(d, c.slug, { rating: 1 }); // an edit moves the average
      expect(await publicCourse(c.slug)).toMatchObject({ ratingAvg: 3.33, ratingCount: 3 });
      const list = await http().get(`/v1/courses/${c.slug}/reviews`);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(3);
      expect(list.body.summary).toMatchObject({ ratingAvg: 3.33, ratingCount: 3 });
    });

    it("lists newest first with a cursor, and hides nothing but the hidden ones", async () => {
      const c = await course(await creator());
      const users = [await learner(c), await learner(c), await learner(c)];
      for (const [i, u] of users.entries()) await review(u, c.slug, { rating: 3 + (i % 2), body: `review ${i}` });
      const p1 = await http().get(`/v1/courses/${c.slug}/reviews?limit=2`);
      expect(p1.body.items.map((r: { body: string }) => r.body)).toEqual(["review 2", "review 1"]);
      expect(p1.body.items[0].author).toMatchObject({ displayName: expect.any(String) });
      const p2 = await http().get(`/v1/courses/${c.slug}/reviews?limit=2&cursor=${p1.body.nextCursor}`);
      expect(p2.body.items.map((r: { body: string }) => r.body)).toEqual(["review 0"]);
      expect(p2.body.nextCursor).toBeNull();
    });

    it("lets an author reply once, editable, and tells the learner; outsiders cannot reply", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await learner(c);
      const id = (await review(me, c.slug, { rating: 5, body: "Great" })).body.id as string;
      const reply = (s: Session, body: unknown) => http().put(`/v1/studio/reviews/${id}/reply`).set(auth(s)).send({ body });
      expect((await reply(me, "I reply to myself")).status).toBe(404);
      expect((await reply(await t.login(), "Outsider")).status).toBe(404);
      const first = await reply(owner, "Thank <b>you</b>‮");
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ reply: "Thank <b>you</b>" });
      const repliedAt = first.body.repliedAt;
      const edit = await reply(owner, "Thanks again");
      expect(edit.body).toMatchObject({ reply: "Thanks again", repliedAt });
      expect(await prisma.review.count({ where: { courseId: c.id } })).toBe(1);
      expect((await reply(owner, "")).status).toBe(400);
      const list = await http().get(`/v1/courses/${c.slug}/reviews`);
      expect(list.body.items[0]).toMatchObject({ reply: "Thanks again" });
      expect((await notifications(me.userId, "course.review_reply")).length).toBe(1); // the edit did not notify again
    });

    it("tells the authors about new reviews, at most once per course per 10 minutes", async () => {
      const owner = await creator();
      const c = await course(owner);
      await review(await learner(c), c.slug, { rating: 5 });
      await review(await learner(c), c.slug, { rating: 4 });
      const mine = await notifications(owner.userId, "course.review");
      expect(mine).toHaveLength(1);
      expect(mine[0].data).toMatchObject({ courseId: c.id });
    });

    it("lets a moderator hide and restore a review: out of the list and the average, audited, with a reason", async () => {
      const c = await course(await creator());
      const users = [await learner(c), await learner(c), await learner(c), await learner(c)];
      const ids: string[] = [];
      for (const [i, u] of users.entries()) ids.push((await review(u, c.slug, { rating: [5, 5, 5, 1][i], body: `r${i}` })).body.id);
      expect(await publicCourse(c.slug)).toMatchObject({ ratingAvg: 4, ratingCount: 4 });

      const hide = (id: string, s: Session = moderator, reason: unknown = "Abusive") => http().post(`/v1/admin/reviews/${id}/hide`).set(auth(s)).send({ reason });
      expect((await hide(ids[3], users[0])).status).toBe(403);
      expect((await hide(ids[3], moderator, "")).status).toBe(400);
      expect((await hide(ids[3])).status).toBe(200);
      expect(await publicCourse(c.slug)).toMatchObject({ ratingAvg: 5, ratingCount: 3 });
      const list = await http().get(`/v1/courses/${c.slug}/reviews`);
      expect(list.body.items.map((r: { body: string }) => r.body)).not.toContain("r3");
      const audit = await prisma.auditLog.findFirst({ where: { action: "course.review.hide", targetId: ids[3] } });
      expect(audit).toMatchObject({ actorId: moderator.userId });
      // The author still sees their own hidden review, marked hidden.
      expect((await http().get(`/v1/courses/${c.slug}/reviews/mine`).set(auth(users[3]))).body).toMatchObject({ hidden: true });

      expect((await http().post(`/v1/admin/reviews/${ids[3]}/unhide`).set(auth(moderator)).send({ reason: "Reviewed again" })).status).toBe(200);
      expect(await publicCourse(c.slug)).toMatchObject({ ratingAvg: 4, ratingCount: 4 });
      expect((await http().post(`/v1/admin/reviews/${uniq()}/hide`).set(auth(moderator)).send({ reason: "x" })).status).toBe(404);
    });

    it("hides a review while the enrolment is revoked and brings it back with the enrolment", async () => {
      const c = await course(await creator());
      const a = await learner(c);
      const b = await learner(c);
      const d = await learner(c);
      for (const [u, r] of [[a, 5], [b, 5], [d, 2]] as const) await review(u, c.slug, { rating: r });
      expect(await publicCourse(c.slug)).toMatchObject({ ratingAvg: 4, ratingCount: 3 });

      // d bought the course (order o1) and gets refunded.
      const enrolments = t.app.get(EnrolmentsService);
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: d.userId } }, data: { source: "PURCHASE", orderId: "order-r1" } });
      await prisma.$transaction((tx) => enrolments.revokeForOrder(tx, { courseId: c.id, userId: d.userId, orderId: "order-r1" }));
      expect(await publicCourse(c.slug)).toMatchObject({ ratingAvg: null, ratingCount: 2 });
      expect((await http().get(`/v1/courses/${c.slug}/reviews`)).body.items).toHaveLength(2);
      expect((await review(d, c.slug, { rating: 5 })).status).toBe(403); // no longer enrolled

      await prisma.$transaction((tx) => enrolments.grant(tx, { courseId: c.id, userId: d.userId, source: "PURCHASE", orderId: "order-r2" }));
      expect(await publicCourse(c.slug)).toMatchObject({ ratingAvg: 4, ratingCount: 3 });
      expect((await http().get(`/v1/courses/${c.slug}/reviews`)).body.items).toHaveLength(3);
    });

    it("a revoked review stays hidden if a moderator also hid it", async () => {
      const c = await course(await creator());
      const d = await learner(c);
      const id = (await review(d, c.slug, { rating: 2 })).body.id as string;
      const enrolments = t.app.get(EnrolmentsService);
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: d.userId } }, data: { source: "PURCHASE", orderId: "order-m1" } });
      await prisma.$transaction((tx) => enrolments.revokeForOrder(tx, { courseId: c.id, userId: d.userId, orderId: "order-m1" }));
      expect((await http().post(`/v1/admin/reviews/${id}/hide`).set(auth(moderator)).send({ reason: "Spam" })).status).toBe(200);
      await prisma.$transaction((tx) => enrolments.grant(tx, { courseId: c.id, userId: d.userId, source: "PURCHASE", orderId: "order-m2" }));
      expect((await publicCourse(c.slug)).ratingCount).toBe(0);
    });

    it("limits review writes to 10 per hour per user", async () => {
      const c = await course(await creator());
      const me = await learner(c);
      for (let i = 0; i < 10; i++) expect((await review(me, c.slug, { rating: 3 })).status).toBe(200);
      const res = await review(me, c.slug, { rating: 4 });
      expect(res.status).toBe(429);
    });
  });

  describe("lesson Q&A", () => {
    const ask = (s: Session, lessonId: string, body: unknown) => http().post(`/v1/learn/lessons/${lessonId}/questions`).set(auth(s)).send({ body });
    const answer = (s: Session, questionId: string, body: unknown) => http().post(`/v1/learn/questions/${questionId}/answers`).set(auth(s)).send({ body });
    const questions = (s: Session, lessonId: string, qs = "") => http().get(`/v1/learn/lessons/${lessonId}/questions${qs}`).set(auth(s));

    it("lets enrolled learners and authors ask; strangers cannot read or ask", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await learner(c);
      const stranger = await t.login();
      const q = await ask(me, c.lessonId, "How does <b>this</b> work?‮");
      expect(q.status).toBe(201);
      expect(q.body).toMatchObject({ body: "How does <b>this</b> work?", lessonId: c.lessonId, answerCount: 0 });
      expect((await ask(owner, c.lessonId, "Pinned note")).status).toBe(201);
      expect((await ask(stranger, c.lessonId, "Hi")).status).toBe(403);
      expect((await questions(stranger, c.lessonId)).status).toBe(403);
      expect((await ask(me, c.lessonId, "   ")).status).toBe(400);
      expect((await ask(me, c.lessonId, "x".repeat(2001))).status).toBe(400);
      expect((await ask(me, uniq(), "Hi")).status).toBe(404);
      expect((await http().get(`/v1/learn/lessons/${c.lessonId}/questions`)).status).toBe(401);
    });

    it("preview viewers can read the Q&A of a free-preview lesson but never post, and see nothing of members-only lessons", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await learner(c);
      expect((await ask(me, c.previewLessonId, "Question on the preview")).status).toBe(201);
      const viewer = await t.login();
      const read = await questions(viewer, c.previewLessonId);
      expect(read.status).toBe(200);
      expect(read.body.items).toHaveLength(1);
      expect((await ask(viewer, c.previewLessonId, "Can I ask?")).status).toBe(403);
      expect((await questions(viewer, c.lessonId)).status).toBe(403);
    });

    it("lists questions newest first with a cursor and the number of visible answers", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await learner(c);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await ask(me, c.lessonId, `q${i}`)).body.id);
      await answer(owner, ids[0], "a0");
      const p1 = await questions(me, c.lessonId, "?limit=2");
      expect(p1.body.items.map((q: { body: string }) => q.body)).toEqual(["q2", "q1"]);
      const p2 = await questions(me, c.lessonId, `?limit=2&cursor=${p1.body.nextCursor}`);
      expect(p2.body.items).toEqual([expect.objectContaining({ body: "q0", answerCount: 1 })]);
      expect(p2.body.nextCursor).toBeNull();
    });

    it("answers by learners and authors; isInstructor marks authors; the asker is told, an author's own answer is not echoed", async () => {
      const owner = await creator();
      const c = await course(owner);
      const asker = await learner(c);
      const peer = await learner(c);
      const q = (await ask(asker, c.lessonId, "Why?")).body.id as string;
      const byPeer = await answer(peer, q, "Because.");
      expect(byPeer.status).toBe(201);
      expect(byPeer.body).toMatchObject({ isInstructor: false, body: "Because." });
      const byOwner = await answer(owner, q, "Official answer");
      expect(byOwner.body).toMatchObject({ isInstructor: true });
      expect((await answer(await t.login(), q, "Outsider")).status).toBe(403);
      expect((await answer(peer, q, "")).status).toBe(400);
      expect((await answer(peer, q, "x".repeat(5001))).status).toBe(400);
      expect((await answer(peer, q, "x".repeat(5000))).status).toBe(201);
      expect((await answer(peer, uniq(), "?")).status).toBe(404);

      const list = await http().get(`/v1/learn/questions/${q}/answers`).set(auth(asker));
      expect(list.status).toBe(200);
      expect(list.body.items.map((a: { body: string }) => a.body.slice(0, 8))).toEqual(["xxxxxxxx", "Official", "Because."]);
      expect(list.body.items[1].author).toMatchObject({ displayName: expect.any(String) });
      const outsider = await t.login();
      expect((await http().get(`/v1/learn/questions/${q}/answers`).set(auth(outsider))).status).toBe(403);
      expect((await notifications(asker.userId, "course.answer")).length).toBe(3);
      expect((await notifications(peer.userId, "course.answer")).length).toBe(0);
    });

    it("tells the authors about new questions, at most once per course per 10 minutes, and not about their own", async () => {
      const owner = await creator();
      const c = await course(owner);
      await ask(owner, c.lessonId, "My own");
      expect(await notifications(owner.userId, "course.question")).toHaveLength(0);
      const me = await learner(c);
      await ask(me, c.lessonId, "One");
      await ask(me, c.lessonId, "Two");
      expect(await notifications(owner.userId, "course.question")).toHaveLength(1);
    });

    it("lets a moderator hide and restore a question or an answer; hidden content is out of every listing", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await learner(c);
      const q1 = (await ask(me, c.lessonId, "bad question")).body.id as string;
      const q2 = (await ask(me, c.lessonId, "good question")).body.id as string;
      const a1 = (await answer(me, q2, "bad answer")).body.id as string;
      await answer(me, q2, "good answer");

      const act = (kind: "questions" | "answers", id: string, verb: "hide" | "unhide", s: Session = moderator, reason: unknown = "Off topic") => http().post(`/v1/admin/${kind}/${id}/${verb}`).set(auth(s)).send({ reason });
      expect((await act("questions", q1, "hide", me)).status).toBe(403);
      expect((await act("questions", q1, "hide", moderator, "")).status).toBe(400);
      expect((await act("questions", q1, "hide")).status).toBe(200);
      expect((await act("answers", a1, "hide")).status).toBe(200);
      expect((await questions(me, c.lessonId)).body.items.map((q: { body: string }) => q.body)).toEqual(["good question"]);
      expect((await questions(me, c.lessonId)).body.items[0].answerCount).toBe(1);
      expect((await http().get(`/v1/learn/questions/${q2}/answers`).set(auth(me))).body.items.map((a: { body: string }) => a.body)).toEqual(["good answer"]);
      expect((await http().get(`/v1/learn/questions/${q1}/answers`).set(auth(me))).status).toBe(404);
      expect((await answer(me, q1, "late")).status).toBe(404);
      expect(await prisma.auditLog.count({ where: { action: { in: ["course.question.hide", "course.answer.hide"] }, actorId: moderator.userId, targetId: { in: [q1, a1] } } })).toBe(2);

      expect((await act("questions", q1, "unhide")).status).toBe(200);
      expect((await act("answers", a1, "unhide")).status).toBe(200);
      expect((await questions(me, c.lessonId)).body.items).toHaveLength(2);
    });

    it("loses access with the enrolment", async () => {
      const c = await course(await creator());
      const me = await learner(c);
      const q = (await ask(me, c.lessonId, "Hello?")).body.id as string;
      await prisma.$transaction((tx) => tx.enrolment.updateMany({ where: { courseId: c.id, userId: me.userId }, data: { revokedAt: new Date() } }));
      expect((await ask(me, c.lessonId, "Again?")).status).toBe(403);
      expect((await questions(me, c.lessonId)).status).toBe(403);
      expect((await answer(me, q, "me")).status).toBe(403);
    });

    it("limits questions to 20 and answers to 60 per hour per user", async () => {
      const owner = await creator();
      const c = await course(owner);
      const me = await learner(c);
      let qid = "";
      for (let i = 0; i < 20; i++) {
        const r = await ask(me, c.lessonId, `q${i}`);
        expect(r.status).toBe(201);
        qid = r.body.id;
      }
      expect((await ask(me, c.lessonId, "one too many")).status).toBe(429);
      for (let i = 0; i < 60; i++) expect((await answer(me, qid, `a${i}`)).status).toBe(201);
      expect((await answer(me, qid, "one too many")).status).toBe(429);
    });
  });
});
