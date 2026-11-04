import { Inject, Injectable } from "@nestjs/common";
import type { Course, Enrolment, EnrolmentSource, Prisma } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { PlatformRoleDirectory } from "../rbac";
import { ORG_LEARNER_ROLE } from "./course-access-rules";
import { revokeCertificates } from "./certificate-revocation";
import { lockCourse } from "./course-lock";
import { hideReviewOfEndedEnrolment, restoreReviewOfReactivatedEnrolment } from "./course-rating";
import { ProgressService } from "./progress.service";

export interface EnrolmentView {
  id: string;
  courseId: string;
  courseSlug: string;
  courseTitle: string;
  thumbnailAssetId: string | null;
  courseStatus: Course["status"];
  /** A moderator hid the course from the catalog; learners who are enrolled keep their access. */
  flagged: boolean;
  source: EnrolmentSource;
  progressPct: number;
  completedAt: string | null;
  enrolledAt: string;
}

type WithCourse = Enrolment & { course: Pick<Course, "slug" | "title" | "thumbnailAssetId" | "status" | "flaggedAt"> };

export const toEnrolmentView = (e: WithCourse): EnrolmentView => ({
  id: e.id,
  courseId: e.courseId,
  courseSlug: e.course.slug,
  courseTitle: e.course.title,
  thumbnailAssetId: e.course.thumbnailAssetId,
  courseStatus: e.course.status,
  flagged: e.course.flaggedAt !== null,
  source: e.source,
  progressPct: e.progressPct,
  completedAt: e.completedAt?.toISOString() ?? null,
  enrolledAt: e.createdAt.toISOString(),
});

export const withCourse = { course: { select: { slug: true, title: true, thumbnailAssetId: true, status: true, flaggedAt: true } } } as const;

/**
 * Who is enrolled in what. The same class runs in the API and in the worker (webhook-first fulfilment and the organization
 * events happen there), so it needs nothing but the database, the clock and the role directory.
 * A learner has at most one row per course: revoking sets `revokedAt`, enrolling again reactivates that row.
 * `Course.enrolmentCount` counts the rows with `revokedAt` null and is only changed here, in the transaction of the change.
 * Lock order everywhere in the module (curriculum edits, progress recomputes, this service): the course row first, then enrolment rows
 * in id order. Every change here that touches an enrolment row therefore takes the course row before it.
 */
