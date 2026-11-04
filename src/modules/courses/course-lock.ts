import type { Prisma } from "@prisma/client";

/** Row lock: concurrent edits of one course (settings, curriculum, deletion) serialise. Take it before touching the course's media. */
export const lockCourse = (tx: Prisma.TransactionClient, id: string) => tx.$queryRaw`SELECT "id" FROM "courses" WHERE "id" = ${id} FOR UPDATE`;
