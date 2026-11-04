import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { CLOCK, type Clock } from "../../common/clock/clock";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { previousIstDay } from "./ist";
import { ReconciliationService } from "./reconciliation.service";

export const RECONCILIATION_JOB = "reconciliation.nightly";
/** 02:00 every day, India time. */
export const RECONCILIATION_CRON = "0 2 * * *";
export const RECONCILIATION_TZ = "Asia/Kolkata";

/** Reconciles the previous IST day once a night. The service records failures itself (status ERROR + a finance alert), so the job never needs a retry. */
@Injectable()
export class ReconciliationProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [RECONCILIATION_JOB];

  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly registry: ProcessorRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(RECONCILIATION_JOB, { pattern: RECONCILIATION_CRON, tz: RECONCILIATION_TZ }, { name: RECONCILIATION_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
  }

  async process(_job: Job) {
    const run = await this.reconciliation.run(previousIstDay(this.clock.now()));
    return { id: run.id, date: run.date, status: run.status };
  }
}
