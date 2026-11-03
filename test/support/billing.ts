import type { PrismaService } from "../../src/common/prisma/prisma.service";

/** Puts an owner on a seeded plan (latest version of the interval) without going through Razorpay: an ACTIVE subscription row. */
export async function givePlan(prisma: PrismaService, ownerType: "USER" | "ORG", ownerId: string, planKey: string, interval: "MONTH" | "YEAR" = "MONTH") {
  const version = await prisma.planVersion.findFirstOrThrow({ where: { plan: { key: planKey }, interval }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const paid = version.pricePaise > 0n;
  return prisma.subscription.create({
    data: {
      ownerType,
      ownerId,
      planVersionId: version.id,
      status: "ACTIVE",
      razorpaySubscriptionId: paid ? `sub_test_${Math.random().toString(36).slice(2, 12)}` : null,
      currentPeriodEnd: paid ? new Date(Date.now() + 30 * 86400_000) : null,
    },
  });
}
