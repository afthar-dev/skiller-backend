import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { HashtagTrending } from "./hashtag-trending";

export const HASHTAG_TRENDING_JOB = "reels.hashtags.trending";
export const HASHTAG_TRENDING_EVERY_MS = 60 * 60 * 1000;

/** Hourly: recompute the trending hashtags into Redis. One light query on the maintenance queue; running twice is harmless. */
@Injectable()
export class HashtagTrendingProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [HASHTAG_TRENDING_JOB];
  private readonly logger = new Logger(HashtagTrendingProcessor.name);

  constructor(
    private readonly trending: HashtagTrending,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(HASHTAG_TRENDING_JOB, { every: HASHTAG_TRENDING_EVERY_MS }, { name: HASHTAG_TRENDING_JOB, opts: { attempts: 2, removeOnComplete: true, removeOnFail: true } });
  }

  async process(_job: Job): Promise<number> {
    try {
      return (await this.trending.refresh()).items.length;
    } catch (err) {
      this.logger.error(`trending hashtags refresh failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