@Injectable()
export class EnrolmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: PlatformRoleDirectory,
    private readonly progress: ProgressService,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Gives the learner access. Idempotent: the same grant twice changes nothing. A purchase outranks a seat or a free
   * enrolment (it replaces their source, so losing the seat later cannot take paid access away); a second, different
   * purchase of a course already bought is refused with a 4xx so the fulfilment fails and the payment is refunded.
   */
  async grant(tx: Prisma.TransactionClient, input: { courseId: string; userId: string; source: EnrolmentSource; orderId?: string }): Promise<{ enrolment: Enrolment; changed: boolean }> {
    const key = { courseId_userId: { courseId: input.courseId, userId: input.userId } };
    const orderId = input.source === "PURCHASE" ? (input.orderId ?? null) : null;
    await lockCourse(tx, input.courseId);

    // ON CONFLICT DO NOTHING: a concurrent insert of the same pair waits for the other transaction instead of aborting this one.
    const created = await tx.enrolment.createMany({ data: [{ courseId: input.courseId, userId: input.userId, source: input.source, orderId }], skipDuplicates: true });
    if (created.count === 1) {
      await this.bump(tx, input.courseId, 1);
      return { enrolment: await tx.enrolment.findUniqueOrThrow({ where: key }), changed: true };
    }

    await tx.$queryRaw`SELECT "id" FROM "enrolments" WHERE "courseId" = ${input.courseId} AND "userId" = ${input.userId} FOR UPDATE`;
    const row = await tx.enrolment.findUniqueOrThrow({ where: key });
    if (row.revokedAt) {
      await tx.enrolment.update({ where: key, data: { revokedAt: null, source: input.source, orderId } });
      await this.bump(tx, input.courseId, 1);
      await restoreReviewOfReactivatedEnrolment(tx, input.courseId, input.userId);
      await this.progress.refreshEnrolment(tx, input.courseId, input.userId); // curriculum changes while revoked left the old figures behind
      // Finished before it was revoked: that completion is not new, so nothing would announce it. Announce it again so the certificate revoked with the enrolment is issued afresh.
      if (row.completedAt) await this.outbox.enqueue(tx, { type: "course.completed", userId: input.userId, courseId: input.courseId });
      return { enrolment: await tx.enrolment.findUniqueOrThrow({ where: key }), changed: true };
    }
    // A seat that is still in the table but no longer backed by a live org_learner grant (the buyer relation says NONE): the user now holds the course on their own terms.
    if (input.source === "FREE" && row.source === "ORG_SEAT") return { enrolment: await tx.enrolment.update({ where: key, data: { source: "FREE", orderId: null } }), changed: true };
    if (input.source !== "PURCHASE") return { enrolment: row, changed: false };
    if (row.source !== "PURCHASE") return { enrolment: await tx.enrolment.update({ where: key, data: { source: "PURCHASE", orderId } }), changed: true };
    if (row.orderId === orderId) return { enrolment: row, changed: false };
    throw new AppError("COURSE_ALREADY_ENROLLED", 409, "The buyer is already enrolled in this course");
  }

  /** A refunded order takes back the access it gave. An enrolment that came from another order is left alone. */
  async revokeForOrder(tx: Prisma.TransactionClient, input: { courseId: string; userId: string; orderId: string }): Promise<void> {
    await lockCourse(tx, input.courseId);
    const revoked = await tx.enrolment.updateMany({ where: { courseId: input.courseId, userId: input.userId, orderId: input.orderId, revokedAt: null }, data: { revokedAt: this.clock.now() } });
    if (revoked.count > 0) {
      await this.bump(tx, input.courseId, -1);
      await revokeCertificates(tx, input.courseId, input.userId, this.clock.now());
      await hideReviewOfEndedEnrolment(tx, input.courseId, input.userId, this.clock.now());
    }
  }

  /**
   * The user lost an organization role: when they no longer hold `org_learner` there, the seats they took in that
   * organization's courses end. What they paid for, and free courses, stay. Safe to repeat and to run late (a learner who has
   * come back keeps their seats).
   */
  async revokeOrgSeats(orgId: string, userId: string): Promise<number> {
    if ((await this.roles.roleKeysInOrg(userId, orgId)).includes(ORG_LEARNER_ROLE)) return 0;
    const seats = await this.prisma.enrolment.findMany({ where: { userId, source: "ORG_SEAT", revokedAt: null, course: { ownerType: "ORG", ownerId: orgId } }, select: { id: true, courseId: true } });
    let revoked = 0;
    for (const seat of seats) {
      revoked += await this.prisma.$transaction(async (tx) => {
        await lockCourse(tx, seat.courseId);
        const res = await tx.enrolment.updateMany({ where: { id: seat.id, source: "ORG_SEAT", revokedAt: null }, data: { revokedAt: this.clock.now() } });
        if (res.count > 0) {
          await this.bump(tx, seat.courseId, -1);
          await revokeCertificates(tx, seat.courseId, userId, this.clock.now());
          await hideReviewOfEndedEnrolment(tx, seat.courseId, userId, this.clock.now());
        }
        return res.count;
      });
    }
    return revoked;
  }

  /**
   * Daily sweep: ends every active ORG_SEAT enrolment whose user no longer holds a live org_learner grant in the owning organization
   * (the grant expired, which emits no event). Batched by enrolment id; safe to repeat. Returns how many were revoked.
   */
  async sweepOrgSeats(batch = 500): Promise<number> {
    let revoked = 0;
    let after: string | undefined;
    for (;;) {
      const rows = await this.prisma.enrolment.findMany({
        where: { source: "ORG_SEAT", revokedAt: null, ...(after ? { id: { gt: after } } : {}) },
        select: { id: true, userId: true, course: { select: { ownerId: true } } },
        orderBy: { id: "asc" },
        take: batch,
      });
      if (rows.length === 0) return revoked;
      after = rows[rows.length - 1].id;
      const pairs = new Map(rows.map((r) => [`${r.course.ownerId}:${r.userId}`, { orgId: r.course.ownerId, userId: r.userId }]));
      for (const p of pairs.values()) revoked += await this.revokeOrgSeats(p.orgId, p.userId);
    }
  }

  async activeFor(userId: string, courseId: string): Promise<Enrolment | null> {
    return this.prisma.enrolment.findFirst({ where: { userId, courseId, revokedAt: null } });
  }

  /** The learner's active enrolments, most recently created first. Courses that were unpublished, flagged or archived since stay listed. */
  async learning(userId: string, page: PageQuery) {
    const rows = await this.prisma.enrolment.findMany({
      where: { userId, revokedAt: null, ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      include: withCourse,
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: items.map(toEnrolmentView), nextCursor };
  }

  private async bump(tx: Prisma.TransactionClient, courseId: string, by: 1 | -1): Promise<void> {
    await tx.course.update({ where: { id: courseId }, data: { enrolmentCount: { increment: by } } });
  }
}
