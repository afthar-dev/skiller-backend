import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { PermissionService } from "../../src/modules/rbac/permission.service";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("course moderation and publishing", () => {
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
  async function grantRole(userId: string, roleKey: string, orgId?: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.userRole.create({ data: { userId, roleId: role.id, orgId: orgId ?? null } });
    await t.app.get(PermissionService).invalidateUser(userId);
  }
  const asset = (ownerId: string, purpose: string, over: Record<string, unknown> = {}) =>
    prisma.mediaAsset.create({
      data: {
        ownerId,
        purpose: purpose as never,
        bucket: purpose === "THUMBNAIL" || purpose === "COURSE_PROMO" || purpose === "REEL" ? "PUBLIC" : "PRIVATE",
        status: "READY",
        objectKey: `incoming/${uniq()}/source`,
        mime: purpose === "THUMBNAIL" ? "image/png" : "video/mp4",
        declaredSize: 10n,
        durationSec: 60,
        ...over,
      },
    });
  const base = (id: string) => `/v1/studio/courses/${id}`;
  const newCourse = async (s: Session, over: Record<string, unknown> = {}) => {
    const res = await http().post("/v1/studio/courses").set(auth(s)).send({ title: `Moderation ${uniq()}`, description: "A course", categoryId, language: "en", ...over });
    expect(res.status).toBe(201);
    return res.body as { id: string; slug: string };
  };
  /** A course that passes every publishing check. */
  async function completeCourse(s: Session, over: Record<string, unknown> = {}) {
    const course = await newCourse(s, over);
    const thumb = await asset(s.userId, "THUMBNAIL");
    expect((await http().patch(base(course.id)).set(auth(s)).send({ thumbnailAssetId: thumb.id })).status).toBe(200);
    const section = (await http().post(`${base(course.id)}/sections`).set(auth(s)).send({ title: "Intro" })).body;
    const lesson = await http().post(`${base(course.id)}/lessons`).set(auth(s)).send({ sectionId: section.id, title: "Read me", type: "ARTICLE", articleBody: "hello" });
    expect(lesson.status).toBe(201);
    return { ...course, sectionId: section.id as string };
  }
  const submit = (s: Session, id: string) => http().post(`${base(id)}/submit`).set(auth(s));
  const approve = (id: string, s: Session = moderator) => http().post(`/v1/admin/courses/${id}/approve`).set(auth(s));
  const reject = (id: string, reason: unknown, s: Session = moderator) => http().post(`/v1/admin/courses/${id}/reject`).set(auth(s)).send({ reason });
  const flag = (id: string, reason: unknown, s: Session = moderator) => http().post(`/v1/admin/courses/${id}/flag`).set(auth(s)).send({ reason });
  const unflag = (id: string, reason: unknown, s: Session = moderator) => http().post(`/v1/admin/courses/${id}/unflag`).set(auth(s)).send({ reason });
  const publish = async (s: Session, over: Record<string, unknown> = {}) => {
    const c = await completeCourse(s, over);
    expect((await submit(s, c.id)).status).toBe(200);
    expect((await approve(c.id)).status).toBe(200);
    return c;
  };
  const publicView = (slug: string) => http().get(`/v1/courses/${slug}/curriculum`);
  const reasons = (res: { body: { error: { details: { reasons: Array<{ code: string }> } } } }) => res.body.error.details.reasons.map((r) => r.code).sort();

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
    moderator = await t.login();
    await grantRole(moderator.userId, "moderator");
  });
  afterAll(() => t?.close());

  describe("submit for review", () => {
    it("lists every reason an incomplete course cannot be submitted", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const empty = await submit(c, course.id);
      expect(empty.status).toBe(422);
      expect(empty.body.error.code).toBe("COURSE_NOT_PUBLISHABLE");
      expect(reasons(empty)).toEqual(["NO_REQUIRED_LESSON", "NO_SECTIONS", "NO_THUMBNAIL"]);

      const section = (await http().post(`${base(course.id)}/sections`).set(auth(c)).send({ title: "S" })).body;
      expect(reasons(await submit(c, course.id))).toEqual(["NO_REQUIRED_LESSON", "NO_THUMBNAIL"]);

      const optional = await http().post(`${base(course.id)}/lessons`).set(auth(c)).send({ sectionId: section.id, title: "Optional", type: "ARTICLE", isRequired: false });
      expect(optional.status).toBe(201);
      expect(reasons(await submit(c, course.id))).toContain("NO_REQUIRED_LESSON");

      // A video lesson whose video is not processed yet blocks submission; so does a video lesson with no video at all.
      const video = await asset(c.userId, "COURSE_LESSON");
      const vLesson = await http().post(`${base(course.id)}/lessons`).set(auth(c)).send({ sectionId: section.id, title: "Video", type: "VIDEO", videoAssetId: video.id });
      expect(vLesson.status).toBe(201);
      await prisma.mediaAsset.update({ where: { id: video.id }, data: { status: "PROCESSING" } });
      expect(reasons(await submit(c, course.id))).toEqual(["NO_THUMBNAIL", "VIDEO_NOT_READY"]);
      await prisma.mediaAsset.update({ where: { id: video.id }, data: { status: "READY" } });
      const thumb = await asset(c.userId, "THUMBNAIL");
      await http().patch(base(course.id)).set(auth(c)).send({ thumbnailAssetId: thumb.id });
      const ok = await submit(c, course.id);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: "IN_REVIEW", rejectionReason: null });
    });

    it("is for the course's authors only and only from DRAFT", async () => {
      const c = await creator();
      const other = await creator();
      const course = await completeCourse(c);
      expect((await submit(other, course.id)).status).toBe(404);
      expect((await submit(moderator, course.id)).status).toBe(404);
      expect((await submit(c, course.id)).status).toBe(200);
      const again = await submit(c, course.id);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("COURSE_STATE_INVALID");
    });

    it("an organization instructor submits an org course; the org owner is notified when it is approved", async () => {
      const owner = await creator();
      const instructor = await t.login();
      const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
      await grantRole(owner.userId, "org_owner", org.id);
      await grantRole(instructor.userId, "org_instructor", org.id);
      const thumb = await asset(owner.userId, "THUMBNAIL");
      const course = await newCourse(instructor, { ownerType: "ORG", orgId: org.id });
      expect((await http().patch(base(course.id)).set(auth(owner)).send({ thumbnailAssetId: thumb.id })).status).toBe(200);
      const section = (await http().post(`${base(course.id)}/sections`).set(auth(instructor)).send({ title: "S" })).body;
      await http().post(`${base(course.id)}/lessons`).set(auth(instructor)).send({ sectionId: section.id, title: "L", type: "ARTICLE" });
      expect((await submit(instructor, course.id)).status).toBe(200);
      expect((await approve(course.id)).status).toBe(200);
      for (const u of [owner, instructor]) {
        const n = await prisma.notification.findMany({ where: { userId: u.userId, type: "course.approved" } });
        expect(n.map((x) => (x.data as { courseId: string }).courseId)).toContain(course.id);
      }
    });
  });

  describe("moderator queue", () => {
    it("is for course.review holders only", async () => {
      const c = await creator();
      expect((await http().get("/v1/admin/courses/review-queue").set(auth(c))).status).toBe(403);
      expect((await http().get("/v1/admin/courses/review-queue")).status).toBe(401);
      const course = await completeCourse(c);
      expect((await approve(course.id, c)).status).toBe(403);
      expect((await reject(course.id, "no", c)).status).toBe(403);
      expect((await flag(course.id, "no", c)).status).toBe(403);
      expect((await unflag(course.id, "no", c)).status).toBe(403);
    });

    it("shows submitted courses oldest first, pages them, and drops them once decided", async () => {
      const c = await creator();
      const first = await completeCourse(c);
      const second = await completeCourse(c);
      expect((await submit(c, first.id)).status).toBe(200);
      expect((await submit(c, second.id)).status).toBe(200);
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 200; page++) {
        const res: request.Response = await http().get("/v1/admin/courses/review-queue").query({ limit: 50, ...(cursor ? { cursor } : {}) }).set(auth(moderator));
        expect(res.status).toBe(200);
        ids.push(...res.body.items.map((x: { id: string }) => x.id));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      expect(ids.indexOf(first.id)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
      expect((await approve(first.id)).status).toBe(200);
      const after = await http().get("/v1/admin/courses/review-queue").query({ limit: 200 }).set(auth(moderator));
      expect(after.body.items.map((x: { id: string }) => x.id)).not.toContain(first.id);
    });
  });

  describe("approve and reject", () => {
    it("approve publishes: publishedAt, address locked, outbox event, audit, author notified, public page visible", async () => {
      const c = await creator();
      const course = await completeCourse(c);
      expect(course.slug).toBeTruthy();
      expect((await publicView(course.slug)).status).toBe(404); // not published yet
      await submit(c, course.id);

      const res = await approve(course.id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "PUBLISHED", slugLocked: true });
      expect(res.body.publishedAt).not.toBeNull();

      const outbox = await prisma.outboxEvent.findMany({ where: { type: "course.published" } });
      expect(outbox.some((e) => (e.payload as { courseId?: string }).courseId === course.id)).toBe(true);
      const audit = await prisma.auditLog.findFirst({ where: { action: "course.approve", targetId: course.id } });
      expect(audit).toMatchObject({ actorId: moderator.userId, targetType: "course" });
      const note = await prisma.notification.findFirst({ where: { userId: c.userId, type: "course.approved" } });
      expect(note).not.toBeNull();
      expect((await publicView(course.slug)).status).toBe(200);

      const moved = await http().patch(base(course.id)).set(auth(c)).send({ slug: `new-${uniq()}` });
      expect(moved.status).toBe(409);
      expect(moved.body.error.code).toBe("COURSE_SLUG_LOCKED");
      expect((await approve(course.id)).status).toBe(409); // not in review any more
    });

    it("a published course is edited live, without going back to review", async () => {
      const c = await creator();
      const course = await publish(c);
      const edited = await http().patch(base(course.id)).set(auth(c)).send({ title: "Renamed live", pricePaise: "49900" });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({ status: "PUBLISHED", title: "Renamed live", pricePaise: "49900" });
    });

    it("reject needs a reason, sends the course back to DRAFT with it, and a resubmission enters the queue again", async () => {
      const c = await creator();
      const course = await completeCourse(c);
      expect((await reject(course.id, "too short")).status).toBe(409); // still a draft: nothing to reject
      await submit(c, course.id);
      for (const bad of [undefined, "", "  ", 5]) expect((await reject(course.id, bad)).status).toBe(400);

      const res = await reject(course.id, "Audio is unintelligible in lesson 1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "DRAFT", rejectionReason: "Audio is unintelligible in lesson 1" });
      expect((await http().get(base(course.id)).set(auth(c))).body.rejectionReason).toBe("Audio is unintelligible in lesson 1");
      expect(await prisma.auditLog.count({ where: { action: "course.reject", targetId: course.id } })).toBe(1);
      const note = await prisma.notification.findFirst({ where: { userId: c.userId, type: "course.rejected" } });
      expect(note?.body).toContain("Audio is unintelligible");

      const again = await submit(c, course.id);
      expect(again.status).toBe(200);
      expect(again.body.rejectionReason).toBeNull();
      const queue = await http().get("/v1/admin/courses/review-queue").query({ limit: 200 }).set(auth(moderator));
      expect(queue.body.items.map((x: { id: string }) => x.id)).toContain(course.id);
    });
  });

  describe("plan limit on published courses", () => {
    it("the Free plan allows three: the 4th submission is refused; archiving frees a slot; flagged courses still count", async () => {
      const c = await creator();
      const published = [await publish(c), await publish(c), await publish(c)];
      const fourth = await completeCourse(c);
      const refused = await submit(c, fourth.id);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("ENTITLEMENT_LIMIT_REACHED");
      expect(refused.body.error.details).toMatchObject({ key: "max_published_courses", limit: 3 });

      // flagged still counts
      expect((await flag(published[0].id, "spam")).status).toBe(200);
      expect((await submit(c, fourth.id)).status).toBe(403);

      // archived does not
      expect((await http().post(`${base(published[1].id)}/archive`).set(auth(c))).status).toBe(200);
      expect((await submit(c, fourth.id)).status).toBe(200);
    });

    it("is checked again at approval: a course queued while the owner was under the limit is refused once the limit is reached", async () => {
      const c = await creator();
      const queued = [await completeCourse(c), await completeCourse(c), await completeCourse(c), await completeCourse(c)];
      for (const q of queued) expect((await submit(c, q.id)).status).toBe(200); // 0 published: every submit passes
      for (const q of queued.slice(0, 3)) expect((await approve(q.id)).status).toBe(200);
      const refused = await approve(queued[3].id);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("ENTITLEMENT_LIMIT_REACHED");
      expect((await prisma.course.findUniqueOrThrow({ where: { id: queued[3].id } })).status).toBe("IN_REVIEW");
    });

    it("concurrent approvals cannot overshoot the limit", async () => {
      const c = await creator();
      const queued = [await completeCourse(c), await completeCourse(c), await completeCourse(c), await completeCourse(c), await completeCourse(c)];
      for (const q of queued) expect((await submit(c, q.id)).status).toBe(200);
      const results = await Promise.all(queued.map((q) => approve(q.id)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      expect(await prisma.course.count({ where: { ownerId: c.userId, status: "PUBLISHED" } })).toBe(3);
    });
  });

  describe("flag, unflag and archive", () => {
    it("flag hides a published course from the public page; unflag brings it back; reasons are required", async () => {
      const c = await creator();
      const course = await publish(c);
      expect((await publicView(course.slug)).status).toBe(200);

      for (const bad of [undefined, "", "   "]) expect((await flag(course.id, bad)).status).toBe(400);
      const flagged = await flag(course.id, "Copyright complaint");
      expect(flagged.status).toBe(200);
      expect(flagged.body).toMatchObject({ status: "PUBLISHED", flagReason: "Copyright complaint" });
      expect(flagged.body.flaggedAt).not.toBeNull();
      expect((await publicView(course.slug)).status).toBe(404);
      expect((await flag(course.id, "again")).status).toBe(409);
      expect(await prisma.auditLog.count({ where: { action: "course.flag", targetId: course.id } })).toBe(1);
      expect((await prisma.notification.findFirst({ where: { userId: c.userId, type: "course.flagged" } }))?.body).toContain("Copyright complaint");

      // the author can still fix the course while it is flagged
      expect((await http().patch(base(course.id)).set(auth(c)).send({ title: "Fixed" })).status).toBe(200);

      expect((await unflag(course.id, "")).status).toBe(400);
      const back = await unflag(course.id, "Cleared after review");
      expect(back.status).toBe(200);
      expect(back.body).toMatchObject({ flaggedAt: null, flagReason: null });
      expect((await publicView(course.slug)).status).toBe(200);
      expect((await unflag(course.id, "again")).status).toBe(409);
      expect(await prisma.auditLog.count({ where: { action: "course.unflag", targetId: course.id } })).toBe(1);
    });

    it("only a published course can be flagged", async () => {
      const c = await creator();
      const draft = await completeCourse(c);
      const res = await flag(draft.id, "x");
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("COURSE_STATE_INVALID");
      expect((await flag("00000000-0000-7000-8000-000000000000", "x")).status).toBe(404);
    });

    it("archive hides the course; it is the author's call and only for a published course", async () => {
      const c = await creator();
      const other = await creator();
      const draft = await completeCourse(c);
      expect((await http().post(`${base(draft.id)}/archive`).set(auth(c))).status).toBe(409);
      const course = await publish(c);
      expect((await http().post(`${base(course.id)}/archive`).set(auth(other))).status).toBe(404);
      expect((await http().post(`${base(course.id)}/archive`).set(auth(moderator))).status).toBe(403);
      const res = await http().post(`${base(course.id)}/archive`).set(auth(c));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ARCHIVED");
      expect((await publicView(course.slug)).status).toBe(404);
      expect(await prisma.auditLog.count({ where: { action: "course.archive", targetId: course.id } })).toBe(1);
      expect((await http().post(`${base(course.id)}/archive`).set(auth(c))).status).toBe(409);
      expect((await submit(c, course.id)).status).toBe(409);
    });
  });

  describe("promo video", () => {
    it("takes a COURSE_PROMO asset and refuses a reel", async () => {
      const c = await creator();
      const course = await newCourse(c);
      const reel = await asset(c.userId, "REEL");
      const bad = await http().patch(base(course.id)).set(auth(c)).send({ promoVideoAssetId: reel.id });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe("MEDIA_NOT_USABLE");
      const promo = await asset(c.userId, "COURSE_PROMO");
      const ok = await http().patch(base(course.id)).set(auth(c)).send({ promoVideoAssetId: promo.id });
      expect(ok.status).toBe(200);
      expect(ok.body.promoVideoAssetId).toBe(promo.id);
    });
  });
});
