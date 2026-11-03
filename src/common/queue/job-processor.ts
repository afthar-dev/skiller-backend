import type { Job } from "bullmq";
import type { QueueName } from "./queue.constants";

// Implement in any module and register via ProcessorRegistry; the worker process runs it.
export interface JobProcessor {
  readonly queue: QueueName;
  /** Only jobs with these names are routed here; omit to receive every job on the queue. */
  readonly jobNames?: readonly string[];
  /** Concurrency of the queue's Worker. Queues are dedicated per workload because BullMQ cannot filter by job name. */
  readonly concurrency?: number;
  process(job: Job): Promise<unknown>;
  /** Called once when a job of this processor has used all its attempts (the final failure). */
  onExhausted?(job: Job, err: Error): Promise<void>;
}
