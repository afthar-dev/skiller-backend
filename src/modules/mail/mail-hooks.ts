import { Injectable, Logger } from "@nestjs/common";

/** Pointer from a queued mail back to whatever caused it (a campaign recipient), so the sender can be told what became of the mail. */
export interface MailRef {
  kind: string;
  key: string;
}

export type MailOutcome = { outcome: "sent"; resendId: string } | { outcome: "skipped"; reason: string } | { outcome: "failed"; reason: string };

export interface ResendEventNotice {
  /** Resend's event type, e.g. `email.delivered`. */
  type: string;
  /** The id Resend returned when the mail was accepted. */
  emailId: string;
}

type OutcomeHandler = (ref: MailRef, outcome: MailOutcome) => Promise<void>;
type EventHandler = (event: ResendEventNotice) => Promise<void>;

/**
 * How other modules learn what happened to mail they queued, without the mail module knowing them: a handler per ref kind hears the worker's outcome
 * (sent with Resend's id, skipped, failed for good), and event handlers hear every Resend webhook event that names a mail id. Handlers must be idempotent.
 */
@Injectable()
export class MailHooks {
  private readonly logger = new Logger(MailHooks.name);
  private readonly outcomes = new Map<string, OutcomeHandler>();
  private readonly events: EventHandler[] = [];

  onOutcome(kind: string, handler: OutcomeHandler): void {
    this.outcomes.set(kind, handler);
  }

  onEvent(handler: EventHandler): void {
    this.events.push(handler);
  }

  /** Never throws: the mail is already sent (or skipped); a failing listener must not retry the send. */
  async emitOutcome(ref: MailRef | undefined, outcome: MailOutcome): Promise<void> {
    const handler = ref ? this.outcomes.get(ref.kind) : undefined;
    if (!ref || !handler) return;
    try {
      await handler(ref, outcome);
    } catch (err) {
      this.logger.error(`mail outcome handler ${ref.kind} failed: ${(err as Error).message}`);
    }
  }

  async emitEvent(event: ResendEventNotice): Promise<void> {
    for (const handler of this.events) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error(`resend event handler failed: ${(err as Error).message}`);
      }
    }
  }
}
