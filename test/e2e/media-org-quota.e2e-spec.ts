import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { EntitlementsService } from "../../src/modules/billing";
import { PermissionService } from "../../src/modules/rbac";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { givePlan } from "../support/billing";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;
const GB = 1024 ** 3;

describe("organization storage quota for course media", () => {
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
  async function grantRole(userId: string, roleKey: string, orgId: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.userRole.create({ data: { userId, roleId: role.id, orgId } });
    await t.app.get(PermissionService).invalidateUser(userId);
  }
  async function orgWithAuthors() {
    const owner = await creator();
    const instructor = await t.login(); // not a creator: org authors upload for the org without a personal creator profile
    const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
    await grantRole(owner.userId, "org_owner", org.id);
    await grantRole(instructor.userId, "org_instructor", org.id);
    return { owner, instructor, org };
  }
  const upload = (s: Session, body: Record<string, unknown>) =>
    http().post("/v1/media/uploads").set(auth(s)).send({ purpose: "course_lesson", filename: "l.mp4", mime: "video/mp4", size: 2 * GB, ...body });

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  it("uploads made for an org count against the org's storage_gb (Free: 5 GB), whoever of its authors uploads; the uploader's own quota is untouched", async () => {
    const { owner, instructor, org } = await orgWithAuthors();
    expect((await upload(instructor, { orgId: org.id })).status).toBe(201);
    expect((await upload(owner, { orgId: org.id })).status).toBe(201);
    const refused = await upload(instructor, { orgId: org.id });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("ENTITLEMENT_LIMIT_REACHED");
    expect(refused.body.error.details).toMatchObject({ key: "storage_gb", limit: 5 });

    // 4 GB sit on the org; the owner's personal 5 GB are still free.
    expect((await upload(owner, { size: 4 * GB })).status).toBe(201);
    expect(await prisma.mediaAsset.count({ where: { orgId: org.id } })).toBe(2);
  });

  it("another org's quota is separate, and the org's plan decides the limit", async () => {
    const a = await orgWithAuthors();
    const b = await orgWithAuthors();
    expect((await upload(a.owner, { orgId: a.org.id, size: 4 * GB })).status).toBe(201);
    expect((await upload(a.owner, { orgId: a.org.id, size: 2 * GB })).status).toBe(403);
    expect((await upload(b.owner, { orgId: b.org.id, size: 4 * GB })).status).toBe(201);

    await givePlan(prisma, "ORG", a.org.id, "org_starter"); // 500 GB
    await t.app.get(EntitlementsService).invalidate({ ownerType: "ORG", ownerId: a.org.id });
    expect((await upload(a.owner, { orgId: a.org.id, size: 2 * GB })).status).toBe(201);
  });

  it("failed uploads stop counting", async () => {
    const { owner, org } = await orgWithAuthors();
    const first = await upload(owner, { orgId: org.id, size: 4 * GB });
    expect(first.status).toBe(201);
    expect((await upload(owner, { orgId: org.id, size: 2 * GB })).status).toBe(403);
    await prisma.mediaAsset.update({ where: { id: first.body.assetId }, data: { status: "FAILED" } });
    expect((await upload(owner, { orgId: org.id, size: 2 * GB })).status).toBe(201);
  });

  it("only org authors may upload for an org; the purpose must be course media", async () => {
    const { owner, org } = await orgWithAuthors();
    const learner = await t.login();
    await grantRole(learner.userId, "org_learner", org.id);
    const outsider = await creator();
    expect((await upload(learner, { orgId: org.id })).status).toBe(403);
    expect((await upload(outsider, { orgId: org.id })).status).toBe(403);
    expect((await upload(owner, { orgId: "not-a-uuid" })).status).toBe(400);
    const avatar = await upload(owner, { orgId: org.id, purpose: "avatar", mime: "image/png", size: 1000 });
    expect(avatar.status).toBe(400);
  });

  it("an ORG course accepts only media uploaded for that org, a USER course only personal media", async () => {
    const { owner, instructor, org } = await orgWithAuthors();
    const other = await orgWithAuthors();
    const asset = (ownerId: string, orgId: string | null) =>
      prisma.mediaAsset.create({ data: { ownerId, orgId, purpose: "COURSE_LESSON", bucket: "PRIVATE", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "video/mp4", declaredSize: 10n, durationSec: 60 } });
    const newCourse = async (s: Session, over: Record<string, unknown>) => (await http().post("/v1/studio/courses").set(auth(s)).send({ title: `Quota ${uniq()}`, categoryId, language: "en", ...over })).body as { id: string };
    const lesson = async (s: Session, courseId: string, videoAssetId: string) => {
      const section = (await http().post(`/v1/studio/courses/${courseId}/sections`).set(auth(s)).send({ title: "S" })).body as { id: string };
      return http().post(`/v1/studio/courses/${courseId}/lessons`).set(auth(s)).send({ sectionId: section.id, title: "V", type: "VIDEO", videoAssetId });
    };

    const orgCourse = await newCourse(instructor, { ownerType: "ORG", orgId: org.id });
    const personal = await asset(instructor.userId, null);
    const wrongOrg = await asset(other.owner.userId, other.org.id);
    for (const a of [personal, wrongOrg]) {
      const res = await lesson(instructor, orgCourse.id, a.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("MEDIA_NOT_USABLE");
    }
    expect((await lesson(instructor, orgCourse.id, (await asset(owner.userId, org.id)).id)).status).toBe(201);

    const userCourse = await newCourse(owner, {});
    const res = await lesson(owner, userCourse.id, (await asset(owner.userId, org.id)).id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("MEDIA_NOT_USABLE");
    expect((await lesson(owner, userCourse.id, (await asset(owner.userId, null)).id)).status).toBe(201);
  });

  it("billing's usage view reports an organization's storage", async () => {
    const { owner, org } = await orgWithAuthors();
    expect((await upload(owner, { orgId: org.id, size: 3 * GB })).status).toBe(201);
    const usage = await http().get(`/v1/orgs/${org.slug}/subscription`).set(auth(owner));
    expect(usage.status).toBe(200);
    expect(usage.body.usage.storage_gb).toMatchObject({ used: 3 * GB, unit: "bytes" });
  });
});
