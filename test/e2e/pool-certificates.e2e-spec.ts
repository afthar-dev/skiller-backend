import { PrismaService } from "../../src/common/prisma/prisma.service";
import "../../src/modules/billing"; // load order: billing before courses and rbac (module cycles)
import { CertificatesService } from "../../src/modules/courses/certificates.service";
import { AuthTestApp, createAuthTestApp } from "../support/auth-app";
import { courseFixtures } from "../support/course-fixtures";
import { BURST, pinSmallPool } from "../support/small-pool";

/**
 * Issuing a certificate re-checks, inside a transaction that holds the learner's enrolment row, that the learner still holds the course.
 * For an enrolment from an organization seat that check also asks whether the seat is still live, which used to read the course and the
 * learner's roles through the global client: a second pooled connection while the transaction holds the first. With a small pool and
 * parallel issues, every connection was held and nobody could get another (P2024).
 */
describe("issuing certificates for organization seats with a small connection pool", () => {
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

  /** An organization course and a learner who finished it on an organization seat. */
  async function seatHolder(course: { id: string }, orgId: string, withSeat = true) {
    const learner = await t.login();
    if (withSeat) await f.grantRole(learner.userId, "org_learner", orgId);
    await prisma.enrolment.create({ data: { courseId: course.id, userId: learner.userId, source: "ORG_SEAT", completedAt: new Date(), progressPct: 100 } });
    return learner;
  }

  it("parallel issues for seat holders all produce a certificate", async () => {
    const { org, owner } = await f.organization();
    const course = await f.newCourse(owner, { ownerType: "ORG", orgId: org.id });
    await f.published(course.id);
    const learners = await Promise.all(Array.from({ length: BURST }, () => seatHolder(course, org.id)));
    const certs = t.app.get(CertificatesService);
    const issued = await Promise.all(learners.map((l) => certs.issue(l.userId, course.id)));
    expect(issued.map((c) => c?.userId)).toEqual(learners.map((l) => l.userId));
  });

  it("a learner whose seat is gone still gets no certificate", async () => {
    const { org, owner } = await f.organization();
    const course = await f.newCourse(owner, { ownerType: "ORG", orgId: org.id });
    await f.published(course.id);
    const gone = await seatHolder(course, org.id, false);
    expect(await t.app.get(CertificatesService).issue(gone.userId, course.id)).toBeNull();
  });
});
