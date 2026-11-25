import type { Job } from "bullmq";
import type { QueueName } from "./queue.constants";

// Implement in any module and register via ProcessorRegistry; the worker process runs it.
export interface JobProcessor {
  readonly queue: QueueName;
  /** Only jobs with these names are routed here; omit to receive every job on the queue. */
  readonly jobNames?: readonly string[];
  /** Concurrency of the queue's Worker. Queues are dedicated per workload because BullMQ cannot filter by job name. */
  readonly concurrency?: number;
  /**
   * How many times a job of this queue may stall (its worker died or lost the lock) and be re-queued before BullMQ fails it. BullMQ's default is 1, which
   * is too low for jobs that outlive a deploy (a long transcode). The queue uses the highest value among its processors.
   */
  readonly maxStalledCount?: number;
  /**
   * Rate limit of the queue's Worker (at most `max` jobs per `duration` ms, across all concurrent jobs of this process). Read when the worker starts and again
   * every minute, so a setting can change it without a restart. Omit for no limit.
   */
  limiter?(): Promise<{ max: number; duration: number }>;
  process(job: Job): Promise<unknown>;
  /** Called once when a job of this processor has used all its attempts (the final failure). */
  onExhausted?(job: Job, err: Error): Promise<void>;
}
