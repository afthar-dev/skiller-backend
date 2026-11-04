import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { permissionRegistry } from "../src/modules/rbac/permission.registry";
import IORedis from "ioredis";
import { bumpPermissionEpochs } from "../src/modules/rbac/permission.service";
import { bootstrapSuperAdmin, seedSystemRoles, syncPermissions } from "../src/modules/rbac/permission-sync";
import "../src/modules/rbac/permissions";
import { seedPlans } from "../src/modules/billing/plans-seed";
import { seedCategories } from "../src/modules/courses/categories.service";
import { ensurePlatformAccounts } from "../src/modules/wallet/ledger-sql";

/** Idempotent: permissions, system roles, course categories, the SUPER_ADMIN_EMAIL user with the super_admin role, platform ledger accounts and the plan catalog. */
export async function runSeed(prisma: PrismaClient, superAdminEmail: string) {
  const sync = await syncPermissions(prisma, permissionRegistry);
  // New default permissions reach existing system roles; holders' cached permissions are refreshed when a Redis is configured.
  const redis = process.env.REDIS_URL ? new IORedis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 }) : null;
  let roles: string[];
  try {
    roles = await seedSystemRoles(prisma, redis ? { invalidateUsers: (ids) => bumpPermissionEpochs(redis, ids) } : {});
  } finally {
    redis?.disconnect();
  }
  await bootstrapSuperAdmin(prisma, superAdminEmail);
  // Seeded flags start off; update: {} so a re-seed never overwrites what an admin changed.
  await prisma.featureFlag.upsert({ where: { key: "gig_orders" }, create: { key: "gig_orders", enabled: false }, update: {} });
  await ensurePlatformAccounts(prisma);
  await seedPlans(prisma);
  await seedCategories(prisma);
  return { ...sync, roles };
}

async function main() {
  const superAdminEmail = z.string().email().parse(process.env.SUPER_ADMIN_EMAIL);
  const prisma = new PrismaClient();
  try {
    const result = await runSeed(prisma, superAdminEmail);
    console.log(`seed: ${result.inserted.length} permission(s) inserted, ${result.orphans.length} orphan(s), roles created: ${result.roles.join(", ") || "none"}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
