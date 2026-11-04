import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { EnrolmentsService } from "./enrolments.service";

export const COURSE_SEATS_SWEEP_JOB = "courses.seats.sweep";
export const COURSE_SEATS_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

/** Daily: organization seats end when the learner grant behind them has expired (expiry emits no event). */
@Injectable()
export class CourseMaintenanceProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [COURSE_SEATS_SWEEP_JOB];
  private readonly logger = new Logger(CourseMaintenanceProcessor.name);

  constructor(
    private readonly enrolments: EnrolmentsService,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(COURSE_SEATS_SWEEP_JOB, { every: COURSE_SEATS_SWEEP_EVERY_MS }, { name: COURSE_SEATS_SWEEP_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
  }

  async process(): Promise<number> {
    return this.sweep();
  }

  async sweep(): Promise<number> {
    const revoked = await this.enrolments.sweepOrgSeats();
    if (revoked > 0) this.logger.log(`revoked ${revoked} organization seat(s) without a live learner role`);
    return revoked;
  }
}
