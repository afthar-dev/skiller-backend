import type { Prisma } from "@prisma/client";

/**
 * Revokes the learner's live certificate for a course, in the transaction that ends their enrolment (refund, lost seat), so access and
 * certificate never disagree. A revoked certificate stays on record: the verify page says REVOKED. Safe to repeat (first revocation time stays).
 */
export async function revokeCertificates(tx: Prisma.TransactionClient, courseId: string, userId: string, at: Date): Promise<number> {
  const res = await tx.certificate.updateMany({ where: { courseId, userId, revokedAt: null }, data: { revokedAt: at } });
  return res.count;
}
