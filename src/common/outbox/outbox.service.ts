import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { toPage, type PageQuery } from "../http/pagination";
import { PrismaService } from "../prisma/prisma.service";
import type { DomainEvent } from "./events";

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  /** Writes the event inside the caller's transaction; it is relayed only if that transaction commits. */
  async enqueue(tx: Prisma.TransactionClient, event: DomainEvent): Promise<void> {
    const { type, ...payload } = event;
    await tx.outboxEvent.create({ data: { type, payload: payload as Prisma.InputJsonObject } });
  }

  /** Events whose delivery was given up after every attempt failed. Newest first (ids are UUIDv7, so id order is time order). */
  async listDead(page: PageQuery) {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { deadAt: { not: null }, ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return {
      items: items.map((r) => ({
        id: r.id,
        type: r.type,
        payload: r.payload,
        attempts: r.attempts,
        lastError: r.lastError,
        createdAt: r.createdAt.toISOString(),
        deadAt: r.deadAt!.toISOString(),
      })),
      nextCursor,
    };
  }
}
