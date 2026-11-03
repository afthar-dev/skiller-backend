import { PrismaClient } from "@prisma/client";
import { permissionRegistry } from "../src/modules/rbac/permission.registry";
import { syncPermissions } from "../src/modules/rbac/permission-sync";
import "../src/modules/rbac/permissions";

// Release step: `pnpm db:sync-permissions`. Upserts permission keys, re-grants everything to super_admin, reports orphans.
async function main() {
  const prisma = new PrismaClient();
  try {
    const { inserted, orphans } = await syncPermissions(prisma, permissionRegistry);
    console.log(`permissions synced: ${inserted.length} inserted${inserted.length ? ` (${inserted.join(", ")})` : ""}, ${orphans.length} orphan(s)${orphans.length ? ` (${orphans.join(", ")})` : ""}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
