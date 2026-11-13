import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { istWindow } from "../../common/clock/ist";
import { PrismaService } from "../../common/prisma/prisma.service";
import { toPage, type PageQuery } from "../../common/http/pagination";

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  requestId?: string;
}

export interface AuditFilter {
  targetType?: string;
  targetId?: string;
  actorId?: string;
  /** Exact action name, such as "user.suspend". */
  action?: string;
  /** Inclusive IST days, YYYY-MM-DD. */
  from?: string;
  to?: string;
}

const json = (value: unknown) => (value === undefined || value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue));

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Always called with the mutation's own transaction client, so the audit row commits or rolls back with the change. */
  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        before: json(entry.before),
        after: json(entry.after),
        ip: entry.ip ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }

  /** Newest first; ids are UUIDv7 so id order is time order. */
  async list(filter: AuditFilter, page: PageQuery) {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        targetType: filter.targetType,
        targetId: filter.targetId,
        actorId: filter.actorId,
        action: filter.action,
        ...(filter.from || filter.to ? { createdAt: istWindow(filter.from, filter.to) } : {}),
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return {
      items: items.map((r) => ({
        id: r.id,
        actorId: r.actorId,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        before: r.before,
        after: r.after,
        ip: r.ip,
        requestId: r.requestId,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }
}
