import request from "supertest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { PermissionService } from "../../src/modules/rbac/permission.service";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { expectDeclared } from "../support/openapi-shape";

type Session = Awaited<ReturnType<AuthTestApp["login"]>>;

describe("course studio", () => {
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
  const body = (over: Record<string, unknown> = {}) => ({ title: `Learn Rust ${uniq()}`, description: "A course", categoryId, language: "en", level: "BEGINNER", tags: ["rust"], pricePaise: "0", ...over });
  const create = (s: Session, over: Record<string, unknown> = {}) => http().post("/v1/studio/courses").set(auth(s)).send(body(over));

  async function grantRole(userId: string, roleKey: string, orgId?: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.userRole.create({ data: { userId, roleId: role.id, orgId: orgId ?? null } });
  }
  async function grantPermission(userId: string, permissionKey: string) {
    const role = await prisma.role.create({ data: { key: `r-${uniq()}`, name: "Custom", scope: "PLATFORM", rolePermissions: { create: [{ permission: { connect: { key: permissionKey } } }] } } });
    await prisma.userRole.create({ data: { userId, roleId: role.id } });
    await t.app.get(PermissionService).invalidateUser(userId);
  }
  async function orgWith(roleKey: string, member: Session) {
    const owner = await creator();
    const org = await prisma.organization.create({ data: { slug: `org-${uniq()}`, name: "Org", ownerId: owner.userId } });
    await grantRole(member.userId, roleKey, org.id);
    await grantRole(owner.userId, "org_owner", org.id);
    return { org, owner };
  }

  beforeAll(async () => {
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
  });
  afterAll(() => t?.close());

  describe("creator courses", () => {
    it("a creator creates and edits their own course", async () => {
      const c = await creator();
      const res = await create(c, { title: "Rust for Beginners", pricePaise: "49900" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ ownerType: "USER", ownerId: c.userId, status: "DRAFT", pricePaise: "49900", language: "en", ratingAvg: null, ratingCount: 0 });
      expect(res.body.slug).toMatch(/^rust-for-beginners(-\d+)?$/);

      const patch = await http().patch(`/v1/studio/courses/${res.body.id}`).set(auth(c)).send({ subtitle: "Fast", tags: ["rust", "systems"], level: "ADVANCED" });
      expect(patch.status).toBe(200);
      expect(patch.body).toMatchObject({ subtitle: "Fast", tags: ["rust", "systems"], level: "ADVANCED" });
      const got = await http().get(`/v1/studio/courses/${res.body.id}`).set(auth(c));
      expect(got.status).toBe(200);
      expect(got.body.subtitle).toBe("Fast");
      const list = await http().get("/v1/studio/courses").set(auth(c));
      expect(list.body.items.map((x: { id: string }) => x.id)).toContain(res.body.id);
    });

    it("a non-creator gets CREATOR_REQUIRED", async () => {
      const s = await t.login();
      const res = await create(s);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("CREATOR_REQUIRED");
    });

    it("another creator gets 404 for read, edit and delete (existence is not leaked)", async () => {
      const a = await creator();
      const b = await creator();
      const { body: course } = await create(a);
      expect((await http().get(`/v1/studio/courses/${course.id}`).set(auth(b))).status).toBe(404);
      expect((await http().patch(`/v1/studio/courses/${course.id}`).set(auth(b)).send({ title: "Hijack" })).status).toBe(404);
      expect((await http().delete(`/v1/studio/courses/${course.id}`).set(auth(b))).status).toBe(404);
      expect((await http().get(`/v1/studio/courses/00000000-0000-7000-8000-000000000000`).set(auth(b))).status).toBe(404);
      const list = await http().get("/v1/studio/courses").set(auth(b));
      expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(course.id);
    });

    it("requires authentication", async () => {
      expect((await http().get("/v1/studio/courses")).status).toBe(401);
      expect((await http().post("/v1/studio/courses").send(body())).status).toBe(401);
    });
  });

  describe("price", () => {
    it("rejects below 99 rupees and above 1,00,000; accepts 0, 99 and 1,00,000", async () => {
      const c = await creator();
      for (const bad of ["5000", "9899", "10000001"]) {
        const res = await create(c, { pricePaise: bad });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe("COURSE_PRICE_INVALID");
      }
      for (const ok of ["0", "9900", "10000000"]) expect((await create(c, { pricePaise: ok })).status).toBe(201);
      const { body: course } = await create(c);
      const bad = await http().patch(`/v1/studio/courses/${course.id}`).set(auth(c)).send({ pricePaise: "5000" });
      expect(bad.body.error.code).toBe("COURSE_PRICE_INVALID");
      expect((await http().patch(`/v1/studio/courses/${course.id}`).set(auth(c)).send({ pricePaise: "9900" })).body.pricePaise).toBe("9900");
    });
  });

  describe("validation", () => {
    it("rejects unknown language, unknown category, bad level", async () => {
      const c = await creator();
      expect((await create(c, { language: "xx" })).status).toBe(400);
      expect((await create(c, { level: "EXPERT" })).status).toBe(400);
      const res = await create(c, { categoryId: "00000000-0000-7000-8000-000000000000" });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("CATEGORY_INVALID");
      expect((await create(c, { language: "hi" })).status).toBe(201);
    });
  });

  describe("slug", () => {
    it("is kebab-cased, ASCII-folded, unique with a numeric suffix", async () => {
      const c = await creator();
      const title = `Café Crème ${uniq()}`;
      const first = await create(c, { title });
      const second = await create(c, { title });
      expect(first.body.slug).toMatch(/^cafe-creme-[a-z0-9]+$/);
      expect(second.body.slug).toBe(`${first.body.slug}-2`);
    });

    it("falls back to course-<random> for titles with no ASCII letters", async () => {
      const c = await creator();
      const res = await create(c, { title: "पायथन सीखें" });
      expect(res.status).toBe(201);
      expect(res.body.slug).toMatch(/^course-[a-z0-9]{6}$/);
    });

    it("can be changed while unlocked, never once locked by a first publish", async () => {
      const c = await creator();
      const { body: course } = await create(c);
      const newSlug = `custom-${uniq()}`;
      expect((await http().patch(`/v1/studio/courses/${course.id}`).set(auth(c)).send({ slug: newSlug })).body.slug).toBe(newSlug);
      await prisma.course.update({ where: { id: course.id }, data: { slugLockedAt: new Date() } });
      const locked = await http().patch(`/v1/studio/courses/${course.id}`).set(auth(c)).send({ slug: `other-${uniq()}` });
      expect(locked.status).toBe(409);
      expect(locked.body.error.code).toBe("COURSE_SLUG_LOCKED");
      const { body: other } = await create(c);
      const taken = await http().patch(`/v1/studio/courses/${other.id}`).set(auth(c)).send({ slug: newSlug });
      expect(taken.status).toBe(409);
      expect(taken.body.error.code).toBe("COURSE_SLUG_TAKEN");
    });
  });

  describe("delete", () => {
    it("deletes a never-published draft; refuses once published or locked", async () => {
      const c = await creator();
      const { body: draft } = await create(c);
      expect((await http().delete(`/v1/studio/courses/${draft.id}`).set(auth(c))).status).toBe(204);
      expect((await http().get(`/v1/studio/courses/${draft.id}`).set(auth(c))).status).toBe(404);

      const { body: live } = await create(c);
      await prisma.course.update({ where: { id: live.id }, data: { status: "PUBLISHED", slugLockedAt: new Date() } });
      const res = await http().delete(`/v1/studio/courses/${live.id}`).set(auth(c));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("COURSE_NOT_DELETABLE");

      const { body: unpublished } = await create(c);
      await prisma.course.update({ where: { id: unpublished.id }, data: { status: "DRAFT", slugLockedAt: new Date() } });
      expect((await http().delete(`/v1/studio/courses/${unpublished.id}`).set(auth(c))).status).toBe(409);
    });
  });

  describe("thumbnail and promo media", () => {
    const asset = (ownerId: string, purpose: string, over: Record<string, unknown> = {}) =>
      prisma.mediaAsset.create({
        data: { ownerId, purpose: purpose as never, bucket: purpose === "THUMBNAIL" || purpose === "COURSE_PROMO" ? "PUBLIC" : "PRIVATE", status: "READY", objectKey: `incoming/${uniq()}/source`, mime: "image/png", declaredSize: 10n, ...over },
      });

    it("attaches the creator's READY thumbnail, swaps it (detaching the old one) and rejects someone else's asset", async () => {
      const c = await creator();
      const other = await creator();
      const { body: course } = await create(c);
      const a1 = await asset(c.userId, "THUMBNAIL");
      const a2 = await asset(c.userId, "THUMBNAIL");
      const foreign = await asset(other.userId, "THUMBNAIL");

      const set = await http().patch(`/v1/studio/courses/${course.id}`).set(auth(c)).send({ thumbnailAssetId: a1.id });
      expect(set.status).toBe(200);
      expect(set.body.thumbnailAssetId).toBe(a1.id);
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: a1.id } })).attachedAt).not.toBeNull();

      const swap = await http().patch(`/v1/studio/courses/${course.id}`).set(auth(c)).send({ thumbnailAssetId: a2.id });
      expect(swap.status).toBe(200);
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: a1.id } })).attachedAt).toBeNull();

      const bad = await http().patch(`/v1/studio/courses/${course.id}`).set(auth(c)).send({ thumbnailAssetId: foreign.id });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe("MEDIA_NOT_USABLE");

      const wrongPurpose = await asset(c.userId, "COURSE_LESSON");
      expect((await http().patch(`/v1/studio/courses/${course.id}`).set(auth(c)).send({ thumbnailAssetId: wrongPurpose.id })).body.error.code).toBe("MEDIA_NOT_USABLE");

      const clear = await http().patch(`/v1/studio/courses/${course.id}`).set(auth(c)).send({ thumbnailAssetId: null });
      expect(clear.body.thumbnailAssetId).toBeNull();
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: a2.id } })).attachedAt).toBeNull();
    });

    it("attaches a promo video and releases media when the draft is deleted", async () => {
      const c = await creator();
      const { body: course } = await create(c);
      const promo = await asset(c.userId, "COURSE_PROMO", { mime: "video/mp4" });
      const res = await http().patch(`/v1/studio/courses/${course.id}`).set(auth(c)).send({ promoVideoAssetId: promo.id });
      expect(res.body.promoVideoAssetId).toBe(promo.id);
      expect((await http().delete(`/v1/studio/courses/${course.id}`).set(auth(c))).status).toBe(204);
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: promo.id } })).attachedAt).toBeNull();
    });
  });

  describe("organization courses", () => {
    it("org_instructor and org_owner create and edit org courses; org_learner gets 403; outsiders get 404", async () => {
      const instructor = await t.login();
      const { org, owner } = await orgWith("org_instructor", instructor);
      const res = await create(instructor, { ownerType: "ORG", orgId: org.id });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ ownerType: "ORG", ownerId: org.id, createdById: instructor.userId });

      expect((await http().patch(`/v1/studio/courses/${res.body.id}`).set(auth(owner)).send({ title: "Owner edit" })).status).toBe(200);
      expect((await http().patch(`/v1/studio/courses/${res.body.id}`).set(auth(instructor)).send({ title: "Instructor edit" })).body.title).toBe("Instructor edit");
      const listed = await http().get("/v1/studio/courses").set(auth(owner));
      expect(listed.body.items.map((x: { id: string }) => x.id)).toContain(res.body.id);

      const learner = await t.login();
      await grantRole(learner.userId, "org_learner", org.id);
      const denied = await http().patch(`/v1/studio/courses/${res.body.id}`).set(auth(learner)).send({ title: "Nope" });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("FORBIDDEN");
      expect((await create(learner, { ownerType: "ORG", orgId: org.id })).status).toBe(403);

      const outsider = await creator();
      expect((await http().get(`/v1/studio/courses/${res.body.id}`).set(auth(outsider))).status).toBe(404);
      expect((await create(outsider, { ownerType: "ORG", orgId: org.id })).status).toBe(403);
    });

    it("an author of one org cannot see another org's courses", async () => {
      const instructor = await t.login();
      await orgWith("org_instructor", instructor);
      const b = await orgWith("org_instructor", await t.login());
      const { body: course } = await create(b.owner, { ownerType: "ORG", orgId: b.org.id });
      expect((await http().get(`/v1/studio/courses/${course.id}`).set(auth(instructor))).status).toBe(404);
    });

    it("a platform-wide grant of org_instructor does not count; course.manage_any is the explicit override", async () => {
      const platformInstructor = await t.login();
      await grantRole(platformInstructor.userId, "org_instructor");
      const b = await orgWith("org_instructor", await t.login());
      const { body: orgCourse } = await create(b.owner, { ownerType: "ORG", orgId: b.org.id });
      expect((await http().get(`/v1/studio/courses/${orgCourse.id}`).set(auth(platformInstructor))).status).toBe(404);
      expect((await create(platformInstructor, { ownerType: "ORG", orgId: b.org.id })).status).toBe(403);

      const c = await creator();
      const { body: course } = await create(c);
      const admin = await t.login();
      expect((await http().get(`/v1/studio/courses/${course.id}`).set(auth(admin))).status).toBe(404);
      await grantPermission(admin.userId, "course.manage_any");
      expect((await http().get(`/v1/studio/courses/${course.id}`).set(auth(admin))).status).toBe(200);
    });
  });

  describe("moderators", () => {
    it("course.review reads in-review, published and flagged courses in full but never drafts, and never edits", async () => {
      const c = await creator();
      const { body: course } = await create(c);
      const mod = await t.login();
      const role = await prisma.role.findUniqueOrThrow({ where: { key: "moderator" } });
      await prisma.userRole.create({ data: { userId: mod.userId, roleId: role.id } });
      await t.app.get(PermissionService).invalidateUser(mod.userId);
      expect(await prisma.rolePermission.count({ where: { roleId: role.id, permission: { key: "course.manage_any" } } })).toBe(0);

      expect((await http().get(`/v1/studio/courses/${course.id}`).set(auth(mod))).status).toBe(404);
      expect((await http().get(`/v1/studio/courses/${course.id}/curriculum`).set(auth(mod))).status).toBe(404);

      await prisma.course.update({ where: { id: course.id }, data: { status: "IN_REVIEW" } });
      const read = await http().get(`/v1/studio/courses/${course.id}`).set(auth(mod));
      expect(read.status).toBe(200);
      expect(read.body.description).toBe("A course");
      expect((await http().get(`/v1/studio/courses/${course.id}/curriculum`).set(auth(mod))).status).toBe(200);

      for (const res of [
        await http().patch(`/v1/studio/courses/${course.id}`).set(auth(mod)).send({ title: "Hijack" }),
        await http().delete(`/v1/studio/courses/${course.id}`).set(auth(mod)),
        await http().post(`/v1/studio/courses/${course.id}/sections`).set(auth(mod)).send({ title: "x" }),
        await http().put(`/v1/studio/courses/${course.id}/order`).set(auth(mod)).send({ sections: [], expectedVersion: "x" }),
      ]) {
        expect(res.status).toBe(403);
      }

      await prisma.course.update({ where: { id: course.id }, data: { status: "DRAFT", flaggedAt: new Date(), flagReason: "x" } });
      expect((await http().get(`/v1/studio/courses/${course.id}`).set(auth(mod))).status).toBe(200);
      const list = await http().get("/v1/studio/courses").set(auth(mod));
      expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(course.id);
    });
  });

  describe("categories", () => {
    it("are seeded and listed publicly", async () => {
      const res = await http().get("/v1/categories");
      expectDeclared(res, "GET /v1/categories");
      expect(res.status).toBe(200);
      const names = res.body.items.map((x: { name: string }) => x.name);
      expect(names.length).toBeGreaterThanOrEqual(15);
      expect(names).toEqual(expect.arrayContaining(["Development", "Data Science", "Exam Preparation"]));
    });

    it("admin CRUD needs course.categories.manage; inactive categories vanish from the public list; in-use ones cannot be deleted", async () => {
      const plain = await t.login();
      expect((await http().post("/v1/admin/course-categories").set(auth(plain)).send({ name: "Nope" })).status).toBe(403);

      const admin = await t.login();
      await grantPermission(admin.userId, "course.categories.manage");

      const name = `Gardening ${uniq()}`;
      const created = await http().post("/v1/admin/course-categories").set(auth(admin)).send({ name });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name, isActive: true });
      const id = created.body.id;
      expect((await http().get("/v1/categories")).body.items.map((x: { id: string }) => x.id)).toContain(id);

      const renamed = await http().patch(`/v1/admin/course-categories/${id}`).set(auth(admin)).send({ name: `${name} 2`, position: 99 });
      expect(renamed.body).toMatchObject({ name: `${name} 2`, position: 99 });

      await http().patch(`/v1/admin/course-categories/${id}`).set(auth(admin)).send({ isActive: false });
      expect((await http().get("/v1/categories")).body.items.map((x: { id: string }) => x.id)).not.toContain(id);
      const all = await http().get("/v1/admin/course-categories").set(auth(admin));
      expect(all.body.items.map((x: { id: string }) => x.id)).toContain(id);

      const c = await creator();
      expect((await create(c, { categoryId: id })).body.error.code).toBe("CATEGORY_INVALID");
      await http().patch(`/v1/admin/course-categories/${id}`).set(auth(admin)).send({ isActive: true });
      expect((await create(c, { categoryId: id })).status).toBe(201);
      const inUse = await http().delete(`/v1/admin/course-categories/${id}`).set(auth(admin));
      expect(inUse.status).toBe(409);
      expect(inUse.body.error.code).toBe("CATEGORY_IN_USE");

      const spare = await http().post("/v1/admin/course-categories").set(auth(admin)).send({ name: `Spare ${uniq()}` });
      expect((await http().delete(`/v1/admin/course-categories/${spare.body.id}`).set(auth(admin))).status).toBe(204);
    });
  });
});
