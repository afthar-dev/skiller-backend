import { Injectable } from "@nestjs/common";
import type { JobProcessor } from "./job-processor";
import type { QueueName } from "./queue.constants";

@Injectable()
export class ProcessorRegistry {
  private readonly processors = new Map<QueueName, JobProcessor[]>();

  register(processor: JobProcessor) {
    const list = this.processors.get(processor.queue) ?? [];
    if (!list.includes(processor)) list.push(processor);
    this.processors.set(processor.queue, list);
  }

  queues(): QueueName[] {
    return [...this.processors.keys()];
  }

  for(queue: QueueName): JobProcessor[] {
    return this.processors.get(queue) ?? [];
  }
}
