import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { COURSE_PROGRESS_READER, type CourseProgressReader } from "../../src/modules/courses";
import { ProgressService } from "../../src/modules/courses/progress.service";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("lesson progress", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let progressService: ProgressService;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const creator = async () => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };

  type Spec = { type: "VIDEO" | "ARTICLE" | "QUIZ" | "RESOURCE"; durationSec?: number; isRequired?: boolean; isFreePreview?: boolean };
  /** A published free course whose lessons are written straight to the tables, in the given order. */
  async function course(owner: Session, specs: Spec[]) {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Progress ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "0" });
    expect(res.status).toBe(201);
    const c = res.body as { id: string; slug: string };
    const section = await prisma.courseSection.create({ data: { courseId: c.id, title: "S", position: 0 } });
    const lessons = [];
    for (const [position, s] of specs.entries()) {
      lessons.push(
        await prisma.lesson.create({
          data: { courseId: c.id, sectionId: section.id, title: `L${position}`, type: s.type, position, durationSec: s.durationSec ?? null, isRequired: s.isRequired ?? true, isFreePreview: s.isFreePreview ?? false, articleBody: s.type === "ARTICLE" ? "text" : null },
        }),
      );
    }
    await prisma.course.update({ where: { id: c.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
    return { ...c, sectionId: section.id, lessons };
  }
  async function enrolled(slug: string) {
    const s = await t.login();
    expect((await http().post(`/v1/courses/${slug}/enrol`).set(auth(s))).status).toBe(201);
    return s;
  }
  const beat = (s: Session, lessonId: string, positionSec: number) => http().put(`/v1/learn/lessons/${lessonId}/progress`).set(auth(s)).send({ positionSec });
  const complete = (s: Session, lessonId: string) => http().post(`/v1/learn/lessons/${lessonId}/complete`).set(auth(s));
  const row = (userId: string, lessonId: string) => prisma.lessonProgress.findUnique({ where: { userId_lessonId: { userId, lessonId } } });
  const enrolment = (userId: string, courseId: string) => prisma.enrolment.findUniqueOrThrow({ where: { courseId_userId: { courseId, userId } } });
  const completedEvents = (userId: string, courseId: string) =>
    prisma.outboxEvent.count({ where: { type: "course.completed", AND: [{ payload: { path: ["userId"], equals: userId } }, { payload: { path: ["courseId"], equals: courseId } }] } });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    progressService = t.app.get(ProgressService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("heartbeat (Review Focus 4)", () => {
    it("credits no watch time for the first heartbeat, then at most the real time elapsed (and never more than the position moved)", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "VIDEO", durationSec: 600 }]);
      const v = c.lessons[0];
      const me = await enrolled(c.slug);

      expect((await beat(me, v.id, 120)).body).toMatchObject({ positionSec: 120, watchedSec: 0, completed: false });
      t.clock.advanceSec(10);
      expect((await beat(me, v.id, 130)).body).toMatchObject({ positionSec: 130, watchedSec: 10 });
      t.clock.advanceSec(10);
      expect((await beat(me, v.id, 135)).body.watchedSec).toBe(15); // moved 5, not 10
      t.clock.advanceSec(10);
      expect((await beat(me, v.id, 600)).body).toMatchObject({ positionSec: 600, watchedSec: 35, completed: false }); // a jump earns 2 x elapsed = 20 at most
      t.clock.advanceSec(10);
      expect((await beat(me, v.id, 100)).body).toMatchObject({ positionSec: 100, watchedSec: 35 }); // seeking back adds nothing
      const stored = await row(me.userId, v.id);
      expect(stored).toMatchObject({ positionSec: 100, courseId: c.id, completedAt: null });
      expect(stored!.watchedSec).toBe(35);
    });

    it("jumping the position to the end does not complete the lesson", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "VIDEO", durationSec: 600 }]);
      const me = await enrolled(c.slug);
      await beat(me, c.lessons[0].id, 0);
      t.clock.advanceSec(5);
      const res = await beat(me, c.lessons[0].id, 600);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ completed: false });
      expect(res.body.watchedSec).toBeLessThanOrEqual(10);
      expect((await row(me.userId, c.lessons[0].id))!.completedAt).toBeNull();
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(0);
    });

    it("real-time heartbeats complete the lesson at 90% watched, and the course percentage follows", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "VIDEO", durationSec: 100 }, { type: "ARTICLE" }]);
      const v = c.lessons[0];
      const me = await enrolled(c.slug);
      let last: request.Response | undefined;
      await beat(me, v.id, 0);
      for (let pos = 10; pos <= 80; pos += 10) {
        t.clock.advanceSec(10);
        last = await beat(me, v.id, pos);
      }
      expect(last!.body).toMatchObject({ watchedSec: 80, completed: false });
      t.clock.advanceSec(10);
      const done = await beat(me, v.id, 90);
      expect(done.body).toMatchObject({ watchedSec: 90, completed: true, courseProgressPct: 50 });
      expect((await row(me.userId, v.id))!.completedAt).not.toBeNull();
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(50);
      // further heartbeats keep the completion and the resume position
      t.clock.advanceSec(10);
      expect((await beat(me, v.id, 95)).body).toMatchObject({ completed: true, positionSec: 95 });
    });

    it("caps the watched time at the video's duration and the position at its end", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "VIDEO", durationSec: 20 }]);
      const me = await enrolled(c.slug);
      await beat(me, c.lessons[0].id, 0);
      t.clock.advanceSec(60);
      const res = await beat(me, c.lessons[0].id, 5000);
      expect(res.body).toMatchObject({ positionSec: 20, watchedSec: 20, completed: true });
    });

    it("allows one heartbeat per 5 seconds per lesson; a refused one changes nothing", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "VIDEO", durationSec: 600 }, { type: "VIDEO", durationSec: 600 }]);
      const me = await enrolled(c.slug);
      const [a, b] = c.lessons;
      expect((await beat(me, a.id, 0)).status).toBe(200);
      t.clock.advanceSec(4);
      const limited = await beat(me, a.id, 4);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe("RATE_LIMITED");
      expect((await row(me.userId, a.id))!.positionSec).toBe(0);
      expect((await beat(me, b.id, 0)).status).toBe(200); // another lesson has its own allowance
      t.clock.advanceSec(1);
      expect((await beat(me, a.id, 5)).body).toMatchObject({ positionSec: 5, watchedSec: 5 });
    });

    it("refuses anyone without an enrolment: strangers, free-preview viewers and authors write no progress", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "VIDEO", durationSec: 600, isFreePreview: true }, { type: "ARTICLE", isFreePreview: true }]);
      const stranger = await t.login();
      for (const who of [stranger, owner]) {
        const res = await beat(who, c.lessons[0].id, 0);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("COURSE_NOT_ENROLLED");
        expect((await complete(who, c.lessons[1].id)).status).toBe(403);
        expect(await row(who.userId, c.lessons[0].id)).toBeNull();
        expect(await row(who.userId, c.lessons[1].id)).toBeNull();
      }
      expect((await beat(stranger, "00000000-0000-7000-8000-000000000000", 0)).status).toBe(404);
    });

    it("a refunded learner can no longer write progress, and a learner of one course cannot complete another course's lesson", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "VIDEO", durationSec: 600 }, { type: "ARTICLE" }]);
      const other = await course(owner, [{ type: "ARTICLE" }]);
      const me = await enrolled(c.slug);
      expect((await complete(me, other.lessons[0].id)).status).toBe(403);
      expect(await row(me.userId, other.lessons[0].id)).toBeNull();
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: me.userId } }, data: { revokedAt: t.clock.now() } });
      expect((await beat(me, c.lessons[0].id, 0)).status).toBe(403);
      expect((await complete(me, c.lessons[1].id)).status).toBe(403);
    });

    it("heartbeats only apply to video lessons", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }]);
      const me = await enrolled(c.slug);
      const res = await beat(me, c.lessons[0].id, 5);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("LESSON_NOT_VIDEO");
    });

    it("validates the body", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "VIDEO", durationSec: 60 }]);
      const me = await enrolled(c.slug);
      for (const body of [{}, { positionSec: -1 }, { positionSec: 1.5 }, { positionSec: "7" }, { positionSec: 1, extra: true }]) {
        expect((await http().put(`/v1/learn/lessons/${c.lessons[0].id}/progress`).set(auth(me)).send(body)).status).toBe(400);
      }
    });

    it("the resume position comes back with the lesson and the course", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "VIDEO", durationSec: 600 }]);
      const me = await enrolled(c.slug);
      await beat(me, c.lessons[0].id, 42);
      expect((await http().get(`/v1/learn/lessons/${c.lessons[0].id}`).set(auth(me))).body.progress).toEqual({ positionSec: 42, completed: false });
      const outline = (await http().get(`/v1/learn/courses/${c.slug}`).set(auth(me))).body;
      expect(outline.sections[0].lessons[0]).toMatchObject({ positionSec: 42, completed: false });
    });
  });

  describe("manual completion", () => {
    it("articles and resources complete on request, idempotently; videos and quizzes do not", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }, { type: "RESOURCE" }, { type: "VIDEO", durationSec: 60 }, { type: "QUIZ", isRequired: false }]);
      const me = await enrolled(c.slug);
      expect((await complete(me, c.lessons[0].id)).body).toMatchObject({ completed: true, courseProgressPct: 33 });
      const first = (await row(me.userId, c.lessons[0].id))!.completedAt;
      t.clock.advanceSec(30);
      expect((await complete(me, c.lessons[0].id)).status).toBe(200);
      expect((await row(me.userId, c.lessons[0].id))!.completedAt).toEqual(first);
      expect((await complete(me, c.lessons[1].id)).body.courseProgressPct).toBe(66);
      for (const l of [c.lessons[2], c.lessons[3]]) {
        const res = await complete(me, l.id);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe("LESSON_NOT_COMPLETABLE");
      }
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(66);
    });
  });

  describe("course progress and completion", () => {
    it("counts required lessons only, rounds down, and emits course.completed exactly once", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }, { type: "ARTICLE" }, { type: "ARTICLE" }, { type: "ARTICLE", isRequired: false }]);
      const me = await enrolled(c.slug);
      await complete(me, c.lessons[3].id); // optional: does not count
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(0);
      await complete(me, c.lessons[0].id);
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(33);
      await complete(me, c.lessons[1].id);
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(66);
      expect((await enrolment(me.userId, c.id)).completedAt).toBeNull();
      await complete(me, c.lessons[2].id);
      const done = await enrolment(me.userId, c.id);
      expect(done.progressPct).toBe(100);
      expect(done.completedAt).not.toBeNull();
      expect(await completedEvents(me.userId, c.id)).toBe(1);
      await complete(me, c.lessons[2].id);
      expect(await completedEvents(me.userId, c.id)).toBe(1);
      expect((await http().get("/v1/me/learning").set(auth(me))).body.items[0]).toMatchObject({ progressPct: 100 });
    });

    it("a course with quizzes is complete only when every quiz lesson is done too", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }, { type: "QUIZ", isRequired: false }]);
      // a quiz lesson only blocks completion when there is something to attempt
      const quiz = await prisma.quiz.create({ data: { courseId: c.id, questions: { create: [{ prompt: "p", kind: "SINGLE", options: [{ id: "a", text: "a" }, { id: "b", text: "b" }], correct: ["a"], position: 0 }] } } });
      await prisma.lesson.update({ where: { id: c.lessons[1].id }, data: { quizId: quiz.id } });
      const me = await enrolled(c.slug);
      await complete(me, c.lessons[0].id);
      const waiting = await enrolment(me.userId, c.id);
      expect(waiting.progressPct).toBe(100);
      expect(waiting.completedAt).toBeNull();
      expect(await completedEvents(me.userId, c.id)).toBe(0);
      // the quiz feature calls this when an attempt passes
      await prisma.$transaction((tx) => progressService.markLessonCompleted(tx, me.userId, c.lessons[1].id, "QUIZ"));
      expect((await enrolment(me.userId, c.id)).completedAt).not.toBeNull();
      expect(await completedEvents(me.userId, c.id)).toBe(1);
      await prisma.$transaction((tx) => progressService.markLessonCompleted(tx, me.userId, c.lessons[1].id, "QUIZ"));
      expect(await completedEvents(me.userId, c.id)).toBe(1);
    });

    it("is recomputed when the author adds, toggles or removes required lessons", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }, { type: "ARTICLE" }]);
      const me = await enrolled(c.slug);
      const other = await enrolled(c.slug);
      await complete(me, c.lessons[0].id);
      await complete(other, c.lessons[0].id);
      await complete(other, c.lessons[1].id);
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(50);
      expect((await enrolment(other.userId, c.id)).completedAt).not.toBeNull();

      const added = await http().post(`/v1/studio/courses/${c.id}/lessons`).set(auth(owner)).send({ sectionId: c.sectionId, title: "New", type: "ARTICLE", articleBody: "x" });
      expect(added.status).toBe(201);
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(33);
      expect((await enrolment(other.userId, c.id)).progressPct).toBe(66); // finished learners keep their completion
      expect((await enrolment(other.userId, c.id)).completedAt).not.toBeNull();

      const toggle = (id: string, isRequired: boolean) => http().patch(`/v1/studio/courses/${c.id}/lessons/${id}`).set(auth(owner)).send({ isRequired });
      expect((await toggle(added.body.id, false)).status).toBe(200);
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(50);
      expect((await toggle(added.body.id, true)).status).toBe(200);
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(33);

      expect((await http().delete(`/v1/studio/courses/${c.id}/lessons/${c.lessons[1].id}`).set(auth(owner))).status).toBe(204);
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(50); // 1 of 2 required left
      expect((await http().delete(`/v1/studio/courses/${c.id}/lessons/${added.body.id}`).set(auth(owner))).status).toBe(204);
      const finished = await enrolment(me.userId, c.id);
      expect(finished.progressPct).toBe(100); // only the completed lesson remains
      expect(finished.completedAt).not.toBeNull();
      expect(await completedEvents(me.userId, c.id)).toBe(1);
    });
  });

  describe("refund eligibility reader", () => {
    it("reads the learner's real course progress", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }, { type: "ARTICLE" }, { type: "ARTICLE" }]);
      const me = await enrolled(c.slug);
      const reader = t.app.get<CourseProgressReader>(COURSE_PROGRESS_READER);
      expect(await reader.completedRequiredPct(me.userId, c.id)).toBe(0);
      await complete(me, c.lessons[0].id);
      expect(await reader.completedRequiredPct(me.userId, c.id)).toBe(33);
      expect(await reader.completedRequiredPct((await t.login()).userId, c.id)).toBe(0);
    });
  });

  describe("fix round 1: enrolment-level locking, recompute cost, reactivation", () => {
    const until = async <T,>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> => {
      const deadline = Date.now() + ms;
      for (;;) {
        const v = await read();
        if (v) return v;
        if (Date.now() > deadline) throw new Error("timed out waiting for condition");
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    it("two last required lessons completed in parallel still reach 100%, complete the enrolment and emit one event", async () => {
      for (let round = 0; round < 3; round++) {
        const owner = await creator();
        const c = await course(owner, [{ type: "ARTICLE" }, { type: "ARTICLE" }, { type: "RESOURCE" }]);
        const me = await enrolled(c.slug);
        await Promise.all(c.lessons.map((l) => complete(me, l.id)));
        const e = await enrolment(me.userId, c.id);
        expect(e.progressPct).toBe(100);
        expect(e.completedAt).not.toBeNull();
        expect(await completedEvents(me.userId, c.id)).toBe(1);
      }
    });

    it("parallel completions of the same final lesson emit one event", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }]);
      const me = await enrolled(c.slug);
      await Promise.all([complete(me, c.lessons[0].id), complete(me, c.lessons[0].id), complete(me, c.lessons[0].id)]);
      expect(await completedEvents(me.userId, c.id)).toBe(1);
    });

    it("parallel heartbeats at the same instant are credited once", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "VIDEO", durationSec: 600 }]);
      const me = await enrolled(c.slug);
      await beat(me, c.lessons[0].id, 0);
      t.clock.advanceSec(10);
      const results = await Promise.all([beat(me, c.lessons[0].id, 10), beat(me, c.lessons[0].id, 10), beat(me, c.lessons[0].id, 10)]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 429)).toHaveLength(2);
      expect((await row(me.userId, c.lessons[0].id))!.watchedSec).toBe(10);
    });

    it("an author edit racing a learner completion leaves the right percentage", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }, { type: "ARTICLE" }]);
      const me = await enrolled(c.slug);
      await Promise.all([
        complete(me, c.lessons[0].id),
        http().post(`/v1/studio/courses/${c.id}/lessons`).set(auth(owner)).send({ sectionId: c.sectionId, title: "New", type: "ARTICLE", articleBody: "x" }),
      ]);
      // 1 of 3 required completed
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(33);
    });

    it("lessons that cannot change a percentage do not trigger a recompute", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }]);
      await enrolled(c.slug);
      const spy = jest.spyOn(progressService, "recomputeCourse");
      const post = (body: object) => http().post(`/v1/studio/courses/${c.id}/lessons`).set(auth(owner)).send({ sectionId: c.sectionId, title: "N", ...body });
      const optional = await post({ type: "ARTICLE", articleBody: "x", isRequired: false });
      expect(optional.status).toBe(201);
      expect(spy.mock.calls.length).toBe(0);
      expect((await http().delete(`/v1/studio/courses/${c.id}/lessons/${optional.body.id}`).set(auth(owner))).status).toBe(204);
      expect(spy.mock.calls.length).toBe(0);
      expect((await post({ type: "ARTICLE", articleBody: "x" })).status).toBe(201);
      expect(spy.mock.calls.length).toBe(1);
      spy.mockRestore();
    });

    it("large courses recompute in a background job", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }, { type: "ARTICLE" }]);
      const a = await enrolled(c.slug);
      await enrolled(c.slug);
      await complete(a, c.lessons[0].id);
      const previous = progressService.inlineLimit;
      progressService.inlineLimit = 1;
      try {
        const added = await http().post(`/v1/studio/courses/${c.id}/lessons`).set(auth(owner)).send({ sectionId: c.sectionId, title: "New", type: "ARTICLE", articleBody: "x" });
        expect(added.status).toBe(201);
        await until(async () => (await enrolment(a.userId, c.id)).progressPct === 33);
      } finally {
        progressService.inlineLimit = previous;
      }
    });

    it("re-enrolling after a refund refreshes the percentage and completion", async () => {
      const owner = await creator();
      const c = await course(owner, [{ type: "ARTICLE" }, { type: "ARTICLE" }]);
      const me = await enrolled(c.slug);
      await complete(me, c.lessons[0].id);
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: me.userId } }, data: { revokedAt: t.clock.now() } });
      // while revoked the author removes the lesson the learner had not finished: the learner is now fully done
      expect((await http().delete(`/v1/studio/courses/${c.id}/lessons/${c.lessons[1].id}`).set(auth(owner))).status).toBe(204);
      expect((await enrolment(me.userId, c.id)).progressPct).toBe(50);
      expect((await http().post(`/v1/courses/${c.slug}/enrol`).set(auth(me))).status).toBe(201);
      const e = await enrolment(me.userId, c.id);
      expect(e.progressPct).toBe(100);
      expect(e.completedAt).not.toBeNull();
      expect(await completedEvents(me.userId, c.id)).toBe(1);
    });
  });
});
