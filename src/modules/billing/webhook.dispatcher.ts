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
  private readonly exhaustedHandlers = new Map<string, ((event: WebhookEventContext, err: Error) => Promise<void>)[]>();

  on(type: string, handler: WebhookHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /** Called when the job for an event of this type has used all its attempts, so the owner can alert a human. */
  onExhausted(type: string, handler: (event: WebhookEventContext, err: Error) => Promise<void>): void {
    const list = this.exhaustedHandlers.get(type) ?? [];
    list.push(handler);
    this.exhaustedHandlers.set(type, list);
  }

  /** Never throws: it runs while a job is already failing. */
  async exhausted(event: WebhookEventContext, err: Error): Promise<void> {
    for (const handler of this.exhaustedHandlers.get(event.type) ?? []) await handler(event, err).catch(() => undefined);
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
