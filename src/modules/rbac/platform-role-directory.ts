import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";

/**
 * Who holds a platform role. Small and dependency-light on purpose: the worker process (which has no RolesService) needs it to
 * find the finance admins to alert.
 */
@Injectable()
export class PlatformRoleDirectory {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Users holding the active role in one organization (e.g. every `org_owner`), by user id. */
  async userIdsWithRoleInOrg(roleKey: string, orgId: string, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<string[]> {
    const now = this.clock.now();
    const rows = await db.userRole.findMany({
      where: { orgId, role: { key: roleKey }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { userId: true },
      distinct: ["userId"],
    });
    return rows.map((r) => r.userId);
  }

  /** Active role keys the user holds in one organization (org-scoped grants only; platform grants are not included). */
  async roleKeysInOrg(userId: string, orgId: string, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<string[]> {
    const now = this.clock.now();
    const rows = await db.userRole.findMany({
      where: { userId, orgId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { role: { select: { key: true } } },
    });
    return [...new Set(rows.map((r) => r.role.key))];
  }

  /** Organizations in which the user holds at least one of the active roles (org-scoped grants only). */
  async orgIdsWithAnyRole(userId: string, roleKeys: readonly string[]): Promise<string[]> {
    const now = this.clock.now();
    const rows = await this.prisma.userRole.findMany({
      where: { userId, orgId: { not: null }, role: { key: { in: [...roleKeys] } }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { orgId: true },
      distinct: ["orgId"],
    });
    return rows.map((r) => r.orgId as string);
  }

  /** Users who hold a permission through an active platform-wide role (super_admin holds every key), at most `limit`. */
  async userIdsWithPermission(permissionKey: string, limit: number): Promise<string[]> {
    const now = this.clock.now();
    const rows = await this.prisma.userRole.findMany({
      where: { orgId: null, role: { rolePermissions: { some: { permission: { key: permissionKey } } } }, user: { status: "ACTIVE" }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { userId: true },
      distinct: ["userId"],
      orderBy: { userId: "asc" },
      take: limit,
    });
    return rows.map((r) => r.userId);
  }

  /** Users holding the active platform-wide role, newest first, strictly below `cursor`. */
  async userIdsWithRole(roleKey: string, cursor: string | undefined, take: number): Promise<string[]> {
    const now = this.clock.now();
    const rows = await this.prisma.userRole.findMany({
      where: { orgId: null, role: { key: roleKey }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], ...(cursor ? { userId: { lt: cursor } } : {}) },
      select: { userId: true },
      orderBy: { userId: "desc" },
      take,
    });
    return rows.map((r) => r.userId);
  }
}
