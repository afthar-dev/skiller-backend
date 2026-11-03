import { Inject, Injectable } from "@nestjs/common";
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
