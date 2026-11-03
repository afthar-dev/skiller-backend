import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import type { JobProcessor } from "../queue/job-processor";
import { ProcessorRegistry } from "../queue/processor-registry";
import { InjectQueue } from "../queue/queue.decorators";
import { QueueNames } from "../queue/queue.constants";
import { OUTBOX_EVENT_JOB, OutboxJobData } from "./outbox.processor";

const BATCH_SIZE = 100;
export const OUTBOX_RELAY_JOB = "outbox-relay";

interface Row {
  id: string;
  type: OutboxJobData["type"];
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxRelay implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.outbox;
  readonly jobNames = [OUTBOX_RELAY_JOB];

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProcessorRegistry,
    @InjectQueue(QueueNames.outbox) private readonly outboxQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process: schedules the relay every second on the outbox queue, away from slow maintenance jobs. */
  async schedule() {
    await this.outboxQueue.upsertJobScheduler(
      OUTBOX_RELAY_JOB,
      { every: 1000 },
      { name: OUTBOX_RELAY_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } },
    );
  }

  async process(_job: Job): Promise<number> {
    return this.relayOnce();
  }

  /**
   * Publishes up to 100 unpublished events. Rows are locked with FOR UPDATE SKIP LOCKED so concurrent
   * relays never take the same row, and the BullMQ jobId equals the event id so a crash between
   * "add job" and "commit" cannot produce a duplicate delivery while the job still exists.
   */
  async relayOnce(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Row[]>`
          SELECT "id", "type", "payload"
          FROM "outbox_events"
          WHERE "publishedAt" IS NULL
          ORDER BY "createdAt", "id"
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return 0;
        for (const row of rows) {
          const data: OutboxJobData = { id: row.id, type: row.type, payload: row.payload };
          await this.outboxQueue.add(OUTBOX_EVENT_JOB, data, { jobId: row.id });
        }
        await tx.outboxEvent.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { publishedAt: new Date(), attempts: { increment: 1 } },
        });
        return rows.length;
      },
      { timeout: 15_000 },
    );
  }
}
