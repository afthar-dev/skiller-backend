import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { CampaignSender } from "./campaign-sender";

export const CAMPAIGN_TICK_JOB = "growth.campaigns.tick";
export const CAMPAIGN_TICK_EVERY_MS = 30 * 1000;

/** Every 30 seconds: start campaigns that are due and send the next batches of the ones running. An overlap is safe (claims are SKIP LOCKED, starts hold an advisory lock). */
@Injectable()
export class CampaignProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [CAMPAIGN_TICK_JOB];
  private readonly logger = new Logger(CampaignProcessor.name);

  constructor(
    private readonly sender: CampaignSender,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(CAMPAIGN_TICK_JOB, { every: CAMPAIGN_TICK_EVERY_MS }, { name: CAMPAIGN_TICK_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
  }

  async process(_job: Job): Promise<void> {
    try {
      await this.sender.tick();
    } catch (err) {
      this.logger.error(`campaign tick failed (claimed recipients are retried when their claim goes stale): ${(err as Error).message}`);
      throw err;
    }
  }
}
