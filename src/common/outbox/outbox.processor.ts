import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Job } from "bullmq";
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

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly bus: EventBus,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async process(job: Job<OutboxJobData>) {
    const { type, payload } = job.data;
    await this.bus.dispatch({ type, ...payload } as DomainEvent);
  }
}
