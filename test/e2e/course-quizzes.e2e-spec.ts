import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
type Q = { id: string; prompt: string; kind: string; options: Array<{ id: string; text: string; isCorrect: boolean }> };

describe("course quizzes", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const uniq = () => Math.random().toString(36).slice(2, 10);

  const creator = async () => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };
  const studio = (courseId: string) => `/v1/studio/courses/${courseId}`;

  /** A free course (draft) with one section; lessons are made through the studio API. */
  async function draft(owner: Session) {
    const res = await http().post("/v1/studio/courses").set(auth(owner)).send({ title: `Quiz ${uniq()}`, description: "A course", categoryId, language: "en", pricePaise: "0" });
    expect(res.status).toBe(201);
    const c = res.body as { id: string; slug: string };
    const section = (await http().post(`${studio(c.id)}/sections`).set(auth(owner)).send({ title: "S" })).body as { id: string };
    return { ...c, sectionId: section.id };
  }
  const quizLesson = async (owner: Session, c: { id: string; sectionId: string }, extra: Record<string, unknown> = {}) => {
    const res = await http().post(`${studio(c.id)}/lessons`).set(auth(owner)).send({ sectionId: c.sectionId, title: "Quiz", type: "QUIZ", ...extra });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };
  const opt = (text: string, isCorrect = false) => ({ text, isCorrect });
  const twoQuestions = () => ({
    passPct: 50,
    questions: [
      { prompt: "Capital of France?", kind: "SINGLE", options: [opt("Paris", true), opt("Rome"), opt("Berlin")] },
      { prompt: "Primes?", kind: "MULTIPLE", options: [opt("2", true), opt("3", true), opt("4"), opt("6")] },
    ],
  });
  const putQuiz = (owner: Session, courseId: string, lessonId: string, body: unknown) => http().put(`${studio(courseId)}/lessons/${lessonId}/quiz`).set(auth(owner)).send(body as object);
  const publish = (courseId: string) => prisma.course.update({ where: { id: courseId }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
  async function enrolled(slug: string) {
    const s = await t.login();
    expect((await http().post(`/v1/courses/${slug}/enrol`).set(auth(s))).status).toBe(201);
    return s;
  }
  const view = (s: Session, quizId: string) => http().get(`/v1/learn/quizzes/${quizId}`).set(auth(s));
  const attempt = (s: Session, quizId: string, answers: unknown) => http().post(`/v1/learn/quizzes/${quizId}/attempts`).set(auth(s)).send({ answers });
  const answersFor = (qs: Q[], right: boolean) =>
    qs.map((q) => ({ questionId: q.id, optionIds: right ? q.options.filter((o) => o.isCorrect).map((o) => o.id) : [q.options.find((o) => !o.isCorrect)!.id] }));
  const enrolmentOf = (userId: string, courseId: string) => prisma.enrolment.findUniqueOrThrow({ where: { courseId_userId: { courseId, userId } } });

  /** Published free course with a required quiz lesson holding the two questions; returns the stored quiz as the author sees it. */
  async function quizCourse(over: { extraLesson?: boolean } = {}) {
    const owner = await creator();
    const c = await draft(owner);
    const lesson = await quizLesson(owner, c);
    if (over.extraLesson) await http().post(`${studio(c.id)}/lessons`).set(auth(owner)).send({ sectionId: c.sectionId, title: "Read", type: "ARTICLE", articleBody: "x" });
    const put = await putQuiz(owner, c.id, lesson.id, twoQuestions());
    expect(put.status).toBe(200);
    await publish(c.id);
    return { owner, c, lesson, quiz: put.body as { id: string; questions: Q[] } };
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("studio", () => {
    it("an author writes a quiz into a QUIZ lesson and reads it back with the answers marked", async () => {
      const owner = await creator();
      const c = await draft(owner);
      const lesson = await quizLesson(owner, c);
      const put = await putQuiz(owner, c.id, lesson.id, twoQuestions());
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ lessonId: lesson.id, passPct: 50 });
      expect(put.body.questions).toHaveLength(2);
      expect(put.body.questions[0].options.map((o: { isCorrect: boolean }) => o.isCorrect)).toEqual([true, false, false]);
      expect((await prisma.lesson.findUniqueOrThrow({ where: { id: lesson.id } })).quizId).toBe(put.body.id);
      const get = await http().get(`${studio(c.id)}/lessons/${lesson.id}/quiz`).set(auth(owner));
      expect(get.body).toEqual(put.body);
      const curriculum = await http().get(`${studio(c.id)}/curriculum`).set(auth(owner));
      expect(curriculum.body.sections[0].lessons[0].quizId).toBe(put.body.id);
    });

    it("keeps question and option ids that are sent back and gives new ones to new items; removed questions go", async () => {
      const owner = await creator();
      const c = await draft(owner);
      const lesson = await quizLesson(owner, c);
      const first = (await putQuiz(owner, c.id, lesson.id, twoQuestions())).body as { id: string; questions: Q[] };
      const [q1, q2] = first.questions;
      const second = await putQuiz(owner, c.id, lesson.id, {
        passPct: 80,
        questions: [
          { id: q1.id, prompt: "Capital of France, again?", kind: "SINGLE", options: [{ id: q1.options[0].id, text: "Paris!", isCorrect: true }, { id: q1.options[1].id, text: "Rome", isCorrect: false }, opt("Madrid")] },
          { prompt: "A new one", kind: "SINGLE", options: [opt("yes", true), opt("no")] },
        ],
      });
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.id);
      expect(second.body.passPct).toBe(80);
      expect(second.body.questions[0].id).toBe(q1.id);
      expect(second.body.questions[0].options.slice(0, 2).map((o: { id: string }) => o.id)).toEqual([q1.options[0].id, q1.options[1].id]);
      expect(second.body.questions[1].id).not.toBe(q2.id);
      expect(await prisma.quizQuestion.count({ where: { quizId: first.id } })).toBe(2);
    });

    it("validates questions: single choice has exactly one right option, multiple at least one, 2 to 10 options, a pass mark of 1 to 100", async () => {
      const owner = await creator();
      const c = await draft(owner);
      const lesson = await quizLesson(owner, c);
      const bad = async (q: unknown, passPct = 70) => (await putQuiz(owner, c.id, lesson.id, { passPct, questions: [q] })).status;
      expect(await bad({ prompt: "p", kind: "SINGLE", options: [opt("a", true), opt("b", true)] })).toBe(422);
      expect(await bad({ prompt: "p", kind: "SINGLE", options: [opt("a"), opt("b")] })).toBe(422);
      expect(await bad({ prompt: "p", kind: "MULTIPLE", options: [opt("a"), opt("b")] })).toBe(422);
      expect(await bad({ prompt: "p", kind: "SINGLE", options: [opt("a", true)] })).toBe(400);
      expect(await bad({ prompt: "p", kind: "SINGLE", options: Array.from({ length: 11 }, (_, i) => opt(`o${i}`, i === 0)) })).toBe(400);
      expect(await bad({ prompt: "p", kind: "SINGLE", options: [opt("a", true), opt("b")] }, 0)).toBe(400);
      expect(await bad({ prompt: "p", kind: "SINGLE", options: [opt("a", true), opt("b")] }, 101)).toBe(400);
      expect((await putQuiz(owner, c.id, lesson.id, { questions: [] })).status).toBe(400);
      expect(await bad({ prompt: "p", kind: "MULTIPLE", options: [opt("a", true), opt("b", true)] })).toBe(200);
    });

    it("only for a QUIZ lesson of a course the caller authors; outsiders get 404", async () => {
      const owner = await creator();
      const c = await draft(owner);
      const quiz = await quizLesson(owner, c);
      const article = (await http().post(`${studio(c.id)}/lessons`).set(auth(owner)).send({ sectionId: c.sectionId, title: "A", type: "ARTICLE", articleBody: "x" })).body as { id: string };
      const notQuiz = await putQuiz(owner, c.id, article.id, twoQuestions());
      expect(notQuiz.status).toBe(422);
      expect(notQuiz.body.error.code).toBe("LESSON_NOT_QUIZ");
      const outsider = await creator();
      expect((await putQuiz(outsider, c.id, quiz.id, twoQuestions())).status).toBe(404);
      expect((await http().get(`${studio(c.id)}/lessons/${quiz.id}/quiz`).set(auth(outsider))).status).toBe(404);
      expect((await http().get(`${studio(c.id)}/lessons/${quiz.id}/quiz`).set(auth(owner))).status).toBe(404); // no quiz written yet
    });

    it("respects the review edit lock", async () => {
      const owner = await creator();
      const c = await draft(owner);
      const lesson = await quizLesson(owner, c);
      await putQuiz(owner, c.id, lesson.id, twoQuestions());
      await prisma.course.update({ where: { id: c.id }, data: { status: "IN_REVIEW", submittedAt: new Date() } });
      const res = await putQuiz(owner, c.id, lesson.id, twoQuestions());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("COURSE_IN_REVIEW");
      expect((await http().delete(`${studio(c.id)}/lessons/${lesson.id}/quiz`).set(auth(owner))).status).toBe(409);
    });

    it("deleting the quiz clears the lesson's link; deleting the lesson removes its quiz", async () => {
      const owner = await creator();
      const c = await draft(owner);
      const a = await quizLesson(owner, c);
      const b = await quizLesson(owner, c);
      const qa = (await putQuiz(owner, c.id, a.id, twoQuestions())).body as { id: string };
      const qb = (await putQuiz(owner, c.id, b.id, twoQuestions())).body as { id: string };
      expect((await http().delete(`${studio(c.id)}/lessons/${a.id}/quiz`).set(auth(owner))).status).toBe(204);
      expect((await prisma.lesson.findUniqueOrThrow({ where: { id: a.id } })).quizId).toBeNull();
      expect(await prisma.quiz.count({ where: { id: qa.id } })).toBe(0);
      expect((await http().delete(`${studio(c.id)}/lessons/${b.id}`).set(auth(owner))).status).toBe(204);
      expect(await prisma.quiz.count({ where: { id: qb.id } })).toBe(0);
    });

    it("a QUIZ lesson cannot be a free preview", async () => {
      const owner = await creator();
      const c = await draft(owner);
      const create = await http().post(`${studio(c.id)}/lessons`).set(auth(owner)).send({ sectionId: c.sectionId, title: "Q", type: "QUIZ", isFreePreview: true });
      expect(create.status).toBe(422);
      expect(create.body.error.code).toBe("QUIZ_PREVIEW_NOT_ALLOWED");
      const lesson = await quizLesson(owner, c);
      const update = await http().patch(`${studio(c.id)}/lessons/${lesson.id}`).set(auth(owner)).send({ isFreePreview: true });
      expect(update.status).toBe(422);
      expect(update.body.error.code).toBe("QUIZ_PREVIEW_NOT_ALLOWED");
      expect((await http().patch(`${studio(c.id)}/lessons/${lesson.id}`).set(auth(owner)).send({ isFreePreview: false })).status).toBe(200);
    });

    it("submitting for review needs every quiz lesson to have questions", async () => {
      const owner = await creator();
      const c = await draft(owner);
      const lesson = await quizLesson(owner, c);
      const thumb = await prisma.mediaAsset.create({
        data: { ownerId: owner.userId, purpose: "THUMBNAIL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "image/png", declaredSize: 10n },
      });
      expect((await http().patch(studio(c.id)).set(auth(owner)).send({ thumbnailAssetId: thumb.id })).status).toBe(200);
      const empty = await http().post(`${studio(c.id)}/submit`).set(auth(owner));
      expect(empty.status).toBe(422);
      expect(empty.body.error.details.reasons.map((r: { code: string }) => r.code)).toEqual(["QUIZ_EMPTY"]);
      await putQuiz(owner, c.id, lesson.id, twoQuestions());
      expect((await http().post(`${studio(c.id)}/submit`).set(auth(owner))).status).toBe(200);
    });
  });

  describe("learner", () => {
    it("shows questions without the answers: no 'correct' or 'isCorrect' anywhere in the raw JSON", async () => {
      const { c, quiz } = await quizCourse();
      const me = await enrolled(c.slug);
      const res = await view(me, quiz.id);
      expect(res.status).toBe(200);
      expect(res.body.questions).toHaveLength(2);
      expect(res.body.questions[0].options[0]).toEqual({ id: quiz.questions[0].options[0].id, text: "Paris" });
      expect(res.body).toMatchObject({ passPct: 50, passed: false });
      expect(res.text).not.toMatch(/correct/i);
    });

    it("is closed to people who may not learn the course, and to free-preview viewers even when the lesson row says preview", async () => {
      const { c, lesson, quiz } = await quizCourse();
      const stranger = await t.login();
      const denied = await view(stranger, quiz.id);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("COURSE_NOT_ENROLLED");
      expect(denied.text).not.toContain("Paris");
      // legacy / tampered data: a QUIZ lesson flagged as free preview must still not open the questions
      await prisma.lesson.update({ where: { id: lesson.id }, data: { isFreePreview: true } });
      expect((await view(stranger, quiz.id)).status).toBe(403);
      expect((await attempt(stranger, quiz.id, [])).status).toBe(403);
      // a draft course is a 404 to outsiders
      await prisma.course.update({ where: { id: c.id }, data: { status: "DRAFT" } });
      expect((await view(stranger, quiz.id)).status).toBe(404);
      expect((await view(stranger, "00000000-0000-7000-8000-000000000000")).status).toBe(404);
    });

    it("authors can read the learner view but cannot attempt (no enrolment, no progress)", async () => {
      const { owner, quiz } = await quizCourse();
      const res = await view(owner, quiz.id);
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/correct/i);
      const a = await attempt(owner, quiz.id, []);
      expect(a.status).toBe(403);
      expect(a.body.error.code).toBe("COURSE_NOT_ENROLLED");
    });

    it("a refunded (revoked) learner can neither read nor attempt", async () => {
      const { c, quiz } = await quizCourse();
      const me = await enrolled(c.slug);
      await prisma.enrolment.update({ where: { courseId_userId: { courseId: c.id, userId: me.userId } }, data: { revokedAt: new Date() } });
      expect((await view(me, quiz.id)).status).toBe(403);
      expect((await attempt(me, quiz.id, [])).status).toBe(403);
    });

    it("a failed attempt reports the score and nothing about the answers; the quiz stays hidden", async () => {
      const { c, quiz } = await quizCourse();
      const me = await enrolled(c.slug);
      const res = await attempt(me, quiz.id, answersFor(quiz.questions, false));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ scorePct: 0, passed: false, passPct: 50 });
      expect(res.text).not.toMatch(/correct/i);
      expect(res.body.nextAttemptAt).toBe(new Date(t.clock.now().getTime() + 60_000).toISOString());
      const after = await view(me, quiz.id);
      expect(after.body.passed).toBe(false);
      expect(after.text).not.toMatch(/correct/i);
    });

    it("scores floor(100 x right / total); multiple choice needs the exact set", async () => {
      const { c, quiz } = await quizCourse();
      const [q1, q2] = quiz.questions;
      const subset = await enrolled(c.slug);
      // question 1 right, only one of the two primes chosen: 1 of 2 = 50%, which meets the pass mark of 50
      const partial = await attempt(subset, quiz.id, [{ questionId: q1.id, optionIds: [q1.options[0].id] }, { questionId: q2.id, optionIds: [q2.options[0].id] }]);
      expect(partial.body).toMatchObject({ scorePct: 50, passed: true });
      const superset = await enrolled(c.slug);
      const sup = await attempt(superset, quiz.id, [{ questionId: q2.id, optionIds: q2.options.slice(0, 3).map((o) => o.id) }]);
      expect(sup.body).toMatchObject({ scorePct: 0, passed: false });
    });

    it("rejects malformed answers without recording an attempt or starting the cooldown", async () => {
      const { c, quiz } = await quizCourse();
      const me = await enrolled(c.slug);
      const [q1] = quiz.questions;
      expect((await attempt(me, quiz.id, [{ questionId: "nope", optionIds: ["x"] }])).status).toBe(422);
      expect((await attempt(me, quiz.id, [{ questionId: q1.id, optionIds: ["x"] }])).body.error.code).toBe("QUIZ_ANSWER_INVALID");
      expect((await attempt(me, quiz.id, [{ questionId: q1.id, optionIds: q1.options.map((o) => o.id) }])).status).toBe(422);
      expect((await http().post(`/v1/learn/quizzes/${quiz.id}/attempts`).set(auth(me)).send({})).status).toBe(400);
      expect(await prisma.quizAttempt.count({ where: { quizId: quiz.id, userId: me.userId } })).toBe(0);
      expect((await attempt(me, quiz.id, answersFor(quiz.questions, true))).status).toBe(201);
    });

    it("enforces a 60 second cooldown between attempts per learner and quiz, measured on the clock", async () => {
      const { c, quiz } = await quizCourse();
      const me = await enrolled(c.slug);
      const other = await enrolled(c.slug);
      expect((await attempt(me, quiz.id, answersFor(quiz.questions, false))).status).toBe(201);
      t.clock.advanceSec(59);
      const early = await attempt(me, quiz.id, answersFor(quiz.questions, true));
      expect(early.status).toBe(429);
      expect(early.body.error.code).toBe("QUIZ_COOLDOWN");
      expect(early.body.error.details.retryAfterSec).toBe(1);
      expect(early.headers["retry-after"]).toBe("1");
      expect((await attempt(other, quiz.id, answersFor(quiz.questions, false))).status).toBe(201); // other learners are unaffected
      t.clock.advanceSec(1);
      expect((await attempt(me, quiz.id, answersFor(quiz.questions, true))).status).toBe(201);
      expect(await prisma.quizAttempt.count({ where: { quizId: quiz.id, userId: me.userId } })).toBe(2);
    });

    it("parallel submissions: exactly one is accepted", async () => {
      const { c, quiz } = await quizCourse();
      const me = await enrolled(c.slug);
      const results = await Promise.all(Array.from({ length: 5 }, () => attempt(me, quiz.id, answersFor(quiz.questions, false))));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 429)).toHaveLength(4);
      expect(await prisma.quizAttempt.count({ where: { quizId: quiz.id, userId: me.userId } })).toBe(1);
    });

    it("a passing attempt completes the QUIZ lesson in the same transaction, finishes the course once, and reveals the answers", async () => {
      const { c, lesson, quiz } = await quizCourse();
      const me = await enrolled(c.slug);
      await attempt(me, quiz.id, answersFor(quiz.questions, false));
      t.clock.advanceSec(60);
      const pass = await attempt(me, quiz.id, answersFor(quiz.questions, true));
      expect(pass.status).toBe(201);
      expect(pass.body).toMatchObject({ scorePct: 100, passed: true });
      expect(pass.body.correct).toEqual({ [quiz.questions[0].id]: [quiz.questions[0].options[0].id], [quiz.questions[1].id]: [quiz.questions[1].options[0].id, quiz.questions[1].options[1].id] });
      const lp = await prisma.lessonProgress.findUnique({ where: { userId_lessonId: { userId: me.userId, lessonId: lesson.id } } });
      expect(lp?.completedAt).not.toBeNull();
      const e = await enrolmentOf(me.userId, c.id);
      expect(e).toMatchObject({ progressPct: 100 });
      expect(e.completedAt).not.toBeNull();
      const events = await prisma.outboxEvent.count({ where: { type: "course.completed", AND: [{ payload: { path: ["userId"], equals: me.userId } }, { payload: { path: ["courseId"], equals: c.id } }] } });
      expect(events).toBe(1);
      const after = await view(me, quiz.id);
      expect(after.body).toMatchObject({ passed: true });
      expect(after.body.questions[0].correct).toEqual([quiz.questions[0].options[0].id]);
    });

    it("a course with a quiz is not complete until the quiz is passed, even when everything else is done", async () => {
      const { c, lesson, quiz } = await quizCourse({ extraLesson: true });
      const me = await enrolled(c.slug);
      const article = await prisma.lesson.findFirstOrThrow({ where: { courseId: c.id, type: "ARTICLE" } });
      expect((await http().post(`/v1/learn/lessons/${article.id}/complete`).set(auth(me))).status).toBe(200);
      expect((await enrolmentOf(me.userId, c.id)).completedAt).toBeNull();
      // a quiz lesson is never completed by hand
      expect((await http().post(`/v1/learn/lessons/${lesson.id}/complete`).set(auth(me))).status).toBe(422);
      await attempt(me, quiz.id, answersFor(quiz.questions, false));
      expect((await enrolmentOf(me.userId, c.id)).completedAt).toBeNull();
      t.clock.advanceSec(60);
      await attempt(me, quiz.id, answersFor(quiz.questions, true));
      expect((await enrolmentOf(me.userId, c.id)).completedAt).not.toBeNull();
    });

    it("editing the quiz after a learner passed does not revoke the pass", async () => {
      const { owner, c, lesson, quiz } = await quizCourse();
      const me = await enrolled(c.slug);
      expect((await attempt(me, quiz.id, answersFor(quiz.questions, true))).body.passed).toBe(true);
      const edit = await putQuiz(owner, c.id, lesson.id, { passPct: 100, questions: [{ prompt: "Totally different", kind: "SINGLE", options: [opt("x", true), opt("y")] }] });
      expect(edit.status).toBe(200);
      const lp = await prisma.lessonProgress.findUniqueOrThrow({ where: { userId_lessonId: { userId: me.userId, lessonId: lesson.id } } });
      expect(lp.completedAt).not.toBeNull();
      expect((await enrolmentOf(me.userId, c.id)).completedAt).not.toBeNull();
      const after = await view(me, quiz.id);
      expect(after.body.passed).toBe(true);
      expect(after.body.questions[0].correct).toHaveLength(1); // the learner who passed sees the (new) answers
    });

    it("a quiz with no questions cannot be attempted", async () => {
      const owner = await creator();
      const c = await draft(owner);
      const lesson = await quizLesson(owner, c);
      await http().post(`${studio(c.id)}/lessons`).set(auth(owner)).send({ sectionId: c.sectionId, title: "Read", type: "ARTICLE", articleBody: "x" });
      await publish(c.id);
      const me = await enrolled(c.slug);
      const quiz = await prisma.quiz.create({ data: { courseId: c.id } });
      await prisma.lesson.update({ where: { id: lesson.id }, data: { quizId: quiz.id } });
      const res = await attempt(me, quiz.id, []);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("QUIZ_EMPTY");
    });
  });
});
