import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { RefundsService } from "./refunds.service";

export const REFUND_RESUME_JOB = "refunds.resume";
export const REFUND_RESUME_EVERY_MS = 5 * 60 * 1000;

/** Safety net: starts refunds that were approved but never reached Razorpay (an outage during approval, a crash between decision and call). */
@Injectable()
export class RefundsProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [REFUND_RESUME_JOB];
  private readonly logger = new Logger(RefundsProcessor.name);

  constructor(
    private readonly refunds: RefundsService,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(REFUND_RESUME_JOB, { every: REFUND_RESUME_EVERY_MS }, { name: REFUND_RESUME_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
  }

  async resumeStuck(): Promise<number> {
    return this.refunds.resumeStuck();
  }

  async process(_job: Job) {
    const started = await this.resumeStuck();
    if (started > 0) this.logger.log(`started ${started} stuck refund(s)`);
    return started;
  }
}
