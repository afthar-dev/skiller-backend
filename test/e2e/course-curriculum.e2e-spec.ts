import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { expectDeclared } from "../support/openapi-shape";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("course curriculum", () => {
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
  const newCourse = async (s: Session, over: Record<string, unknown> = {}) => {
    const res = await http()
      .post("/v1/studio/courses")
      .set(auth(s))
      .send({ title: `Curriculum ${uniq()}`, categoryId, language: "en", ...over });
    expect(res.status).toBe(201);
    return res.body as { id: string; slug: string };
  };
  const base = (courseId: string) => `/v1/studio/courses/${courseId}`;
  const addSection = async (s: Session, courseId: string, title = "Section") => {
    const res = await http().post(`${base(courseId)}/sections`).set(auth(s)).send({ title });
    expect(res.status).toBe(201);
    return res.body as { id: string; position: number };
  };
  const addLesson = (s: Session, courseId: string, sectionId: string, over: Record<string, unknown> = {}) =>
    http()
      .post(`${base(courseId)}/lessons`)
      .set(auth(s))
      .send({ sectionId, title: `Lesson ${uniq()}`, type: "ARTICLE", ...over });
  const curriculum = async (s: Session, courseId: string) => (await http().get(`${base(courseId)}/curriculum`).set(auth(s))).body as { version: string; sections: Array<{ id: string; position: number; lessons: Array<Record<string, unknown> & { id: string; position: number }> }> };
  const asset = (ownerId: string, purpose: "COURSE_LESSON" | "COURSE_RESOURCE", over: Record<string, unknown> = {}) =>
    prisma.mediaAsset.create({
      data: {
        ownerId,
        purpose,
        bucket: "PRIVATE",
        status: "READY",
        objectKey: `incoming/${uniq()}/source`,
        mime: purpose === "COURSE_LESSON" ? "video/mp4" : "application/pdf",
        declaredSize: 10n,
        durationSec: purpose === "COURSE_LESSON" ? 125.4 : null,
        ...over,
      },
    });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("sections and lessons", () => {
    it("creates, edits and deletes sections and lessons with dense positions", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const s1 = await addSection(c, course.id, "Intro");
      const s2 = await addSection(c, course.id, "Advanced");
      expect([s1.position, s2.position]).toEqual([0, 1]);

      const l1 = (await addLesson(c, course.id, s1.id, { title: "One" })).body;
      const l2 = (await addLesson(c, course.id, s1.id, { title: "Two" })).body;
      const l3 = (await addLesson(c, course.id, s1.id, { title: "Three", isFreePreview: true, isRequired: false })).body;
      expect([l1.position, l2.position, l3.position]).toEqual([0, 1, 2]);
      expect(l3).toMatchObject({ isFreePreview: true, isRequired: false, type: "ARTICLE" });
      expect(l1).toMatchObject({ isFreePreview: false, isRequired: true });

      const renamed = await http().patch(`${base(course.id)}/sections/${s1.id}`).set(auth(c)).send({ title: "Getting started" });
      expect(renamed.body.title).toBe("Getting started");
      const edited = await http().patch(`${base(course.id)}/lessons/${l2.id}`).set(auth(c)).send({ title: "Two!", isFreePreview: true });
      expect(edited.body).toMatchObject({ title: "Two!", isFreePreview: true });

      expect((await http().delete(`${base(course.id)}/lessons/${l1.id}`).set(auth(c))).status).toBe(204);
      const after = await curriculum(c, course.id);
      expect(after.sections[0].lessons.map((l) => [l.id, l.position])).toEqual([[l2.id, 0], [l3.id, 1]]);

      expect((await http().delete(`${base(course.id)}/sections/${s1.id}`).set(auth(c))).status).toBe(204);
      const gone = await curriculum(c, course.id);
      expect(gone.sections.map((s) => [s.id, s.position])).toEqual([[s2.id, 0]]);
      expect(await prisma.lesson.count({ where: { courseId: course.id } })).toBe(0);
    });

    it("rejects fields that do not belong to the lesson type and unknown sections", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const s = await addSection(c, course.id);
      expect((await addLesson(c, course.id, s.id, { type: "ARTICLE", videoAssetId: "00000000-0000-7000-8000-000000000000" })).status).toBe(400);
      expect((await addLesson(c, course.id, s.id, { type: "VIDEO", articleBody: "hi" })).status).toBe(400);
      expect((await addLesson(c, course.id, s.id, { type: "BOGUS" })).status).toBe(400);
      const otherCourse = await newCourse(c);
      const foreignSection = await addSection(c, otherCourse.id);
      const res = await addLesson(c, course.id, foreignSection.id);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("SECTION_NOT_FOUND");
    });

    it("is author-only: another creator gets 404, an org learner 403", async () => {
      const a = await creator();
      const b = await creator();
      const course = await newCourse(a);
      const s = await addSection(a, course.id);
      for (const res of [
        await http().get(`${base(course.id)}/curriculum`).set(auth(b)),
        await http().post(`${base(course.id)}/sections`).set(auth(b)).send({ title: "x" }),
        await http().post(`${base(course.id)}/lessons`).set(auth(b)).send({ sectionId: s.id, title: "x", type: "ARTICLE" }),
        await http().put(`${base(course.id)}/order`).set(auth(b)).send({ sections: [], expectedVersion: "x" }),
      ]) {
        expect(res.status).toBe(404);
      }

      const instructor = await t.login();
      const owner = await creator();
      const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
      const grant = async (userId: string, roleKey: string) => prisma.userRole.create({ data: { userId, orgId: org.id, roleId: (await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })).id } });
      await grant(owner.userId, "org_owner");
      await grant(instructor.userId, "org_instructor");
      const orgCourse = await newCourse(instructor, { ownerType: "ORG", orgId: org.id });
      const learner = await t.login();
      await grant(learner.userId, "org_learner");
      expect((await http().post(`${base(orgCourse.id)}/sections`).set(auth(instructor)).send({ title: "ok" })).status).toBe(201);
      expect((await http().post(`${base(orgCourse.id)}/sections`).set(auth(learner)).send({ title: "no" })).status).toBe(403);
    });
  });

  describe("ordering", () => {
    async function seeded() {
      const c = await creator();
      const course = await newCourse(c);
      const sections = [await addSection(c, course.id, "A"), await addSection(c, course.id, "B"), await addSection(c, course.id, "C")];
      const lessons: string[][] = [[], [], []];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) lessons[i].push((await addLesson(c, course.id, sections[i].id, { title: `L${i}${j}` })).body.id);
      return { c, course, sections, lessons };
    }

    it("applies a full reorder, moving lessons across sections, with dense positions", async () => {
      const { c, course, sections, lessons } = await seeded();
      const order = {
        expectedVersion: (await curriculum(c, course.id)).version,
        sections: [
          { id: sections[2].id, lessonIds: [lessons[0][1], lessons[2][0]] },
          { id: sections[0].id, lessonIds: [] },
          { id: sections[1].id, lessonIds: [lessons[1][1], lessons[0][0], lessons[1][0], lessons[2][1]] },
        ],
      };
      const res = await http().put(`${base(course.id)}/order`).set(auth(c)).send(order);
      expect(res.status).toBe(200);
      const view = await curriculum(c, course.id);
      expect(view.sections.map((s) => [s.id, s.position])).toEqual(order.sections.map((s, i) => [s.id, i]));
      for (const [i, section] of view.sections.entries()) {
        expect(section.lessons.map((l) => l.id)).toEqual(order.sections[i].lessonIds);
        expect(section.lessons.map((l) => l.position)).toEqual(order.sections[i].lessonIds.map((_, p) => p));
      }
      expect(res.body.sections.map((s: { id: string }) => s.id)).toEqual(order.sections.map((s) => s.id));
    });

    it("rejects anything that is not an exact permutation and changes nothing", async () => {
      const { c, course, sections, lessons } = await seeded();
      const before = JSON.stringify(await curriculum(c, course.id));
      const expectedVersion = (JSON.parse(before) as { version: string }).version;
      const all = lessons.flat();
      const foreign = (await addLesson(c, course.id, (await addSection(c, (await newCourse(c)).id)).id).catch(() => null)) ?? null;
      void foreign;
      const bad: Array<Record<string, unknown>> = [
        { sections: [{ id: sections[0].id, lessonIds: all }] }, // missing sections
        { sections: sections.map((s, i) => ({ id: s.id, lessonIds: i === 0 ? all.slice(1) : [] })) }, // missing a lesson
        { sections: sections.map((s, i) => ({ id: s.id, lessonIds: i === 0 ? [...all, all[0]] : [] })) }, // duplicate lesson
        { sections: [...sections.map((s, i) => ({ id: s.id, lessonIds: i === 0 ? all : [] })), { id: sections[0].id, lessonIds: [] }] }, // duplicate section
        { sections: sections.map((s, i) => ({ id: s.id, lessonIds: i === 0 ? [...all, "00000000-0000-7000-8000-000000000000"] : [] })) }, // unknown lesson
        { sections: [...sections.map((s, i) => ({ id: s.id, lessonIds: i === 0 ? all : [] })), { id: "00000000-0000-7000-8000-000000000000", lessonIds: [] }] }, // unknown section
      ];
      for (const body of bad) {
        const res = await http().put(`${base(course.id)}/order`).set(auth(c)).send({ ...body, expectedVersion });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe("ORDER_INVALID");
      }
      expect((await http().put(`${base(course.id)}/order`).set(auth(c)).send({ sections: "nope", expectedVersion })).status).toBe(400);
      expect(JSON.stringify(await curriculum(c, course.id))).toBe(before);
    });

    it("answers 409 ORDER_STALE when the curriculum changed since the version the order was built from", async () => {
      const { c, course, sections, lessons } = await seeded();
      const seen = await curriculum(c, course.id);
      const shape = (ids: string[], lessonIds: string[][]) => ({ sections: ids.map((id, i) => ({ id, lessonIds: lessonIds[i] })) });
      // tab A reorders sections and saves from the version both tabs loaded
      const a = await http().put(`${base(course.id)}/order`).set(auth(c)).send({ ...shape([sections[2].id, sections[0].id, sections[1].id], [lessons[2], lessons[0], lessons[1]]), expectedVersion: seen.version });
      expect(a.status).toBe(200);
      expect(a.body.version).not.toBe(seen.version);
      const afterA = JSON.stringify(await curriculum(c, course.id));
      // tab B built a different full permutation from the same, now stale, version
      const b = await http().put(`${base(course.id)}/order`).set(auth(c)).send({ ...shape(sections.map((s) => s.id), [[lessons[0][1], lessons[0][0]], lessons[1], lessons[2]]), expectedVersion: seen.version });
      expect(b.status).toBe(409);
      expect(b.body.error.code).toBe("ORDER_STALE");
      expect(JSON.stringify(await curriculum(c, course.id))).toBe(afterA);
      // the version from A's response is current
      const again = await http().put(`${base(course.id)}/order`).set(auth(c)).send({ ...shape(sections.map((s) => s.id), lessons), expectedVersion: a.body.version });
      expect(again.status).toBe(200);
      // a missing version is a validation error; adding a lesson also stales it
      expect((await http().put(`${base(course.id)}/order`).set(auth(c)).send(shape(sections.map((s) => s.id), lessons))).status).toBe(400);
      const v = (await curriculum(c, course.id)).version;
      await addLesson(c, course.id, sections[0].id);
      const stale = await http().put(`${base(course.id)}/order`).set(auth(c)).send({ ...shape(sections.map((s) => s.id), lessons), expectedVersion: v });
      expect(stale.status).toBe(409);
    });

    it("concurrent lesson creation keeps positions dense and unique", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const s = await addSection(c, course.id);
      const results = await Promise.all(Array.from({ length: 6 }, () => addLesson(c, course.id, s.id)));
      expect(results.every((r) => r.status === 201)).toBe(true);
      const view = await curriculum(c, course.id);
      expect(view.sections[0].lessons.map((l) => l.position)).toEqual([0, 1, 2, 3, 4, 5]);
    });
  });

  describe("video and resource lessons", () => {
    it("attaches a READY lesson video owned by the creator and copies its duration", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const s = await addSection(c, course.id);
      const video = await asset(c.userId, "COURSE_LESSON");
      const res = await addLesson(c, course.id, s.id, { type: "VIDEO", videoAssetId: video.id });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ type: "VIDEO", videoAssetId: video.id, durationSec: 125 });
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: video.id } })).attachedAt).not.toBeNull();

      // the same asset cannot back a second lesson
      expect((await addLesson(c, course.id, s.id, { type: "VIDEO", videoAssetId: video.id })).status).toBe(409);

      // swapping releases the old one and re-copies the duration
      const next = await asset(c.userId, "COURSE_LESSON", { durationSec: 60 });
      const swap = await http().patch(`${base(course.id)}/lessons/${res.body.id}`).set(auth(c)).send({ videoAssetId: next.id });
      expect(swap.body).toMatchObject({ videoAssetId: next.id, durationSec: 60 });
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: video.id } })).attachedAt).toBeNull();

      // deleting the lesson releases the asset
      expect((await http().delete(`${base(course.id)}/lessons/${res.body.id}`).set(auth(c))).status).toBe(204);
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: next.id } })).attachedAt).toBeNull();
    });

    it("rejects another user's asset, a non-READY asset and the wrong purpose with MEDIA_NOT_USABLE", async () => {
      const c = await creator();
      const other = await creator();
      const course = await newCourse(c);
      const s = await addSection(c, course.id);
      const cases = [
        await asset(other.userId, "COURSE_LESSON"),
        await asset(c.userId, "COURSE_LESSON", { status: "PROCESSING" }),
        await asset(c.userId, "COURSE_RESOURCE"),
      ];
      for (const a of cases) {
        const res = await addLesson(c, course.id, s.id, { type: "VIDEO", videoAssetId: a.id });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe("MEDIA_NOT_USABLE");
      }
      expect((await addLesson(c, course.id, s.id, { type: "VIDEO", videoAssetId: "00000000-0000-7000-8000-000000000000" })).body.error.code).toBe("MEDIA_NOT_USABLE");
      expect(await prisma.lesson.count({ where: { courseId: course.id } })).toBe(0);
    });

    it("attaches a resource file to a RESOURCE lesson", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const s = await addSection(c, course.id);
      const file = await asset(c.userId, "COURSE_RESOURCE");
      const res = await addLesson(c, course.id, s.id, { type: "RESOURCE", resourceAssetId: file.id });
      expect(res.status).toBe(201);
      expect(res.body.resourceAssetId).toBe(file.id);
      expect(res.body.durationSec).toBeNull();
    });

    it("an org course accepts assets uploaded by any org author, but not by an outsider", async () => {
      const owner = await creator();
      const instructor = await t.login();
      const outsider = await creator();
      const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
      for (const [user, key] of [[owner, "org_owner"], [instructor, "org_instructor"]] as const) {
        await prisma.userRole.create({ data: { userId: user.userId, orgId: org.id, roleId: (await prisma.role.findUniqueOrThrow({ where: { key } })).id } });
      }
      const course = await newCourse(instructor, { ownerType: "ORG", orgId: org.id });
      const s = await addSection(instructor, course.id);
      const byOwner = await asset(owner.userId, "COURSE_LESSON", { orgId: org.id });
      expect((await addLesson(instructor, course.id, s.id, { type: "VIDEO", videoAssetId: byOwner.id })).status).toBe(201);
      const byOutsider = await asset(outsider.userId, "COURSE_LESSON", { orgId: org.id });
      const denied = await addLesson(instructor, course.id, s.id, { type: "VIDEO", videoAssetId: byOutsider.id });
      expect(denied.status).toBe(422);
      expect(denied.body.error.code).toBe("MEDIA_NOT_USABLE");
    });

    it("deleting a draft course releases lesson media too", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const s = await addSection(c, course.id);
      const video = await asset(c.userId, "COURSE_LESSON");
      const file = await asset(c.userId, "COURSE_RESOURCE");
      await addLesson(c, course.id, s.id, { type: "VIDEO", videoAssetId: video.id });
      await addLesson(c, course.id, s.id, { type: "RESOURCE", resourceAssetId: file.id });
      expect((await http().delete(base(course.id)).set(auth(c))).status).toBe(204);
      for (const a of [video, file]) expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: a.id } })).attachedAt).toBeNull();
    });
  });

  describe("article markdown", () => {
    it("rejects raw HTML and dangerous links with MARKDOWN_UNSAFE and stores nothing", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const s = await addSection(c, course.id);
      for (const body of ["# Hello\n<script>alert(1)</script>", "[x](javascript:alert(1))", "\\`[x](javascript:alert(1))\\`", "[y](data:text/html,hi)"]) {
        const res = await addLesson(c, course.id, s.id, { articleBody: body });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe("MARKDOWN_UNSAFE");
        expect(res.body.error.details.issues.length).toBeGreaterThan(0);
      }
      expect(await prisma.lesson.count({ where: { courseId: course.id } })).toBe(0);
    });

    it("stores valid Markdown byte for byte and rejects an unsafe edit", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const s = await addSection(c, course.id);
      const body = "# Hello\n\n> quote, a > b\n\n[ok](https://example.com)\n\nUse `List<String>`.\n\n```html\n<script>alert(1)</script>\n```\n";
      const res = await addLesson(c, course.id, s.id, { articleBody: body });
      expect(res.status).toBe(201);
      expect(res.body.articleBody).toBe(body);
      expect((await prisma.lesson.findUniqueOrThrow({ where: { id: res.body.id } })).articleBody).toBe(body);

      const patched = await http().patch(`${base(course.id)}/lessons/${res.body.id}`).set(auth(c)).send({ articleBody: "<iframe src=//evil></iframe>" });
      expect(patched.status).toBe(422);
      expect((await prisma.lesson.findUniqueOrThrow({ where: { id: res.body.id } })).articleBody).toBe(body);
    });

    it("limits the article to 50,000 characters", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const s = await addSection(c, course.id);
      expect((await addLesson(c, course.id, s.id, { articleBody: "a".repeat(50_001) })).status).toBe(400);
      expect((await addLesson(c, course.id, s.id, { articleBody: "a".repeat(50_000) })).status).toBe(201);
    });

    it("validates the course description too", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const bad = await http().patch(base(course.id)).set(auth(c)).send({ description: "Hi <script>alert(1)</script>" });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe("MARKDOWN_UNSAFE");
      const ok = await http().patch(base(course.id)).set(auth(c)).send({ description: "Hi [x](https://example.com)" });
      expect(ok.body.description).toBe("Hi [x](https://example.com)");
      const create = await http().post("/v1/studio/courses").set(auth(c)).send({ title: `Bad ${uniq()}`, categoryId, language: "en", description: "<b>x</b>" });
      expect(create.status).toBe(422);
    });
  });

  describe("author vs public view", () => {
    it("authors see everything; the public sees titles, durations and free-preview flags, and video ids only for previews", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const s = await addSection(c, course.id, "Basics");
      const paidVideo = await asset(c.userId, "COURSE_LESSON");
      const previewVideo = await asset(c.userId, "COURSE_LESSON");
      const resource = await asset(c.userId, "COURSE_RESOURCE");
      await addLesson(c, course.id, s.id, { title: "Paid", type: "VIDEO", videoAssetId: paidVideo.id });
      await addLesson(c, course.id, s.id, { title: "Preview", type: "VIDEO", videoAssetId: previewVideo.id, isFreePreview: true });
      await addLesson(c, course.id, s.id, { title: "Notes", type: "ARTICLE", articleBody: "secret notes" });
      await addLesson(c, course.id, s.id, { title: "Files", type: "RESOURCE", resourceAssetId: resource.id });

      const mine = await curriculum(c, course.id);
      const paid = mine.sections[0].lessons[0];
      expect(paid).toMatchObject({ title: "Paid", videoAssetId: paidVideo.id, durationSec: 125 });
      expect(mine.sections[0].lessons[2]).toMatchObject({ articleBody: "secret notes" });

      // a draft is not public
      expect((await http().get(`/v1/courses/${course.slug}/curriculum`)).status).toBe(404);

      await prisma.course.update({ where: { id: course.id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });
      const pub = await http().get(`/v1/courses/${course.slug}/curriculum`);
      expectDeclared(pub, "GET /v1/courses/{slug}/curriculum");
      expect(pub.status).toBe(200);
      const lessons = pub.body.sections[0].lessons as Array<Record<string, unknown>>;
      expect(pub.body.sections[0].title).toBe("Basics");
      expect(lessons.map((l) => l.title)).toEqual(["Paid", "Preview", "Notes", "Files"]);
      expect(lessons.map((l) => l.isFreePreview)).toEqual([false, true, false, false]);
      expect(lessons[0]).toEqual({ id: expect.any(String), title: "Paid", type: "VIDEO", position: 0, durationSec: 125, isFreePreview: false });
      expect(lessons[1]).toMatchObject({ videoAssetId: previewVideo.id, isFreePreview: true });
      const text = JSON.stringify(pub.body);
      expect(text).not.toContain(paidVideo.id);
      expect(text).not.toContain(resource.id);
      expect(text).not.toContain("secret notes");
      expect(pub.body.totals).toMatchObject({ sections: 1, lessons: 4, durationSec: 250 });
    });

    it("archived courses are not publicly browsable either", async () => {
      const c = await creator();
      const course = await newCourse(c);
      await prisma.course.update({ where: { id: course.id }, data: { status: "ARCHIVED", publishedAt: new Date(), slugLockedAt: new Date() } });
      expect((await http().get(`/v1/courses/${course.slug}/curriculum`)).status).toBe(404);
    });
  });
});
