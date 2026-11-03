import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { CLOCK, type Clock } from "../clock/clock";
import { PrismaService } from "../prisma/prisma.service";
import type { JobProcessor } from "../queue/job-processor";
import { ProcessorRegistry } from "../queue/processor-registry";
import { InjectQueue } from "../queue/queue.decorators";
import { QueueNames } from "../queue/queue.constants";
import { OUTBOX_EVENT_JOB, OutboxJobData } from "./outbox.processor";

const BATCH_SIZE = 100;
/** Max batches drained per scheduled run, so a backlog clears quickly without monopolising the worker. */
const MAX_BATCHES_PER_RUN = 10;
/** A claim that was never followed by "published" (crashed relay) becomes claimable again after this long. */
export const CLAIM_TTL_MS = 60_000;
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
    @Inject(CLOCK) private readonly clock: Clock,
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
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const n = await this.relayOnce();
      total += n;
      if (n < BATCH_SIZE) break;
    }
    return total;
  }

  /**
   * Publishes up to 100 unpublished events without ever holding a DB transaction or row lock across Redis:
   *  1. claim: one statement stamps (claimedAt, claimToken) on a batch picked with FOR UPDATE SKIP LOCKED, so concurrent
   *     relays never claim the same row (a claimed row is invisible to others until its claim is 60 s old);
   *  2. add: addBulk to BullMQ with jobId = event id (BullMQ dedupes by id, so re-adding after a crash is harmless);
   *  3. mark: set publishedAt for the rows still carrying our token.
   * A crash between 1 and 3 leaves the rows reclaimable after CLAIM_TTL_MS; the re-add is a no-op while the job exists.
   */
  async relayOnce(): Promise<number> {
    const now = this.clock.now();
    const token = randomUUID();
    const rows = await this.claim(now, token);
    if (rows.length === 0) return 0;

    try {
      await this.outboxQueue.addBulk(
        rows.map((row) => ({
          name: OUTBOX_EVENT_JOB,
          data: { id: row.id, type: row.type, payload: row.payload } satisfies OutboxJobData,
          opts: { jobId: row.id },
        })),
      );
    } catch (err) {
      // Give the rows back right away rather than making them wait out the claim TTL.
      await this.prisma.outboxEvent
        .updateMany({ where: { id: { in: rows.map((r) => r.id) }, claimToken: token }, data: { claimedAt: null, claimToken: null } })
        .catch(() => undefined);
      throw err;
    }

    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, claimToken: token, publishedAt: null },
      data: { publishedAt: this.clock.now(), attempts: { increment: 1 } },
    });
    return rows.length;
  }

  private claim(now: Date, token: string): Promise<Row[]> {
    const nowTs = now.toISOString();
    const staleTs = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
    return this.prisma.$queryRaw<Row[]>`
      UPDATE "outbox_events"
      SET "claimedAt" = ${nowTs}::timestamp, "claimToken" = ${token}
      WHERE "id" IN (
        SELECT "id" FROM "outbox_events"
        WHERE "publishedAt" IS NULL AND "deadAt" IS NULL
          AND ("claimedAt" IS NULL OR "claimedAt" < ${staleTs}::timestamp)
        ORDER BY "createdAt", "id"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED)
      RETURNING "id", "type", "payload"`;
  }
}
