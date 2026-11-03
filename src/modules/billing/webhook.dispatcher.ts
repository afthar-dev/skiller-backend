import { Injectable } from "@nestjs/common";
import type { WebhookProvider } from "@prisma/client";

export interface WebhookEventContext {
  /** WebhookEvent row id: stable across retries, usable as a dedupe key. */
  webhookEventId: string;
  provider: WebhookProvider;
  /** The provider's own event id (x-razorpay-event-id). */
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
}

export type WebhookHandler = (event: WebhookEventContext) => Promise<void>;

/**
 * Registry of handlers per webhook event type (e.g. "payment.captured"). Modules register in onModuleInit; the processor
 * calls dispatch(). Delivery is at-least-once, so handlers must be idempotent. A type nobody handles is not an error.
 */
@Injectable()
export class WebhookDispatcher {
  private readonly handlers = new Map<string, WebhookHandler[]>();

  on(type: string, handler: WebhookHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  registeredTypes(): string[] {
    return [...this.handlers.keys()];
  }

  /** Runs every handler for the type in registration order; the first failure aborts (the whole event is retried). Returns how many ran. */
  async dispatch(event: WebhookEventContext): Promise<number> {
    const list = this.handlers.get(event.type) ?? [];
    for (const handler of list) await handler(event);
    return list.length;
  }
}
