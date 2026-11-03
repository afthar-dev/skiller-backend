import type { Job } from "bullmq";
import type { QueueName } from "./queue.constants";

// Implement in any module and register via ProcessorRegistry; the worker process runs it.
export interface JobProcessor {
  readonly queue: QueueName;
  /** Only jobs with these names are routed here; omit to receive every job on the queue. */
  readonly jobNames?: readonly string[];
  readonly concurrency?: number;
  process(job: Job): Promise<unknown>;
}
