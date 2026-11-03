import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { FinanceAlerts } from "./finance-alerts.service";
import { PAYOUT_SEND_JOB, PayoutsService } from "./payouts.service";

export const PAYOUTS_REDRIVE_JOB = "payouts.redrive";
export const PAYOUTS_REDRIVE_EVERY_MS = 5 * 60 * 1000;

interface SendJobData {
  payoutId: string;
}

/** Sends an approved payout to RazorpayX. One job per payout (jobId = payout id); a retry looks the payout up at RazorpayX first. */
@Injectable()
export class PayoutSendProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.billing;
  readonly jobNames = [PAYOUT_SEND_JOB];
  readonly concurrency = 5;

  constructor(
    private readonly payouts: PayoutsService,
    private readonly alerts: FinanceAlerts,
    private readonly registry: ProcessorRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async process(job: Job<SendJobData>) {
    await this.payouts.send(job.data.payoutId, { recover: job.attemptsMade > 0 });
  }

  /** Every attempt failed: the payout is still APPROVED (the maintenance job keeps retrying it), but finance should know. */
  async onExhausted(job: Job<SendJobData>, err: Error): Promise<void> {
    await this.alerts.raise({
      kind: "PAYOUT_FAILED",
      message: `Sending payout ${job.data.payoutId} to RazorpayX keeps failing (${err.message}). It stays approved and is retried every few minutes.`,
      dedupeKey: `payout-send:${job.data.payoutId}`,
      link: "/admin/payouts",
      data: { payoutId: job.data.payoutId },
    });
  }
}

/** Safety net: re-drives approved payouts that never reached RazorpayX (an outage during approval, a crash between decision and call). */
@Injectable()
export class PayoutMaintenanceProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [PAYOUTS_REDRIVE_JOB];
  private readonly logger = new Logger(PayoutMaintenanceProcessor.name);

  constructor(
    private readonly payouts: PayoutsService,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(PAYOUTS_REDRIVE_JOB, { every: PAYOUTS_REDRIVE_EVERY_MS }, { name: PAYOUTS_REDRIVE_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
  }

  async redrive(): Promise<number> {
    return this.payouts.redriveStuck();
  }

  async process(_job: Job) {
    const started = await this.redrive();
    if (started > 0) this.logger.log(`started ${started} stuck payout(s)`);
    return started;
  }
}
