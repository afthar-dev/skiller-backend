import type { Prisma, PrismaClient } from "@prisma/client";
import { SEED_PLANS } from "./plan-catalog";

/** Idempotent catalog seed (plan key + version price/interval identify a row): fills what is missing, never edits what an admin changed. */
export async function seedPlans(prisma: Pick<PrismaClient, "plan" | "planVersion">): Promise<void> {
  for (const def of SEED_PLANS) {
    const plan = await prisma.plan.upsert({ where: { key: def.key }, create: { key: def.key, name: def.name, audience: def.audience }, update: {} });
    for (const v of def.versions) {
      const exists = await prisma.planVersion.findFirst({ where: { planId: plan.id, pricePaise: v.pricePaise, interval: v.interval }, select: { id: true } });
      if (exists) continue;
      await prisma.planVersion.create({
        data: { planId: plan.id, pricePaise: v.pricePaise, interval: v.interval, commissionBps: v.commissionBps, limits: v.limits as unknown as Prisma.InputJsonObject },
      });
    }
  }
}
