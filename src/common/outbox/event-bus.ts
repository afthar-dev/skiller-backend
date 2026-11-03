import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { DomainEvent, DomainEventType, EventOf } from "./events";

/** Delivery metadata. `eventId` is the outbox event id: stable across redeliveries, so handlers derive dedupe keys from it. */
export interface EventMeta {
  eventId: string;
}

type Handler<T extends DomainEventType> = (e: EventOf<T>, meta: EventMeta) => Promise<void>;

// Process-local registry. Any module (including worker-side ones) calls `on` in onModuleInit;
// the outbox processor calls `dispatch` for each delivered event. Handlers must be idempotent:
// if one handler fails the whole event is retried by BullMQ and all handlers run again.
@Injectable()
export class EventBus {
  private readonly handlers = new Map<DomainEventType, Handler<DomainEventType>[]>();

  on<T extends DomainEventType>(type: T, handler: Handler<T>): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as unknown as Handler<DomainEventType>);
    this.handlers.set(type, list);
  }

  /** Without an explicit `eventId` (direct dispatch in tests) the id is a content hash, so re-dispatching the same event is still a redelivery. */
  async dispatch(event: DomainEvent, eventId?: string): Promise<void> {
    const meta: EventMeta = { eventId: eventId ?? createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 32) };
    for (const handler of this.handlers.get(event.type) ?? []) {
      await (handler as (e: DomainEvent, m: EventMeta) => Promise<void>)(event, meta);
    }
  }
}
