import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Job, UnrecoverableError } from "bullmq";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { MailHooks, type MailRef } from "./mail-hooks";
import type { MailCategory, MailData, MailTemplate } from "./mail.types";
import { MailDelivery } from "./mail-delivery";
import { ResendApiError } from "./resend.client";

export type MailJobData = {
  [T in MailTemplate]: { template: T; to: string; data: MailData[T]; category: MailCategory; ref?: MailRef };
}[MailTemplate];

@Injectable()
export class MailProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.mail;
  readonly jobNames = ["send"];
  private readonly logger = new Logger(MailProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: MailDelivery,
    private readonly registry: ProcessorRegistry,
    private readonly hooks: MailHooks,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async process(job: Job<MailJobData>): Promise<void> {
    const { template, category } = job.data;
    const to = job.data.to.trim().toLowerCase();

    const suppression = await this.prisma.emailSuppression.findUnique({ where: { email: to } });
    if (suppression) {
      // Transactional mail (OTP, invites) still goes out unless the address hard-bounced.
      const skip = category === "promotional" || suppression.reason === "bounced";
      if (skip) {
        this.logger.warn(`skipping ${template} mail: recipient suppressed (${suppression.reason})`);
        await this.hooks.emitOutcome(job.data.ref, { outcome: "skipped", reason: "suppressed" });
        return;
      }
    }

    try {
      const { id } = await this.delivery.deliver(template, to, job.data.data as never, { idempotencyKey: job.id ? `mail-${job.id}` : undefined });
      await this.hooks.emitOutcome(job.data.ref, { outcome: "sent", resendId: id });
    } catch (err) {
      // 4xx (except 429) will never succeed on retry; 5xx / 429 / network errors rethrow so BullMQ retries.
      if (err instanceof ResendApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        await this.hooks.emitOutcome(job.data.ref, { outcome: "failed", reason: `resend_${err.status}` });
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  /** Every attempt failed (a 5xx or 429 run that outlasted the retries): whoever queued the mail is told it did not go out. A permanent 4xx was reported when it happened. */
  async onExhausted(job: Job<MailJobData>, err: Error): Promise<void> {
    if (err instanceof UnrecoverableError) return;
    await this.hooks.emitOutcome(job.data.ref, { outcome: "failed", reason: "send_failed" });
  }
}
