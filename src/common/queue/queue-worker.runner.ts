import { Inject, Injectable, Logger } from "@nestjs/common";
import { DelayedError, Job, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { reportException } from "../observability/sentry";
import type { JobProcessor } from "./job-processor";
import { ProcessorRegistry } from "./processor-registry";
import { QUEUE_CONNECTION, type QueueName } from "./queue.constants";
import { backoffStrategy } from "./queue.options";

const LIMITER_REFRESH_MS = 60_000;
const matches = (p: JobProcessor, job: Job) => !p.jobNames || p.jobNames.includes(job.name);

/** A job no processor here knows (a newer API queued a new job name before this worker was replaced) goes back to the queue this long later. */
export const UNKNOWN_JOB_RETRY_MS = 60_000;
/** ...until it is this old: then it is a real mistake (a typo, a removed job) and fails loudly instead of cycling for ever. */
export const UNKNOWN_JOB_GIVE_UP_MS = 6 * 60 * 60 * 1000;
const STALLED_MESSAGE = "stalled more than allowable limit";
/** BullMQ fails a job whose worker died too often without running the processor's catch, and without an exhausted attempt count. */
const isStalledFailure = (err: Error) => err.message.includes(STALLED_MESSAGE);

// Starts one BullMQ Worker per queue that has registered processors, at that queue's concurrency (queues are dedicated
// per workload: BullMQ cannot filter by job name, so a slow job type needs its own queue).
// Only the worker process calls start(); the API process never does.
@Injectable()
export class QueueWorkerRunner {
  private readonly logger = new Logger(QueueWorkerRunner.name);
  private workers: Worker[] = [];
  private limiterTimer?: NodeJS.Timeout;

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
      const maxStalledCount = Math.max(0, ...processors.map((p) => p.maxStalledCount ?? 0));
      const limiter = await this.limiterFor(queue);
      const worker = new Worker(
        queue,
        async (job: Job, token?: string) => {
          const targets = processors.filter((p) => matches(p, job));
          if (targets.length === 0) return this.deferUnknown(queue, job, token);
          for (const p of targets) await p.process(job);
        },
        { connection: this.connection, concurrency, settings: { backoffStrategy }, ...(maxStalledCount > 0 ? { maxStalledCount } : {}), ...(limiter ? { limiter } : {}) },
      );
      worker.on("failed", (job, err) => {
        this.logger.warn(`job ${job?.id} on ${queue} failed (attempt ${job?.attemptsMade}): ${err.message}`);
        if (job && (job.attemptsMade >= (job.opts.attempts ?? 1) || err instanceof UnrecoverableError || isStalledFailure(err))) void this.exhausted(queue, processors, job, err);
      });
      worker.on("error", (err) => this.logger.error(`worker ${queue}: ${err.message}`));
      this.workers.push(worker);
    }
    await Promise.all(this.workers.map((w) => w.waitUntilReady()));
    if (this.registry.queues().some((q) => this.registry.for(q).some((p) => p.limiter))) {
      this.limiterTimer = setInterval(() => void this.refreshLimiters(), LIMITER_REFRESH_MS);
      this.limiterTimer.unref();
    }
    this.logger.log(`workers started: ${this.registry.queues().join(", ") || "(none)"}`);
  }

  /**
   * Never completes a job nobody can run (that would lose it): it is put back as delayed, without using up an attempt, so a worker that knows the name
   * (the one from the new release) picks it up. After UNKNOWN_JOB_GIVE_UP_MS it fails instead.
   */
  private async deferUnknown(queue: string, job: Job, token?: string): Promise<never> {
    if (Date.now() - job.timestamp > UNKNOWN_JOB_GIVE_UP_MS) throw new Error(`no processor for job ${job.name} on ${queue}`);
    this.logger.warn(`job ${job.id} (${job.name}) on ${queue} matched no processor; delaying it for a worker that knows it`);
    await job.moveToDelayed(Date.now() + UNKNOWN_JOB_RETRY_MS, token);
    throw new DelayedError();
  }

  /** Reads every processor's limiter again and applies it to the running Workers (a setting changed). A failing read keeps the old limit. */
  async refreshLimiters(): Promise<void> {
    for (const worker of this.workers) {
      try {
        const limiter = await this.limiterFor(worker.name);
        if (limiter) worker.opts.limiter = limiter;
      } catch (err) {
        this.logger.warn(`could not refresh the rate limit of ${worker.name}: ${(err as Error).message}`);
      }
    }
  }

  private async limiterFor(queue: string): Promise<{ max: number; duration: number } | undefined> {
    for (const p of this.registry.for(queue as QueueName)) if (p.limiter) return p.limiter();
    return undefined;
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
    if (this.limiterTimer) clearInterval(this.limiterTimer);
    this.limiterTimer = undefined;
    await Promise.all(this.workers.map((w) => w.close()));
    this.workers = [];
  }
}
