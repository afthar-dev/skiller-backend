import { PrismaClient } from "@prisma/client";
import { SYSTEM_ROLES } from "./default-roles";
import { seedSystemRoles } from "./permission-sync";

describe("seedSystemRoles on an existing database", () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  });
  afterAll(() => prisma.$disconnect());

  const keysOf = async (roleKey: string) =>
    (await prisma.rolePermission.findMany({ where: { role: { key: roleKey } }, select: { permission: { select: { key: true } } } })).map((r) => r.permission.key).sort();

  it("grants the default permissions an existing system role is missing, never revokes, and reports who is affected", async () => {
    const def = SYSTEM_ROLES.find((r) => r.key === "finance_admin")!;
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "finance_admin" } });
    // Simulate a database seeded before the Phase 2 keys existed, plus an admin edit: an extra grant and a removed default.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permission: { key: { in: ["payout.approve", "billing.refund"] } } } });
    const extra = await prisma.permission.findUniqueOrThrow({ where: { key: "media.manage_any" } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: extra.id } });
    const holder = await prisma.user.create({ data: { email: `holder-${Date.now()}@example.com` } });
    await prisma.userRole.create({ data: { userId: holder.id, roleId: role.id, orgId: null } });

    const invalidated: string[][] = [];
    await seedSystemRoles(prisma, { invalidateUsers: async (ids) => void invalidated.push(ids) });

    const after = await keysOf("finance_admin");
    for (const k of def.permissions) expect(after).toContain(k);
    expect(after).toContain("media.manage_any"); // nothing is revoked
    expect(invalidated.flat()).toContain(holder.id);

    // A second run changes nothing and invalidates nobody.
    invalidated.length = 0;
    await seedSystemRoles(prisma, { invalidateUsers: async (ids) => void invalidated.push(ids) });
    expect(invalidated.flat()).toHaveLength(0);
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: extra.id } });
  });

  it("revokes course.manage_any from the moderator role (shipped by mistake) and nothing else", async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "moderator" } });
    expect(await keysOf("moderator")).not.toContain("course.manage_any");
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "course.manage_any" } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    const holder = await prisma.user.create({ data: { email: `mod-${Date.now()}@example.com` } });
    await prisma.userRole.create({ data: { userId: holder.id, roleId: role.id, orgId: null } });

    const invalidated: string[][] = [];
    await seedSystemRoles(prisma, { invalidateUsers: async (ids) => void invalidated.push(ids) });

    const after = await keysOf("moderator");
    expect(after).not.toContain("course.manage_any");
    expect(after).toContain("course.review");
    expect(invalidated.flat()).toContain(holder.id);
  });
});
