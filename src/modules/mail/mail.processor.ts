import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Job, UnrecoverableError } from "bullmq";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import type { MailCategory, MailData, MailTemplate } from "./mail.types";
import { RESEND_CLIENT, ResendApiError, type ResendClient } from "./resend.client";
import { renderMail } from "./templates";

export type MailJobData = {
  [T in MailTemplate]: { template: T; to: string; data: MailData[T]; category: MailCategory };
}[MailTemplate];

@Injectable()
export class MailProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.mail;
  readonly jobNames = ["send"];
  private readonly logger = new Logger(MailProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RESEND_CLIENT) private readonly client: ResendClient,
    private readonly registry: ProcessorRegistry,
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
        return;
      }
    }

    const { subject, html, text } = await renderMail(template, job.data.data as never);
    try {
      await this.client.send({ to, subject, html, text, idempotencyKey: job.id ? `mail-${job.id}` : undefined });
    } catch (err) {
      // 4xx (except 429) will never succeed on retry; 5xx / 429 / network errors rethrow so BullMQ retries.
      if (err instanceof ResendApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }
}
