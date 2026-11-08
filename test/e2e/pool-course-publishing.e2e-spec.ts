import type { Redis } from "ioredis";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import { REDIS } from "../../src/common/redis/redis.constants";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { courseFixtures, type Session } from "../support/course-fixtures";
import { BURST, coldEntitlements, pinSmallPool, statuses } from "../support/small-pool";

/**
 * Submitting a course and approving it run the publish checks inside a transaction. Those checks used to read the owner's plan limit
 * (a database read on a cold cache) and the video assets' state through the global client: a second pooled connection while the
 * transaction holds the first. With a pool of 3 and parallel requests, every connection was held and nobody could get another (P2024, 500).
 */
describe("publishing a course with a small connection pool", () => {
  let t: AuthTestApp;
  let prisma: PrismaService;
  let redis: Redis;
  let f: ReturnType<typeof courseFixtures>;
  let moderator: Session;

  beforeAll(async () => {
    pinSmallPool();
    t = await createAuthTestApp();
    prisma = t.app.get(PrismaService);
    redis = t.app.get<Redis>(REDIS);
    const categoryId = (await prisma.category.findFirstOrThrow({ where: { slug: "development" } })).id;
    f = courseFixtures(t, prisma, categoryId);
    moderator = await t.login();
    await f.grantRole(moderator.userId, "moderator");
  });
  afterAll(() => t?.close());

  /** BURST creators, each with a complete course of their own. */
  async function courses() {
    const owners = await Promise.all(Array.from({ length: BURST }, () => f.creator()));
    const list = [];
    for (const owner of owners) list.push({ owner, ...(await f.completeCourse(owner)) });
    await coldEntitlements(redis, owners.map((o) => o.userId));
    return list;
  }

  it("parallel submissions all succeed", async () => {
    const list = await courses();
    const res = await Promise.all(list.map((c) => f.http().post(`${f.base(c.id)}/submit`).set(f.auth(c.owner))));
    expect(statuses(res)).toEqual(Array(BURST).fill(200));
    expect((await prisma.course.findMany({ where: { id: { in: list.map((c) => c.id) } } })).map((c) => c.status)).toEqual(Array(BURST).fill("IN_REVIEW"));
  });

  it("parallel approvals all succeed", async () => {
    const list = await courses();
    for (const c of list) await f.inReview(c.id);
    const res = await Promise.all(list.map((c) => f.http().post(`/v1/admin/courses/${c.id}/approve`).set(f.auth(moderator))));
    expect(statuses(res)).toEqual(Array(BURST).fill(200));
    expect((await prisma.course.findMany({ where: { id: { in: list.map((c) => c.id) } } })).map((c) => c.status)).toEqual(Array(BURST).fill("PUBLISHED"));
  });

  it("the plan limit still refuses: the Free plan's published courses cannot be exceeded", async () => {
    const limit = (await prisma.planVersion.findFirstOrThrow({ where: { plan: { key: "free" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })).limits as { max_published_courses: number | null };
    expect(limit.max_published_courses).not.toBeNull();
    const owner = await f.creator();
    const made = [];
    for (let i = 0; i < limit.max_published_courses! + 1; i++) made.push(await f.completeCourse(owner));
    await coldEntitlements(redis, [owner.userId]);
    const res = [];
    for (const c of made) res.push(await f.http().post(`${f.base(c.id)}/submit`).set(f.auth(owner)));
    for (const r of res.slice(0, -1)) expect(r.status).toBe(200);
    for (const c of made.slice(0, -1)) await f.published(c.id);
    expect(res[res.length - 1].status).toBe(200); // in review does not count as published
    const approve = await f.http().post(`/v1/admin/courses/${made[made.length - 1].id}/approve`).set(f.auth(moderator));
    expect(approve.status).toBe(403);
    expect(approve.body.error).toMatchObject({ code: "ENTITLEMENT_LIMIT_REACHED", details: { key: "max_published_courses", limit: limit.max_published_courses } });
  });
});
