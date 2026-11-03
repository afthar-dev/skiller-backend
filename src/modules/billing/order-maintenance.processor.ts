import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { IdempotencyCleanup } from "../../common/idempotency";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { OrdersService } from "./orders.service";

export const ORDER_EXPIRY_JOB = "orders.expire";
export const IDEMPOTENCY_CLEANUP_JOB = "idempotency.cleanup";
export const ORDER_EXPIRY_EVERY_MS = 15 * 60 * 1000;
export const IDEMPOTENCY_CLEANUP_EVERY_MS = 60 * 60 * 1000;

/** Housekeeping for checkout: unpaid orders expire after 24 h, idempotency records are purged after 24 h. */
@Injectable()
export class OrderMaintenanceProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [ORDER_EXPIRY_JOB, IDEMPOTENCY_CLEANUP_JOB];
  private readonly logger = new Logger(OrderMaintenanceProcessor.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyCleanup,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    const opts = { attempts: 1, removeOnComplete: true, removeOnFail: true };
    await this.maintenanceQueue.upsertJobScheduler(ORDER_EXPIRY_JOB, { every: ORDER_EXPIRY_EVERY_MS }, { name: ORDER_EXPIRY_JOB, opts });
    await this.maintenanceQueue.upsertJobScheduler(IDEMPOTENCY_CLEANUP_JOB, { every: IDEMPOTENCY_CLEANUP_EVERY_MS }, { name: IDEMPOTENCY_CLEANUP_JOB, opts });
  }

  async process(job: Job) {
    if (job.name === IDEMPOTENCY_CLEANUP_JOB) {
      const purged = await this.idempotency.purge();
      if (purged) this.logger.log(`purged ${purged} idempotency record(s)`);
      return purged;
    }
    return this.orders.expireStale();
  }
}
