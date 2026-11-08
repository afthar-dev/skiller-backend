import request from "supertest";
import type { PrismaService } from "../../src/common/prisma/prisma.service";
import { PermissionService } from "../../src/modules/rbac/permission.service";
import type { AuthTestApp } from "./auth-app";

export type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const uniq = () => Math.random().toString(36).slice(2, 10);

/** Builders for the course e2e specs that fire parallel requests; each call makes its own owner so requests do not share locks or plan caches. */
export function courseFixtures(t: AuthTestApp, prisma: PrismaService, categoryId: string) {
  const http = () => request(t.app.getHttpServer());
  const auth = (s: { accessToken: string }) => ({ Authorization: `Bearer ${s.accessToken}` });
  const base = (id: string) => `/v1/studio/courses/${id}`;

  const creator = async (): Promise<Session> => {
    const s = await t.login();
    expect((await http().post("/v1/me/become-creator").set(auth(s)).send({ acceptTerms: true })).status).toBe(200);
    return s;
  };
  async function grantRole(userId: string, roleKey: string, orgId?: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.userRole.create({ data: { userId, roleId: role.id, orgId: orgId ?? null } });
    await t.app.get(PermissionService).invalidateUser(userId);
  }
  const asset = (ownerId: string, purpose: "THUMBNAIL" | "COURSE_LESSON", over: Record<string, unknown> = {}) =>
    prisma.mediaAsset.create({
      data: {
        ownerId,
        purpose,
        bucket: purpose === "THUMBNAIL" ? "PUBLIC" : "PRIVATE",
        status: "READY",
        objectKey: `incoming/${uniq()}/source`,
        mime: purpose === "THUMBNAIL" ? "image/png" : "video/mp4",
        declaredSize: 10n,
        durationSec: 60,
        ...over,
      },
    });
  /** An organization with an owner (also an instructor in effect) and one extra instructor. */
  async function organization() {
    const owner = await creator();
    const instructor = await t.login();
    const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
    await grantRole(owner.userId, "org_owner", org.id);
    await grantRole(instructor.userId, "org_instructor", org.id);
    return { org, owner, instructor };
  }
  const newCourse = async (s: Session, over: Record<string, unknown> = {}) => {
    const res = await http().post("/v1/studio/courses").set(auth(s)).send({ title: `Pool ${uniq()}`, description: "A course", categoryId, language: "en", ...over });
    expect(res.status).toBe(201);
    return res.body as { id: string; slug: string };
  };
  /** A course that passes every publishing check, with a ready video lesson so the publish checks also read the media table. */
  async function completeCourse(s: Session, over: Record<string, unknown> = {}) {
    const course = await newCourse(s, over);
    const orgId = (over.orgId as string | undefined) ?? null;
    const thumb = await asset(s.userId, "THUMBNAIL", { orgId });
    expect((await http().patch(base(course.id)).set(auth(s)).send({ thumbnailAssetId: thumb.id })).status).toBe(200);
    const section = (await http().post(`${base(course.id)}/sections`).set(auth(s)).send({ title: "Intro" })).body;
    const video = await asset(s.userId, "COURSE_LESSON", { orgId });
    const lesson = await http().post(`${base(course.id)}/lessons`).set(auth(s)).send({ sectionId: section.id, title: "Watch", type: "VIDEO", videoAssetId: video.id });
    expect(lesson.status).toBe(201);
    return { ...course, sectionId: section.id as string };
  }
  const inReview = (id: string) => prisma.course.update({ where: { id }, data: { status: "IN_REVIEW", submittedAt: new Date() } });
  const published = (id: string) => prisma.course.update({ where: { id }, data: { status: "PUBLISHED", publishedAt: new Date(), slugLockedAt: new Date() } });

  return { http, auth, base, creator, grantRole, asset, organization, newCourse, completeCourse, inReview, published };
}
