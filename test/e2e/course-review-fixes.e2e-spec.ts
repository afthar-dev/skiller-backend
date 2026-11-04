import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { PermissionService, PlatformRoleDirectory } from "../../src/modules/rbac";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("course review fixes", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let categoryId: string;
  let moderator: Session;
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
  const thumb = (ownerId: string, orgId: string | null = null) => prisma.mediaAsset.create({ data: { ownerId, orgId, purpose: "THUMBNAIL", bucket: "PUBLIC", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "image/png", declaredSize: 10n } });
  /** A complete course ready to submit; thumbOwner owns the thumbnail (the org owner for org courses). */
  async function completeCourse(author: Session, over: Record<string, unknown> = {}, thumbOwner: Session = author) {
    const res = await http().post("/v1/studio/courses").set(auth(author)).send({ title: `Fixes ${uniq()}`, description: "A course", categoryId, language: "en", ...over });
    expect(res.status).toBe(201);
    const course = res.body as { id: string; slug: string };
    expect((await http().patch(base(course.id)).set(auth(author)).send({ thumbnailAssetId: (await thumb(thumbOwner.userId, (over.orgId as string | undefined) ?? null)).id })).status).toBe(200);
    const section = (await http().post(`${base(course.id)}/sections`).set(auth(author)).send({ title: "S" })).body;
    const lesson = (await http().post(`${base(course.id)}/lessons`).set(auth(author)).send({ sectionId: section.id, title: "L", type: "ARTICLE" })).body;
    return { ...course, sectionId: section.id as string, lessonId: lesson.id as string };
  }
  const submit = (s: Session, id: string) => http().post(`${base(id)}/submit`).set(auth(s));
  const act = (action: string, id: string, s: Session, body: object = { reason: "because" }) => http().post(`/v1/admin/courses/${id}/${action}`).set(auth(s)).send(body);

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
    moderator = await t.login();
    await grantRole(moderator.userId, "moderator");
  });
  afterAll(() => t?.close());

  describe("moderators do not review their own courses", () => {
    it("a creator who is also a moderator cannot approve, reject, flag or unflag their own course", async () => {
      const both = await creator();
      await grantRole(both.userId, "moderator");
      const own = await completeCourse(both);
      expect((await submit(both, own.id)).status).toBe(200);
      for (const action of ["approve", "reject"]) {
        const res = await act(action, own.id, both);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("COURSE_REVIEW_SELF");
      }
      expect((await prisma.course.findUniqueOrThrow({ where: { id: own.id } })).status).toBe("IN_REVIEW");
      expect((await act("approve", own.id, moderator)).status).toBe(200); // someone else can
      for (const action of ["flag", "unflag"]) {
        const res = await act(action, own.id, both);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("COURSE_REVIEW_SELF");
      }
      expect((await prisma.course.findUniqueOrThrow({ where: { id: own.id } })).flaggedAt).toBeNull();
    });

    it("an org instructor or owner with course.review cannot review the organization course; another moderator can", async () => {
      const owner = await creator();
      const instructor = await t.login();
      const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
      await grantRole(owner.userId, "org_owner", org.id);
      await grantRole(instructor.userId, "org_instructor", org.id);
      await grantRole(instructor.userId, "moderator");
      await grantRole(owner.userId, "moderator");
      const course = await completeCourse(instructor, { ownerType: "ORG", orgId: org.id }, owner);
      expect((await submit(instructor, course.id)).status).toBe(200);
      for (const who of [instructor, owner]) {
        for (const action of ["approve", "reject"]) expect((await act(action, course.id, who)).body.error.code).toBe("COURSE_REVIEW_SELF");
      }
      expect((await prisma.course.findUniqueOrThrow({ where: { id: course.id } })).status).toBe("IN_REVIEW");

      const other = await creator();
      await grantRole(other.userId, "moderator");
      expect((await act("approve", course.id, other)).status).toBe(200);
    });
  });

  describe("review edit lock and withdraw", () => {
    it("blocks every content edit while the course is in review; withdraw returns it to draft", async () => {
      const c = await creator();
      const course = await completeCourse(c);
      expect((await submit(c, course.id)).status).toBe(200);
      const blocked = [
        await http().patch(base(course.id)).set(auth(c)).send({ title: "Changed" }),
        await http().post(`${base(course.id)}/sections`).set(auth(c)).send({ title: "New" }),
        await http().patch(`${base(course.id)}/sections/${course.sectionId}`).set(auth(c)).send({ title: "New" }),
        await http().post(`${base(course.id)}/lessons`).set(auth(c)).send({ sectionId: course.sectionId, title: "X", type: "ARTICLE" }),
        await http().patch(`${base(course.id)}/lessons/${course.lessonId}`).set(auth(c)).send({ title: "X" }),
        await http().delete(`${base(course.id)}/lessons/${course.lessonId}`).set(auth(c)),
        await http().put(`${base(course.id)}/order`).set(auth(c)).send({ sections: [{ id: course.sectionId, lessonIds: [course.lessonId] }] }),
        await http().delete(`${base(course.id)}/sections/${course.sectionId}`).set(auth(c)),
        await http().patch(base(course.id)).set(auth(c)).send({ thumbnailAssetId: (await thumb(c.userId)).id }),
      ];
      for (const res of blocked) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("COURSE_IN_REVIEW");
      }
      expect(await prisma.lesson.count({ where: { courseId: course.id } })).toBe(1);

      const other = await creator();
      expect((await http().post(`${base(course.id)}/withdraw`).set(auth(other))).status).toBe(404);
      expect((await http().post(`${base(course.id)}/withdraw`).set(auth(moderator))).status).toBe(403);
      const res = await http().post(`${base(course.id)}/withdraw`).set(auth(c));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("DRAFT");
      expect(await prisma.auditLog.count({ where: { action: "course.withdraw", targetId: course.id } })).toBe(1);
      expect((await http().patch(base(course.id)).set(auth(c)).send({ title: "Changed" })).status).toBe(200);
      expect((await http().post(`${base(course.id)}/withdraw`).set(auth(c))).status).toBe(409);
      const queue = await http().get("/v1/admin/courses/review-queue").query({ limit: 100 }).set(auth(moderator));
      expect(queue.body.items.map((x: { id: string }) => x.id)).not.toContain(course.id);
    });
  });

  describe("moderators are told about new submissions", () => {
    it("every course.review holder except the submitter gets an in-app notification; the lookup is capped", async () => {
      const c = await creator();
      const second = await t.login();
      await grantRole(second.userId, "moderator");
      const course = await completeCourse(c);
      expect((await submit(c, course.id)).status).toBe(200);
      for (const m of [moderator, second]) {
        const n = await prisma.notification.findMany({ where: { userId: m.userId, type: "course.submitted" } });
        expect(n.map((x) => (x.data as { courseId: string }).courseId)).toContain(course.id);
      }
      expect(await prisma.notification.count({ where: { userId: c.userId, type: "course.submitted" } })).toBe(0);
      const dir = t.app.get(PlatformRoleDirectory);
      expect((await dir.userIdsWithPermission("course.review", 1)).length).toBe(1);
      const all = await dir.userIdsWithPermission("course.review", 50);
      expect(all).toEqual(expect.arrayContaining([moderator.userId, second.userId]));
    });
  });

  describe("organization seats follow a live learner grant", () => {
    it("the daily sweep revokes ORG_SEAT enrolments whose learner grant has expired, and nothing else", async () => {
      const owner = await creator();
      const learner = await t.login();
      const keeper = await t.login();
      const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
      await grantRole(owner.userId, "org_owner", org.id);
      await grantRole(learner.userId, "org_learner", org.id, new Date(t.clock.now().getTime() + 3_600_000));
      await grantRole(keeper.userId, "org_learner", org.id);
      const course = await completeCourse(owner, { ownerType: "ORG", orgId: org.id, pricePaise: "50000" });
      await prisma.course.update({ where: { id: course.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
      expect((await http().post(`/v1/courses/${course.slug}/enrol`).set(auth(learner))).status).toBe(201);
      expect((await http().post(`/v1/courses/${course.slug}/enrol`).set(auth(keeper))).status).toBe(201);
      const free = await completeCourse(await creator(), { pricePaise: "0" });
      await prisma.course.update({ where: { id: free.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
      expect((await http().post(`/v1/courses/${free.slug}/enrol`).set(auth(learner))).status).toBe(201);

      const { CourseMaintenanceProcessor } = await import("../../src/modules/courses");
      const sweep = t.app.get(CourseMaintenanceProcessor);
      await sweep.sweep();
      expect(await prisma.enrolment.count({ where: { courseId: course.id, revokedAt: null } })).toBe(2); // both still live

      t.clock.advance(2 * 3_600_000); // the grant lapses (this test is last: older tokens expire with the fake clock)
      const revoked = await sweep.sweep();
      expect(revoked).toBeGreaterThanOrEqual(1);
      expect((await prisma.enrolment.findFirstOrThrow({ where: { courseId: course.id, userId: learner.userId } })).revokedAt).not.toBeNull();
      expect((await prisma.enrolment.findFirstOrThrow({ where: { courseId: course.id, userId: keeper.userId } })).revokedAt).toBeNull();
      expect((await prisma.enrolment.findFirstOrThrow({ where: { courseId: free.id, userId: learner.userId } })).revokedAt).toBeNull();
      expect((await prisma.course.findUniqueOrThrow({ where: { id: course.id } })).enrolmentCount).toBe(1);
      expect(await sweep.sweep()).toBe(0); // idempotent
    });
  });
});
