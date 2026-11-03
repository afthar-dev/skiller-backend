import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { DomainEvent } from "./events";

@Injectable()
export class OutboxService {
  /** Writes the event inside the caller's transaction; it is relayed only if that transaction commits. */
  async enqueue(tx: Prisma.TransactionClient, event: DomainEvent): Promise<void> {
    const { type, ...payload } = event;
    await tx.outboxEvent.create({ data: { type, payload: payload as Prisma.InputJsonObject } });
  }
}
