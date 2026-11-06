import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { RollupService } from "./rollup.service";

export const ANALYTICS_ROLLUP_JOB = "analytics.rollup";
export const ANALYTICS_REBUILD_JOB = "analytics.rebuild";
/** 03:00 India time, every day (a cron in the Asia/Kolkata zone: India has no daylight saving). */
export const ANALYTICS_ROLLUP_CRON = { pattern: "0 3 * * *", tz: "Asia/Kolkata" } as const;

export interface RebuildJobData {
  from: string;
  to: string;
}

/** Nightly: rolls up yesterday (IST). On demand (admin rebuild): rolls up a range of days. Both are idempotent, so a retry or a double run changes nothing. */
@Injectable()
export class RollupProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [ANALYTICS_ROLLUP_JOB, ANALYTICS_REBUILD_JOB];
  private readonly logger = new Logger(RollupProcessor.name);

  constructor(
    private readonly rollup: RollupService,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(
      ANALYTICS_ROLLUP_JOB,
      { ...ANALYTICS_ROLLUP_CRON },
      { name: ANALYTICS_ROLLUP_JOB, opts: { attempts: 3, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: true, removeOnFail: true } },
    );
  }

  async process(job: Job): Promise<void> {
    if (job.name === ANALYTICS_REBUILD_JOB) {
      const { from, to } = job.data as RebuildJobData;
      const { days } = await this.rollup.rebuild(from, to);
      this.logger.log(`rebuilt ${days} day(s), ${from}..${to}`);
      return;
    }
    const day = this.rollup.yesterday();
    const keys = await this.rollup.rollupDay(day);
    this.logger.log(`rolled up ${day}: ${keys} metric(s)`);
  }
}
