import { Injectable } from "@nestjs/common";
import type { DomainEvent, DomainEventType, EventOf } from "./events";

type Handler<T extends DomainEventType> = (e: EventOf<T>) => Promise<void>;

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

  async dispatch(event: DomainEvent): Promise<void> {
    for (const handler of this.handlers.get(event.type) ?? []) {
      await (handler as (e: DomainEvent) => Promise<void>)(event);
    }
  }
}
