import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { courseFixtures, type Session } from "../support/course-fixtures";
import { BURST, pinSmallPool, statuses } from "../support/small-pool";

/**
 * Moderating an organization's course (or its reviews) checks that the moderator is not one of the course's authors, and for an
 * organization the authors come from the role tables. That read used to go through the global client inside the decision's transaction,
 * so parallel decisions on a small pool each held a connection while waiting for another (P2024, 500).
 */
describe("moderating organization courses with a small connection pool", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let f: ReturnType<typeof courseFixtures>;
  let moderator: Session;
  let owner: Session;
  let orgId: string;

  beforeAll(async () => {
    pinSmallPool();
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    const categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
    f = courseFixtures(t, prisma, categoryId);
    moderator = await t.login();
    await f.grantRole(moderator.userId, "moderator");
    const org = await f.organization();
    owner = org.owner;
    orgId = org.org.id;
  });
  afterAll(() => t?.close());

  const orgCourses = () => Promise.all(Array.from({ length: BURST }, () => f.newCourse(owner, { ownerType: "ORG", orgId })));

  it("parallel rejections of courses in review all succeed", async () => {
    const list = await orgCourses();
    for (const c of list) await f.inReview(c.id);
    const res = await Promise.all(list.map((c) => f.http().post(`/v1/admin/courses/${c.id}/reject`).set(f.auth(moderator)).send({ reason: "Needs work" })));
    expect(statuses(res)).toEqual(Array(BURST).fill(200));
  });

  it("parallel flags and unflags of published courses all succeed", async () => {
    const list = await orgCourses();
    for (const c of list) await f.published(c.id);
    const flagged = await Promise.all(list.map((c) => f.http().post(`/v1/admin/courses/${c.id}/flag`).set(f.auth(moderator)).send({ reason: "Reported" })));
    expect(statuses(flagged)).toEqual(Array(BURST).fill(200));
    const unflagged = await Promise.all(list.map((c) => f.http().post(`/v1/admin/courses/${c.id}/unflag`).set(f.auth(moderator)).send({ reason: "Checked" })));
    expect(statuses(unflagged)).toEqual(Array(BURST).fill(200));
  });

  it("parallel hides and unhides of reviews on an organization course all succeed", async () => {
    const [course] = await orgCourses();
    await f.published(course.id);
    const reviewers = await Promise.all(Array.from({ length: BURST }, () => t.login()));
    const reviews = await Promise.all(reviewers.map((r) => prisma.review.create({ data: { courseId: course.id, userId: r.userId, rating: 4, body: "ok" } })));
    const hidden = await Promise.all(reviews.map((r) => f.http().post(`/v1/admin/reviews/${r.id}/hide`).set(f.auth(moderator)).send({ reason: "Abusive" })));
    expect(statuses(hidden)).toEqual(Array(BURST).fill(200));
    const shown = await Promise.all(reviews.map((r) => f.http().post(`/v1/admin/reviews/${r.id}/unhide`).set(f.auth(moderator)).send({ reason: "Reviewed" })));
    expect(statuses(shown)).toEqual(Array(BURST).fill(200));
  });

  it("an author of the organization still cannot moderate its course", async () => {
    const [course] = await orgCourses();
    await f.inReview(course.id);
    await f.grantRole(owner.userId, "moderator");
    const res = await f.http().post(`/v1/admin/courses/${course.id}/reject`).set(f.auth(owner)).send({ reason: "Mine" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("COURSE_REVIEW_SELF");
  });
});
