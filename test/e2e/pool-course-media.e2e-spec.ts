import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { courseFixtures } from "../support/course-fixtures";
import { BURST, pinSmallPool, statuses } from "../support/small-pool";

/**
 * Attaching a thumbnail or a lesson video to a course checks the asset (owner, purpose, state) and, for an organization course, that its
 * uploader is an author. Both reads used to use the global client inside the edit's transaction, so parallel edits on a small pool each
 * held a connection while waiting for another (P2024, 500).
 */
describe("attaching course media with a small connection pool", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let f: ReturnType<typeof courseFixtures>;

  beforeAll(async () => {
    pinSmallPool();
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    const categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
    f = courseFixtures(t, prisma, categoryId);
  });
  afterAll(() => t?.close());

  it("parallel thumbnail changes on personal courses all succeed", async () => {
    const owners = await Promise.all(Array.from({ length: BURST }, () => f.creator()));
    const courses = await Promise.all(owners.map((o) => f.newCourse(o)));
    const thumbs = await Promise.all(owners.map((o) => f.asset(o.userId, "THUMBNAIL")));
    const res = await Promise.all(courses.map((c, i) => f.http().patch(f.base(c.id)).set(f.auth(owners[i])).send({ thumbnailAssetId: thumbs[i].id })));
    expect(statuses(res)).toEqual(Array(BURST).fill(200));
  });

  it("parallel thumbnail changes on organization courses all succeed", async () => {
    const { org, owner } = await f.organization();
    const courses = await Promise.all(Array.from({ length: BURST }, () => f.newCourse(owner, { ownerType: "ORG", orgId: org.id })));
    const thumbs = await Promise.all(courses.map(() => f.asset(owner.userId, "THUMBNAIL", { orgId: org.id })));
    const res = await Promise.all(courses.map((c, i) => f.http().patch(f.base(c.id)).set(f.auth(owner)).send({ thumbnailAssetId: thumbs[i].id })));
    expect(statuses(res)).toEqual(Array(BURST).fill(200));
  });

  it("parallel lesson creations with a video all succeed, and a foreign video is still refused", async () => {
    const owners = await Promise.all(Array.from({ length: BURST }, () => f.creator()));
    const courses = await Promise.all(owners.map((o) => f.newCourse(o)));
    const sections = await Promise.all(courses.map(async (c, i) => (await f.http().post(`${f.base(c.id)}/sections`).set(f.auth(owners[i])).send({ title: "S" })).body as { id: string }));
    const videos = await Promise.all(owners.map((o) => f.asset(o.userId, "COURSE_LESSON")));
    const res = await Promise.all(courses.map((c, i) => f.http().post(`${f.base(c.id)}/lessons`).set(f.auth(owners[i])).send({ sectionId: sections[i].id, title: "Watch", type: "VIDEO", videoAssetId: videos[i].id })));
    expect(statuses(res)).toEqual(Array(BURST).fill(201));

    const theirs = await f.asset(owners[1].userId, "COURSE_LESSON");
    const refused = await f.http().post(`${f.base(courses[0].id)}/lessons`).set(f.auth(owners[0])).send({ sectionId: sections[0].id, title: "Theirs", type: "VIDEO", videoAssetId: theirs.id });
    expect(refused.status).toBe(422);
  });
});
