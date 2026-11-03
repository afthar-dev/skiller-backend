import { Inject, Injectable, Logger } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { ProcessorRegistry } from "./processor-registry";
import { QUEUE_CONNECTION } from "./queue.constants";

// Starts one BullMQ Worker per queue that has registered processors.
// Only the worker process calls start(); the API process never does.
@Injectable()
export class QueueWorkerRunner {
  private readonly logger = new Logger(QueueWorkerRunner.name);
  private workers: Worker[] = [];

  constructor(
    private readonly registry: ProcessorRegistry,
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
  ) {}

  async start() {
    for (const queue of this.registry.queues()) {
      const processors = this.registry.for(queue);
      const concurrency = Math.max(...processors.map((p) => p.concurrency ?? 1));
      const worker = new Worker(
        queue,
        async (job: Job) => {
          for (const p of processors) await p.process(job);
        },
        { connection: this.connection, concurrency },
      );
      worker.on("failed", (job, err) => this.logger.warn(`job ${job?.id} on ${queue} failed (attempt ${job?.attemptsMade}): ${err.message}`));
      worker.on("error", (err) => this.logger.error(`worker ${queue}: ${err.message}`));
      this.workers.push(worker);
    }
    await Promise.all(this.workers.map((w) => w.waitUntilReady()));
    this.logger.log(`workers started: ${this.registry.queues().join(", ") || "(none)"}`);
  }

  async stop() {
    await Promise.all(this.workers.map((w) => w.close()));
    this.workers = [];
  }
}
