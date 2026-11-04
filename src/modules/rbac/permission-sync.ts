import { Logger } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";
import { REVOKED_DEFAULT_GRANTS, SUPER_ADMIN_ROLE_KEY, SYSTEM_ROLES } from "./default-roles";
import type { PermissionRegistry } from "./permission.registry";

export interface SyncResult {
  /** Keys inserted by this run. */
  inserted: string[];
  /** Keys present in the DB but no longer defined in code. Never deleted: an operator decides. */
  orphans: string[];
}

const logger = new Logger("PermissionSync");

/**
 * Brings the `permissions` table in line with the code registry: upserts keys (never deletes), logs orphans, and makes sure
 * `super_admin` exists and holds every key. Safe to run on every release and repeatedly.
 */
export async function syncPermissions(prisma: PrismaClient, registry: PermissionRegistry): Promise<SyncResult> {
  const defs = registry.all();
  const existing = await prisma.permission.findMany({ select: { key: true } });
  const known = new Set(existing.map((p) => p.key));

  const missing = defs.filter((d) => !known.has(d.key));
  if (missing.length > 0) {
    await prisma.permission.createMany({ data: missing.map((d) => ({ key: d.key, module: d.module, description: d.description })), skipDuplicates: true });
  }

  const inCode = new Set(defs.map((d) => d.key));
  const orphans = [...known].filter((k) => !inCode.has(k));
  for (const key of orphans) logger.warn(`orphan permission "${key}" is in the database but not in code`);

  const superDef = SYSTEM_ROLES.find((r) => r.key === SUPER_ADMIN_ROLE_KEY)!;
  const superAdmin = await prisma.role.upsert({
    where: { key: SUPER_ADMIN_ROLE_KEY },
    update: {},
    create: { key: SUPER_ADMIN_ROLE_KEY, name: superDef.name, scope: superDef.scope, isSystem: true },
  });
  const rows = await prisma.permission.findMany({ where: { key: { in: [...inCode] } }, select: { id: true } });
  await prisma.rolePermission.createMany({ data: rows.map((p) => ({ roleId: superAdmin.id, permissionId: p.id })), skipDuplicates: true });

  return { inserted: missing.map((d) => d.key), orphans };
}

/**
 * Creates the default system roles that do not exist yet, with their default permissions. For roles that already exist it only
 * ADDS default permissions they are missing (a release that adds keys reaches existing databases) and never revokes or edits (except the targeted REVOKED_DEFAULT_GRANTS list)
 * anything an operator did. Holders of a changed role are passed to `invalidateUsers` so their cached permissions refresh.
 */
export async function seedSystemRoles(prisma: PrismaClient, opts: { invalidateUsers?: (userIds: string[]) => Promise<void> } = {}): Promise<string[]> {
  const created: string[] = [];
  const changedRoleIds: string[] = [];
  for (const def of SYSTEM_ROLES) {
    if (def.key === SUPER_ADMIN_ROLE_KEY) continue; // owned by syncPermissions
    const exists = await prisma.role.findUnique({ where: { key: def.key }, select: { id: true } });
    const perms = await prisma.permission.findMany({ where: { key: { in: [...def.permissions] } }, select: { id: true, key: true } });
    if (perms.length !== def.permissions.length) {
      const have = new Set(perms.map((p) => p.key));
      throw new Error(`System role "${def.key}" references unknown permissions: ${def.permissions.filter((k) => !have.has(k)).join(", ")}`);
    }
    if (exists) {
      const held = new Set((await prisma.rolePermission.findMany({ where: { roleId: exists.id }, select: { permissionId: true } })).map((r) => r.permissionId));
      const missing = perms.filter((p) => !held.has(p.id));
      if (missing.length > 0) {
        await prisma.rolePermission.createMany({ data: missing.map((p) => ({ roleId: exists.id, permissionId: p.id })), skipDuplicates: true });
        changedRoleIds.push(exists.id);
      }
      const revoke = REVOKED_DEFAULT_GRANTS[def.key] ?? [];
      if (revoke.length > 0) {
        const removed = await prisma.rolePermission.deleteMany({ where: { roleId: exists.id, permission: { key: { in: [...revoke] } } } });
        if (removed.count > 0) changedRoleIds.push(exists.id);
      }
      continue;
    }
    await prisma.role.create({
      data: { key: def.key, name: def.name, scope: def.scope, isSystem: true, rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) } },
    });
    created.push(def.key);
  }
  if (changedRoleIds.length > 0 && opts.invalidateUsers) {
    const holders = await prisma.userRole.findMany({ where: { roleId: { in: changedRoleIds } }, select: { userId: true }, distinct: ["userId"] });
    if (holders.length > 0) await opts.invalidateUsers(holders.map((h) => h.userId));
  }
  return created;
}

/** Bootstraps the configured super admin: user (verified) + platform `super_admin` grant. Idempotent. */
export async function bootstrapSuperAdmin(prisma: PrismaClient, email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const user = await prisma.user.upsert({
    where: { email: normalized },
    update: {},
    create: { email: normalized, emailVerifiedAt: new Date() },
  });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: SUPER_ADMIN_ROLE_KEY } });
  const held = await prisma.userRole.findFirst({ where: { userId: user.id, roleId: role.id, orgId: null } });
  if (!held) await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, orgId: null } });
}
