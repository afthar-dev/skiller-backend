import type { Prisma } from "@prisma/client";
import { lockCourse } from "./course-lock";

/** Reason stored on a review the system hid because its author's enrolment ended. */
export const ENROLMENT_ENDED = "ENROLMENT_ENDED";

/** The rating is shown to the public only once this many learners rated. */
export const MIN_RATINGS_TO_SHOW = 3;

/**
 * Recomputes `ratingAvg` (2 decimals) and `ratingCount` from the visible reviews (hiddenAt null) in one statement. Callers hold the course
 * row lock (FOR UPDATE) from before they changed a review until their transaction ends, so two concurrent changes cannot publish a stale figure.
 */
export async function recomputeRating(tx: Prisma.TransactionClient, courseId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "courses" c SET
      "ratingAvg" = r."avg",
      "ratingCount" = r."n"
    FROM (SELECT ROUND(AVG("rating")::numeric, 2) AS "avg", COUNT(*)::int AS "n" FROM "reviews" WHERE "courseId" = ${courseId} AND "hiddenAt" IS NULL) r
    WHERE c."id" = ${courseId}`;
}

/** The learner's enrolment ended (refund, lost seat): their review leaves the list and the average. Same transaction as the revocation. */
export async function hideReviewOfEndedEnrolment(tx: Prisma.TransactionClient, courseId: string, userId: string, at: Date): Promise<void> {
  await lockCourse(tx, courseId);
  const res = await tx.review.updateMany({ where: { courseId, userId, hiddenAt: null }, data: { hiddenAt: at, hiddenBy: null, hiddenReason: ENROLMENT_ENDED } });
  if (res.count > 0) await recomputeRating(tx, courseId);
}

/** The enrolment is active again: the review the system hid comes back. One a moderator hid (hiddenBy set) stays hidden. */
export async function restoreReviewOfReactivatedEnrolment(tx: Prisma.TransactionClient, courseId: string, userId: string): Promise<void> {
  await lockCourse(tx, courseId);
  const res = await tx.review.updateMany({ where: { courseId, userId, hiddenAt: { not: null }, hiddenBy: null }, data: { hiddenAt: null, hiddenReason: null } });
  if (res.count > 0) await recomputeRating(tx, courseId);
}
