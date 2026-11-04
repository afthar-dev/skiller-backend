import type { Prisma } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";

/** Row lock: concurrent edits of one course (settings, curriculum, deletion) serialise. Take it before touching the course's media. */
export const lockCourse = (tx: Prisma.TransactionClient, id: string) => tx.$queryRaw`SELECT "id" FROM "courses" WHERE "id" = ${id} FOR UPDATE`;

/** The lock for any content edit: refuses (409 COURSE_IN_REVIEW) while a moderator may be reading the course. Withdraw it to edit. */
export async function lockCourseForEdit(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "courses" WHERE "id" = ${id} FOR UPDATE`;
  if (rows[0]?.status === "IN_REVIEW") throw new AppError("COURSE_IN_REVIEW", 409, "This course is in review and cannot be edited; withdraw it first");
}
