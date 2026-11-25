import { Inject, Injectable, Logger, Module, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Job, Queue } from "bullmq";
import { CLOCK, ClockModule, type Clock } from "../clock/clock";
import { PrismaService } from "../prisma/prisma.service";
import type { JobProcessor } from "../queue/job-processor";
import { ProcessorRegistry } from "../queue/processor-registry";
import { QueueNames } from "../queue/queue.constants";
import { InjectQueue } from "../queue/queue.decorators";

export const PRUNE_JOB = "maintenance.prune";
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 5000;
const MAX_BATCHES_PER_RULE = 200;

export interface PruneRule {
  /** Name of the retention setting: env PRUNE_<KEY>_DAYS overrides the default. */
  key: string;
  table: string;
  /** SQL condition on the table (a trusted constant) with `$1` standing for the cutoff timestamp. */
  where: string;
  defaultDays: number;
}

/**
 * What is kept, and for how long. Deliberately conservative: nothing here is needed for correctness once old, only for diagnostics or short replay windows.
 * - outbox_events: published rows (the relay never reads them again). Dead rows stay until someone replays or removes them.
 * - otp_challenges: expired a day ago.
 * - sessions: expired or revoked 30 days ago.
 * - webhook_events: processed 90 days ago (the dedupe window of a payment gateway retry is days).
 * - notifications: read 90 days ago. Unread ones stay.
 * - reel_view_flushes: batch ids applied a week ago (a batch key is never re-applied later than a few minutes).
 */
export const PRUNE_RULES: PruneRule[] = [
  { key: "OUTBOX", table: "outbox_events", where: `"publishedAt" IS NOT NULL AND "publishedAt" < $1`, defaultDays: 7 },
  { key: "OTP", table: "otp_challenges", where: `"expiresAt" < $1`, defaultDays: 1 },
  { key: "SESSIONS", table: "sessions", where: `(("expiresAt" < $1) OR ("revokedAt" IS NOT NULL AND "revokedAt" < $1))`, defaultDays: 30 },
  { key: "WEBHOOKS", table: "webhook_events", where: `"processedAt" IS NOT NULL AND "processedAt" < $1`, defaultDays: 90 },
  { key: "NOTIFICATIONS", table: "notifications", where: `"readAt" IS NOT NULL AND "readAt" < $1`, defaultDays: 90 },
  { key: "VIEW_FLUSHES", table: "reel_view_flushes", where: `"appliedAt" < $1`, defaultDays: 7 },
];

export const retentionDays = (rule: PruneRule, env: NodeJS.ProcessEnv = process.env): number => {
  const raw = Number(env[`PRUNE_${rule.key}_DAYS`]);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : rule.defaultDays;
};

/** Daily: deletes old rows of the tables that otherwise only grow, in batches so no statement holds locks for long. */
@Injectable()
export class PruneProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [PRUNE_JOB];
  private readonly logger = new Logger(PruneProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProcessorRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. 03:30 IST, after the analytics rollup. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(PRUNE_JOB, { pattern: "30 3 * * *", tz: "Asia/Kolkata" }, { name: PRUNE_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
  }

  async process(_job?: Job): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const rule of PRUNE_RULES) {
      try {
        out[rule.table] = await this.prune(rule);
      } catch (err) {
        this.logger.error(`prune of ${rule.table} failed: ${(err as Error).message}`);
      }
    }
    const total = Object.values(out).reduce((a, b) => a + b, 0);
    if (total > 0) this.logger.log(`pruned ${JSON.stringify(out)}`);
    return out;
  }

  async prune(rule: PruneRule): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - retentionDays(rule) * DAY_MS);
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_RULE; i++) {
      const n = await this.deleteBatch(rule, cutoff);
      total += n;
      if (n < BATCH) break;
    }
    return total;
  }

  private deleteBatch(rule: PruneRule, cutoff: Date): Promise<number> {
    // `$1` in the (constant) rule condition becomes the bound cutoff parameter.
    const [head, ...rest] = rule.where.split("$1");
    const cond = rest.reduce<Prisma.Sql>((acc, part) => Prisma.sql`${acc}${cutoff}${Prisma.raw(part)}`, Prisma.sql`${Prisma.raw(head)}`);
    const table = Prisma.raw(`"${rule.table}"`);
    return this.prisma.$executeRaw`DELETE FROM ${table} WHERE "id" IN (SELECT "id" FROM ${table} WHERE ${cond} LIMIT ${BATCH})`;
  }
}

@Module({ imports: [ClockModule], providers: [PruneProcessor], exports: [PruneProcessor] })
export class PruneModule {}
