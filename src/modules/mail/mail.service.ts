import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { v7 as uuidv7 } from "uuid";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { QueueNames } from "../../common/queue/queue.constants";
import type { MailRef } from "./mail-hooks";
import type { MailJobData } from "./mail.processor";
import type { MailCategory, MailData, MailTemplate } from "./mail.types";

export interface MailSendOptions {
  category?: MailCategory;
  /**
   * Stable key for one logical mail (e.g. derived from an outbox event id). It becomes the BullMQ jobId, so a duplicate add is a
   * no-op while the job exists, and through the job id Resend's Idempotency-Key, so a later retry cannot double-send either.
   * Must not contain ":" (BullMQ restriction).
   */
  idempotencyKey?: string;
  /** Pointer back to whatever queued the mail; the worker reports the outcome (sent with Resend's id, skipped, failed) to the handler registered for its kind (MailHooks). */
  ref?: MailRef;
}

@Injectable()
export class MailService {
  constructor(@InjectQueue(QueueNames.mail) private readonly queue: Queue) {}

  /** Enqueues only; the worker renders and calls Resend. */
  async send<T extends MailTemplate>(template: T, to: string, data: MailData[T], opts: MailSendOptions = {}): Promise<void> {
    const job: MailJobData = { template, to, data, category: opts.category ?? "transactional", ...(opts.ref ? { ref: opts.ref } : {}) } as MailJobData;
    // Every mail has a globally unique job id (the worker derives Resend's Idempotency-Key from it). BullMQ's own counter restarts after a
    // Redis flush while Resend remembers keys for 24 h, which made a later mail (a second sign-in code) look like a duplicate and vanish.
    // The OTP code is plaintext in the job data: drop the job as soon as it is done (or shortly after failing).
    const retention = template === "otp" ? { removeOnComplete: true, removeOnFail: { age: 3600 } } : {};
    await this.queue.add("send", job, { ...retention, jobId: `mail-${opts.idempotencyKey ?? uuidv7()}` });
  }
}
