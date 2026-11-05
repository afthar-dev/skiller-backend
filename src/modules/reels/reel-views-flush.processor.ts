import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { ReelViewFlusher } from "./reel-view-flusher";

export const REEL_VIEWS_FLUSH_JOB = "reels.views.flush";
export const REEL_VIEWS_FLUSH_EVERY_MS = 60 * 1000;

/** Every minute: view counts go from Redis to Postgres. A light job on the maintenance queue; an overlap is safe (the batch is taken with an atomic rename). */
@Injectable()
export class ReelViewsFlushProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [REEL_VIEWS_FLUSH_JOB];
  private readonly logger = new Logger(ReelViewsFlushProcessor.name);

  constructor(
    private readonly flusher: ReelViewFlusher,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(REEL_VIEWS_FLUSH_JOB, { every: REEL_VIEWS_FLUSH_EVERY_MS }, { name: REEL_VIEWS_FLUSH_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
  }

  async process(_job: Job): Promise<number> {
    try {
      return (await this.flusher.flush()).batches;
    } catch (err) {
      this.logger.error(`view flush failed (the batch stays in Redis and is retried): ${(err as Error).message}`);
      throw err;
    }
  }
}
