import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { SubscriptionsService } from "./subscriptions.service";

export const SUBSCRIPTION_MAINTENANCE_JOB = "subscriptions.maintain";
export const SUBSCRIPTION_MAINTENANCE_EVERY_MS = 15 * 60 * 1000;

/** Grace expiry (PAST_DUE -> EXPIRED -> Free), period-end cancellations and booked downgrades. */
@Injectable()
export class SubscriptionMaintenanceProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [SUBSCRIPTION_MAINTENANCE_JOB];
  private readonly logger = new Logger(SubscriptionMaintenanceProcessor.name);

  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(
      SUBSCRIPTION_MAINTENANCE_JOB,
      { every: SUBSCRIPTION_MAINTENANCE_EVERY_MS },
      { name: SUBSCRIPTION_MAINTENANCE_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } },
    );
  }

  async process(_job: Job) {
    const result = await this.subscriptions.runMaintenance();
    if (result.expired || result.downgraded || result.abandoned) this.logger.log(`subscription maintenance: ${JSON.stringify(result)}`);
    return result;
  }
}
