import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { permissionRegistry } from "../src/modules/rbac/permission.registry";
import { bootstrapSuperAdmin, seedSystemRoles, syncPermissions } from "../src/modules/rbac/permission-sync";
import "../src/modules/rbac/permissions";
import { ensurePlatformAccounts } from "../src/modules/wallet/ledger-sql";

/** Idempotent: permissions, system roles and the SUPER_ADMIN_EMAIL user with the super_admin role. */
export async function runSeed(prisma: PrismaClient, superAdminEmail: string) {
  const sync = await syncPermissions(prisma, permissionRegistry);
  const roles = await seedSystemRoles(prisma);
  await bootstrapSuperAdmin(prisma, superAdminEmail);
  // Seeded flags start off; update: {} so a re-seed never overwrites what an admin changed.
  await prisma.featureFlag.upsert({ where: { key: "gig_orders" }, create: { key: "gig_orders", enabled: false }, update: {} });
  await ensurePlatformAccounts(prisma);
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
