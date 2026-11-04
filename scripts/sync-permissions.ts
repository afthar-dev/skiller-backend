import { PrismaClient } from "@prisma/client";
import { permissionRegistry } from "../src/modules/rbac/permission.registry";
import { seedSystemRoles, syncPermissions } from "../src/modules/rbac/permission-sync";
import "../src/modules/rbac/permissions";

// Release step: `pnpm db:sync-permissions`. Upserts permission keys, re-grants everything to super_admin, reports orphans,
// then adds any missing default grants to the other system roles (add-only) so new keys reach existing roles on a normal release.
// No Redis here: cached permission sets pick the new grants up when their entries expire.
async function main() {
  const prisma = new PrismaClient();
  try {
    const { inserted, orphans } = await syncPermissions(prisma, permissionRegistry);
    console.log(`permissions synced: ${inserted.length} inserted${inserted.length ? ` (${inserted.join(", ")})` : ""}, ${orphans.length} orphan(s)${orphans.length ? ` (${orphans.join(", ")})` : ""}`);
    const created = await seedSystemRoles(prisma);
    console.log(`system roles synced${created.length ? `: created ${created.join(", ")}` : ""}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
