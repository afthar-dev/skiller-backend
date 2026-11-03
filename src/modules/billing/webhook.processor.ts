import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { Job, UnrecoverableError } from "bullmq";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { WebhookDispatcher } from "./webhook.dispatcher";

export const WEBHOOK_PROCESS_JOB = "webhook.process";

export interface WebhookJobData {
  webhookEventId: string;
}

const truncate = (message: string) => message.slice(0, 2000);

/**
 * Runs the stored webhook through the dispatcher. Retried with the outbox's schedule (15 attempts, capped exponential backoff).
 * When every attempt has failed the queue worker reports the error to Sentry and calls onExhausted; the failed job is kept
 * in Redis for replay and the row keeps processedAt = null with the final error.
 */
@Injectable()
export class WebhookProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.billing;
  readonly jobNames = [WEBHOOK_PROCESS_JOB];
  readonly concurrency = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: WebhookDispatcher,
    private readonly registry: ProcessorRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async process(job: Job<WebhookJobData>): Promise<void> {
    const row = await this.prisma.webhookEvent.findUnique({ where: { id: job.data.webhookEventId } });
    if (!row) throw new UnrecoverableError(`webhook event ${job.data.webhookEventId} not found`);
    if (row.processedAt) return; // redelivered job for an event that already completed

    await this.prisma.webhookEvent.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    try {
      await this.dispatcher.dispatch({
        webhookEventId: row.id,
        provider: row.provider,
        eventId: row.eventId,
        type: row.type,
        payload: row.payload as Record<string, unknown>,
      });
    } catch (err) {
      await this.prisma.webhookEvent.update({ where: { id: row.id }, data: { lastError: truncate((err as Error).message) } });
      throw err;
    }
    await this.prisma.webhookEvent.update({ where: { id: row.id }, data: { processedAt: this.clock.now(), lastError: null } });
  }

  async onExhausted(job: Job<WebhookJobData>, err: Error): Promise<void> {
    await this.prisma.webhookEvent.updateMany({ where: { id: job.data.webhookEventId, processedAt: null }, data: { lastError: truncate(err.message) } });
    const row = await this.prisma.webhookEvent.findUnique({ where: { id: job.data.webhookEventId } });
    if (row) await this.dispatcher.exhausted({ webhookEventId: row.id, provider: row.provider, eventId: row.eventId, type: row.type, payload: row.payload as Record<string, unknown> }, err);
  }
}
