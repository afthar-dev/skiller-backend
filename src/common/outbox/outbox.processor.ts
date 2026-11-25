import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Job } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import type { JobProcessor } from "../queue/job-processor";
import { ProcessorRegistry } from "../queue/processor-registry";
import { QueueNames } from "../queue/queue.constants";
import { EventBus } from "./event-bus";
import type { DomainEvent } from "./events";

export const OUTBOX_EVENT_JOB = "event";

export interface OutboxJobData {
  id: string;
  type: DomainEvent["type"];
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.outbox;
  readonly jobNames = [OUTBOX_EVENT_JOB];
  readonly concurrency = 5; // handlers are I/O bound; the relay (safe to run concurrently: SKIP LOCKED) shares this queue

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async process(job: Job<OutboxJobData>) {
    const { type, payload } = job.data;
    await this.bus.dispatch({ type, ...payload } as DomainEvent, job.data.id);
  }

  /** Every attempt failed: flag the row so it shows up in /admin/outbox/dead (the failed job itself is kept in Redis; `pnpm jobs:replay outbox` retries it). */
  async onExhausted(job: Job<OutboxJobData>, err: Error): Promise<void> {
    await this.prisma.outboxEvent.updateMany({ where: { id: job.data.id }, data: { deadAt: new Date(), lastError: err.message.slice(0, 2000) } });
  }
}
