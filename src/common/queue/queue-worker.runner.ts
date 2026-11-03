import { Inject, Injectable, Logger } from "@nestjs/common";
import { Job, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { reportException } from "../observability/sentry";
import type { JobProcessor } from "./job-processor";
import { ProcessorRegistry } from "./processor-registry";
import { QUEUE_CONNECTION } from "./queue.constants";
import { backoffStrategy } from "./queue.options";

const matches = (p: JobProcessor, job: Job) => !p.jobNames || p.jobNames.includes(job.name);

// Starts one BullMQ Worker per queue that has registered processors, at that queue's concurrency (queues are dedicated
// per workload: BullMQ cannot filter by job name, so a slow job type needs its own queue).
// Only the worker process calls start(); the API process never does.
@Injectable()
export class QueueWorkerRunner {
  private readonly logger = new Logger(QueueWorkerRunner.name);
  private workers: Worker[] = [];

  constructor(
    private readonly registry: ProcessorRegistry,
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
  ) {}

  /** Names of the queues that have a running Worker. */
  get startedQueues(): string[] {
    return this.workers.map((w) => w.name);
  }

  async start() {
    for (const queue of this.registry.queues()) {
      const processors = this.registry.for(queue);
      const concurrency = Math.max(...processors.map((p) => p.concurrency ?? 1));
      const worker = new Worker(
        queue,
        async (job: Job) => {
          const targets = processors.filter((p) => matches(p, job));
          if (targets.length === 0) this.logger.warn(`job ${job.id} (${job.name}) on ${queue} matched no processor and was dropped`);
          for (const p of targets) await p.process(job);
        },
        { connection: this.connection, concurrency, settings: { backoffStrategy } },
      );
      worker.on("failed", (job, err) => {
        this.logger.warn(`job ${job?.id} on ${queue} failed (attempt ${job?.attemptsMade}): ${err.message}`);
        if (job && (job.attemptsMade >= (job.opts.attempts ?? 1) || err instanceof UnrecoverableError)) void this.exhausted(queue, processors, job, err);
      });
      worker.on("error", (err) => this.logger.error(`worker ${queue}: ${err.message}`));
      this.workers.push(worker);
    }
    await Promise.all(this.workers.map((w) => w.waitUntilReady()));
    this.logger.log(`workers started: ${this.registry.queues().join(", ") || "(none)"}`);
  }

  private async exhausted(queue: string, processors: JobProcessor[], job: Job, err: Error) {
    this.logger.error(`job ${job.id} (${job.name}) on ${queue} gave up after ${job.attemptsMade} attempts: ${err.message}`);
    // Sentry is a no-op unless a DSN is configured.
    reportException(err, 500);
    for (const p of processors.filter((x) => matches(x, job))) {
      try {
        await p.onExhausted?.(job, err);
      } catch (hookErr) {
        this.logger.error(`onExhausted for job ${job.id} failed: ${(hookErr as Error).message}`);
        reportException(hookErr, 500);
      }
    }
  }

  async stop() {
    await Promise.all(this.workers.map((w) => w.close()));
    this.workers = [];
  }
}
