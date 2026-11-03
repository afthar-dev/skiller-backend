import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, type RoleScope } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { type PageQuery } from "../../common/http/pagination";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { SUPER_ADMIN_ROLE_KEY } from "./default-roles";
import { PermissionService } from "./permission.service";

/** Request details copied into audit rows. */
export interface MutationMeta {
  ip?: string;
  requestId?: string;
}

export interface RoleView {
  id: string;
  key: string;
  name: string;
  scope: RoleScope;
  isSystem: boolean;
  permissionKeys: string[];
  createdAt: string;
}

export interface UserRoleView {
  id: string;
  userId: string;
  roleKey: string;
  orgId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const roleInclude = { rolePermissions: { select: { permission: { select: { id: true, key: true } } } } } satisfies Prisma.RoleInclude;
type RoleRow = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

const keysOf = (role: RoleRow) => role.rolePermissions.map((rp) => rp.permission.key).sort();
const auditShape = (role: RoleRow) => ({ key: role.key, name: role.name, scope: role.scope, isSystem: role.isSystem, permissionKeys: keysOf(role) });
const toRoleView = (role: RoleRow): RoleView => ({ id: role.id, ...auditShape(role), createdAt: role.createdAt.toISOString() });

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Keys of the user's active platform-wide roles (org-scoped grants excluded). */
  async platformRoleKeys(userId: string): Promise<string[]> {
    const now = this.clock.now();
    const rows = await this.prisma.userRole.findMany({
      where: { userId, orgId: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { role: { select: { key: true } } },
    });
    return rows.map((r) => r.role.key).sort();
  }

  /** Whether the user holds any active role in the org. */
  async isOrgMember(orgId: string, userId: string, client: Prisma.TransactionClient | PrismaService = this.prisma): Promise<boolean> {
    const now = this.clock.now();
    const count = await client.userRole.count({ where: { orgId, userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
    return count > 0;
  }

  /** Org members, one entry per person with all their active roles, paged by user id. */
  async listOrgMembers(orgId: string, page: PageQuery): Promise<{ items: { userId: string; roles: string[] }[]; nextCursor: string | null }> {
    const now = this.clock.now();
    const active = { orgId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } satisfies Prisma.UserRoleWhereInput;
    const people = await this.prisma.userRole.findMany({
      where: { ...active, ...(page.cursor ? { userId: { gt: page.cursor } } : {}) },
      distinct: ["userId"],
      orderBy: { userId: "asc" },
      take: page.limit + 1,
      select: { userId: true },
    });
    const pageIds = people.slice(0, page.limit).map((p) => p.userId);
    const grants = await this.prisma.userRole.findMany({ where: { ...active, userId: { in: pageIds } }, select: { userId: true, role: { select: { key: true } } } });
    const byUser = new Map<string, string[]>();
    for (const g of grants) byUser.set(g.userId, [...(byUser.get(g.userId) ?? []), g.role.key]);
    return {
      items: pageIds.map((userId) => ({ userId, roles: (byUser.get(userId) ?? []).sort() })),
      nextCursor: people.length > page.limit ? pageIds[pageIds.length - 1] : null,
    };
  }

  /** Removes every grant the user holds in the org. Returns false when they held none. */
  async removeOrgMember(actorId: string, orgId: string, userId: string, meta: MutationMeta = {}): Promise<boolean> {
    const removed = await this.prisma.$transaction(async (tx) => {
      const grants = await tx.userRole.findMany({ where: { orgId, userId }, include: { role: { select: { key: true } } } });
      if (grants.length === 0) return false;
      await this.enqueueInvalidation(tx, [userId]);
      await tx.userRole.deleteMany({ where: { id: { in: grants.map((g) => g.id) } } });
      for (const g of grants) {
        await this.audit.record(tx, { actorId, action: "role.revoke", targetType: "user_role", targetId: g.id, before: this.userRoleShape(g, g.role.key), after: null, ...meta });
      }
      return true;
    });
    if (removed) await this.invalidateWithRetry(() => this.permissions.invalidateUser(userId), `user ${userId}`);
    return removed;
  }

  async list(): Promise<RoleView[]> {
    const roles = await this.prisma.role.findMany({ include: roleInclude, orderBy: { key: "asc" } });
    return roles.map(toRoleView);
  }

  async create(
    actorId: string,
    input: { key: string; name: string; scope: RoleScope; permissionKeys: string[] },
    meta: MutationMeta = {},
  ): Promise<RoleView> {
    const keys = [...new Set(input.permissionKeys)];
    const permissionIds = await this.resolvePermissionIds(keys);
    await this.assertActorHolds(actorId, keys, null);

    const role = await this.prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          key: input.key,
          name: input.name,
          scope: input.scope,
          createdById: actorId,
          rolePermissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
        },
        include: roleInclude,
      });
      await this.audit.record(tx, { actorId, action: "role.create", targetType: "role", targetId: created.id, before: null, after: auditShape(created), ...meta });
      return created;
    });
    return toRoleView(role);
  }

  async update(actorId: string, roleId: string, patch: { name?: string; permissionKeys?: string[] }, meta: MutationMeta = {}): Promise<RoleView> {
    const current = await this.prisma.role.findUnique({ where: { id: roleId }, include: roleInclude });
    if (!current) throw this.roleNotFound();

    let permissionIds: string[] | undefined;
    if (patch.permissionKeys) {
      if (current.key === SUPER_ADMIN_ROLE_KEY) {
        throw new AppError("ROLE_SYSTEM_PROTECTED", 409, "The super_admin role always holds every permission");
      }
      const keys = [...new Set(patch.permissionKeys)];
      permissionIds = await this.resolvePermissionIds(keys);
      const existing = new Set(keysOf(current));
      await this.assertActorHolds(actorId, keys.filter((k) => !existing.has(k)), null);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (patch.name !== undefined) await tx.role.update({ where: { id: roleId }, data: { name: patch.name } });
      if (permissionIds) {
        await tx.rolePermission.deleteMany({ where: { roleId } });
        await tx.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId, permissionId })) });
      }
      const after = await tx.role.findUniqueOrThrow({ where: { id: roleId }, include: roleInclude });
      const holders = await tx.userRole.findMany({ where: { roleId }, select: { userId: true }, distinct: ["userId"] });
      await this.enqueueInvalidation(tx, holders.map((h) => h.userId));
      await this.audit.record(tx, { actorId, action: "role.update", targetType: "role", targetId: roleId, before: auditShape(current), after: auditShape(after), ...meta });
      return after;
    });

    // After commit and before returning: holders see the new permissions on their very next request.
    await this.invalidateWithRetry(() => this.permissions.invalidateRole(roleId), `role ${roleId}`);
    return toRoleView(updated);
  }

  async delete(actorId: string, roleId: string, meta: MutationMeta = {}): Promise<void> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId }, include: roleInclude });
    if (!role) throw this.roleNotFound();
    if (role.isSystem) throw new AppError("ROLE_SYSTEM_PROTECTED", 409, "System roles cannot be deleted");

    const holders = await this.prisma.$transaction(async (tx) => {
      // Holders must be read before the delete cascades their UserRole rows away.
      const rows = await tx.userRole.findMany({ where: { roleId }, select: { userId: true }, distinct: ["userId"] });
      await tx.role.delete({ where: { id: roleId } });
      await this.enqueueInvalidation(tx, rows.map((r) => r.userId));
      await this.audit.record(tx, { actorId, action: "role.delete", targetType: "role", targetId: roleId, before: auditShape(role), after: null, ...meta });
      return rows.map((r) => r.userId);
    });
    await this.invalidateWithRetry(() => this.permissions.invalidateUsers(holders), `deleted role ${roleId}`);
  }

  async grant(
    actorId: string,
    input: { userId: string; roleKey: string; orgId?: string; expiresAt?: Date },
    meta: MutationMeta = {},
  ): Promise<UserRoleView> {
    const role = await this.prisma.role.findUnique({ where: { key: input.roleKey }, include: roleInclude });
    if (!role) throw this.roleNotFound();
    const orgId = input.orgId ?? null;
    if (role.scope === "ORG" && orgId === null) throw new AppError("ROLE_SCOPE_MISMATCH", 400, "This role is organization-scoped; orgId is required");
    if (role.scope === "PLATFORM" && orgId !== null) throw new AppError("ROLE_SCOPE_MISMATCH", 400, "This role is platform-wide; orgId must not be set");
    const now = this.clock.now();
    if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
      throw new AppError("VALIDATION_FAILED", 400, "expiresAt must be in the future", { fields: { expiresAt: ["must be in the future"] } });
    }
    await this.assertActorHolds(actorId, keysOf(role), orgId);

    const view = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
      if (!user) throw new AppError("NOT_FOUND", 404, "User not found");

      const existing = await tx.userRole.findFirst({ where: { userId: input.userId, roleId: role.id, orgId } });
      if (existing && (existing.expiresAt === null || existing.expiresAt.getTime() > now.getTime())) {
        throw new AppError("ROLE_ALREADY_GRANTED", 409, "User already holds this role");
      }
      const data = { grantedById: actorId, expiresAt: input.expiresAt ?? null };
      // An expired grant still occupies the unique slot, so re-granting renews it instead of inserting.
      const row = existing
        ? await tx.userRole.update({ where: { id: existing.id }, data: { ...data, createdAt: now } })
        : await tx.userRole.create({ data: { userId: input.userId, roleId: role.id, orgId, ...data } });

      const after = this.userRoleShape(row, role.key);
      await this.audit.record(tx, {
        actorId,
        action: "role.grant",
        targetType: "user_role",
        targetId: row.id,
        before: existing ? this.userRoleShape(existing, role.key) : null,
        after,
        ...meta,
      });
      await this.outbox.enqueue(tx, { type: "role.granted", userId: input.userId, roleKey: role.key, grantedBy: actorId });
      await this.enqueueInvalidation(tx, [input.userId]);
      return { id: row.id, ...after };
    });

    await this.invalidateWithRetry(() => this.permissions.invalidateUser(input.userId), `user ${input.userId}`);
    return view;
  }

  async revoke(actorId: string, userRoleId: string, meta: MutationMeta & { userId?: string } = {}): Promise<void> {
    const { userId: expectedUserId, ...auditMeta } = meta;
    const target = await this.prisma.userRole.findUnique({ where: { id: userRoleId }, include: { role: { include: roleInclude } } });
    if (!target || (expectedUserId !== undefined && target.userId !== expectedUserId)) throw new AppError("NOT_FOUND", 404, "Role grant not found");
    await this.assertActorHolds(actorId, keysOf(target.role), target.orgId);

    await this.prisma.$transaction(async (tx) => {
      if (target.role.key === SUPER_ADMIN_ROLE_KEY) {
        // Lock every active super_admin grant (fixed order, so concurrent revokes cannot deadlock). A second revoke blocks here
        // until the first commits, then sees the reduced set and is refused.
        const now = this.clock.now();
        // Only grants of ACTIVE users count: a suspended or deleted super_admin cannot act, so it is no safety net.
        const active = await tx.$queryRaw<{ id: string }[]>`
          SELECT ur.id FROM user_roles ur
          JOIN users u ON u.id = ur."userId"
          WHERE ur."roleId" = ${target.roleId} AND (ur."expiresAt" IS NULL OR ur."expiresAt" > ${now}) AND u.status = 'ACTIVE'
          ORDER BY ur.id
          FOR UPDATE OF ur`;
        if (active.some((r) => r.id === target.id) && active.length <= 1) {
          throw new AppError("LAST_SUPER_ADMIN", 409, "Cannot revoke the last active super_admin");
        }
      }
      await this.enqueueInvalidation(tx, [target.userId]);
      const deleted = await tx.userRole.deleteMany({ where: { id: target.id } });
      if (deleted.count === 0) throw new AppError("NOT_FOUND", 404, "Role grant not found");
      await this.audit.record(tx, {
        actorId,
        action: "role.revoke",
        targetType: "user_role",
        targetId: target.id,
        before: this.userRoleShape(target, target.role.key),
        after: null,
        ...auditMeta,
      });
    });

    await this.invalidateWithRetry(() => this.permissions.invalidateUser(target.userId), `user ${target.userId}`);
  }

  /**
   * Grants a system role without an acting user (e.g. `member` at sign-up). Pass the caller's transaction to make the grant
   * atomic with it; the caller is then responsible for any cache invalidation (a brand-new user has no cached permissions).
   */
  async grantSystem(userId: string, roleKey: string, tx?: Prisma.TransactionClient, orgId?: string): Promise<void> {
    const run = async (client: Prisma.TransactionClient) => {
      const role = await client.role.findUnique({ where: { key: roleKey }, select: { id: true, key: true, scope: true } });
      if (!role) throw new AppError("ROLE_NOT_FOUND", 500, `System role "${roleKey}" is missing; run the database seed`);
      if ((role.scope === "ORG") !== (orgId !== undefined)) {
        throw new AppError("ROLE_SCOPE_MISMATCH", 500, `System role "${roleKey}" does not match the requested scope`);
      }
      const scopeOrgId = orgId ?? null;
      const existing = await client.userRole.findFirst({ where: { userId, roleId: role.id, orgId: scopeOrgId }, select: { id: true } });
      if (existing) return;
      const row = await client.userRole.create({ data: { userId, roleId: role.id, orgId: scopeOrgId } });
      await this.audit.record(client, {
        actorId: null,
        action: "role.grant_system",
        targetType: "user_role",
        targetId: row.id,
        before: null,
        after: this.userRoleShape(row, role.key),
      });
    };
    if (tx) await run(tx);
    else {
      await this.prisma.$transaction(run);
      await this.invalidateWithRetry(() => this.permissions.invalidateUser(userId), `user ${userId}`);
    }
  }

  /**
   * Written in the mutation's own transaction: if the direct cache invalidation after commit fails, the relayed event makes the
   * worker bump the same epochs. Extra bumps only cost a cache miss.
   */
  private async enqueueInvalidation(tx: Prisma.TransactionClient, userIds: string[]): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length > 0) await this.outbox.enqueue(tx, { type: "rbac.permissions_changed", userIds: unique });
  }

  /** Post-commit invalidation: retried, and a final failure is logged but never fails the already-committed request. */
  private async invalidateWithRetry(fn: () => Promise<void>, what: string): Promise<void> {
    const attempts = 3;
    for (let i = 1; i <= attempts; i++) {
      try {
        await fn();
        return;
      } catch (err) {
        if (i === attempts) {
          this.logger.error(`permission cache invalidation failed for ${what}; relying on the outbox backstop`, err instanceof Error ? err.stack : String(err));
          return;
        }
        await new Promise((r) => setTimeout(r, 25 * i));
      }
    }
  }

  private userRoleShape(row: { userId: string; orgId: string | null; expiresAt: Date | null; createdAt: Date }, roleKey: string) {
    return {
      userId: row.userId,
      roleKey,
      orgId: row.orgId,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async resolvePermissionIds(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const rows = await this.prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true, key: true } });
    const found = new Set(rows.map((r) => r.key));
    const unknown = keys.filter((k) => !found.has(k));
    if (unknown.length > 0) throw new AppError("PERMISSION_UNKNOWN", 400, "Unknown permission key(s)", { keys: unknown });
    return rows.map((r) => r.id);
  }

  /** The actor must hold every permission themselves: platform grants, plus grants for `orgId` when the grant is org-scoped. */
  private async assertActorHolds(actorId: string, keys: string[], orgId: string | null): Promise<void> {
    if (keys.length === 0) return;
    const eff = await this.permissions.effective(actorId);
    const held = new Set(eff.platform);
    if (orgId !== null) for (const k of eff.byOrg.get(orgId) ?? []) held.add(k);
    const missing = keys.filter((k) => !held.has(k));
    if (missing.length > 0) {
      throw new AppError("ROLE_ESCALATION_DENIED", 403, "You cannot manage a role that contains permissions you do not hold", { missing });
    }
  }

  private roleNotFound() {
    return new AppError("ROLE_NOT_FOUND", 404, "Role not found");
  }
}
