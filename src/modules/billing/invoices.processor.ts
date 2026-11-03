import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { CreditNoteIssuer } from "./credit-note-issuer";
import { InvoiceIssuer } from "./invoice-issuer";

export const INVOICE_SWEEP_JOB = "invoices.complete";
export const INVOICE_SWEEP_EVERY_MS = 10 * 60 * 1000;
/** An invoice younger than this may still be mid-upload in the handler that issued it. */
export const INVOICE_SWEEP_MIN_AGE_MS = 5 * 60 * 1000;

/**
 * Safety net for invoices: numbering and the PDF upload are separate steps (a number is only ever consumed together with its row), so
 * an invoice can exist without its file when storage was down. The outbox retry usually finishes it; this finishes any that remain.
 */
@Injectable()
export class InvoicesProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [INVOICE_SWEEP_JOB];
  private readonly logger = new Logger(InvoicesProcessor.name);

  constructor(
    private readonly issuer: InvoiceIssuer,
    private readonly creditNotes: CreditNoteIssuer,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(INVOICE_SWEEP_JOB, { every: INVOICE_SWEEP_EVERY_MS }, { name: INVOICE_SWEEP_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
  }

  async process(_job: Job) {
    const done = (await this.issuer.completePending(INVOICE_SWEEP_MIN_AGE_MS)) + (await this.creditNotes.completePending(INVOICE_SWEEP_MIN_AGE_MS));
    if (done > 0) this.logger.log(`uploaded ${done} pending invoice / credit note PDF(s)`);
    return done;
  }
}
