import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
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
    // The OTP code is plaintext in the job data: drop the job as soon as it is done (or shortly after failing).
    const retention = template === "otp" ? { removeOnComplete: true, removeOnFail: { age: 3600 } } : {};
    await this.queue.add("send", job, { ...retention, ...(opts.idempotencyKey ? { jobId: `mail-${opts.idempotencyKey}` } : {}) });
  }
}
