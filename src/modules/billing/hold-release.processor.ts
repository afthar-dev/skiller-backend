import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { Job, Queue } from "bullmq";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { SettingsService } from "../admin";
import { AccountsService, LedgerService } from "../wallet";
import { ORDER_LEDGER_REF, SALE_DESCRIPTION } from "./fulfilment.service";
import { toApi } from "./money";

export const HOLD_RELEASE_JOB = "holds.release";
export const HOLD_RELEASE_EVERY_MS = 60 * 60 * 1000;
export const HOLD_RELEASE_DESCRIPTION = "hold_release";
const CHUNK = 100;
/** Bounds one run; whatever is left is picked up by the next hourly run. */
const MAX_CHUNKS_PER_RUN = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hourly: an order PAID at least `hold_days` ago has its seller share moved from PENDING to AVAILABLE. The amount is the PENDING
 * line the sale entry actually posted (never recomputed), and the entry is keyed (ORDER, orderId, hold_release), so a repeat is a no-op.
 *
 * Orders are found in chunks of 100 without locking anything, then claimed one at a time: each gets its own short transaction that
 * locks the order row FOR UPDATE SKIP LOCKED. A row someone else holds (a refund being processed, another worker) is skipped and
 * retried next run, so neither side can spend the same PENDING money and no transaction ever spans many orders. The refund handler
 * takes the same row lock and decides "released or not" under it.
 */
@Injectable()
export class HoldReleaseProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.maintenance;
  readonly jobNames = [HOLD_RELEASE_JOB];
  private readonly logger = new Logger(HoldReleaseProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly accounts: AccountsService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
    private readonly registry: ProcessorRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QueueNames.maintenance) private readonly maintenanceQueue: Queue,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  /** Called once by the worker process. */
  async schedule() {
    await this.maintenanceQueue.upsertJobScheduler(HOLD_RELEASE_JOB, { every: HOLD_RELEASE_EVERY_MS }, { name: HOLD_RELEASE_JOB, opts: { attempts: 1, removeOnComplete: true, removeOnFail: true } });
  }

  async process(_job: Job) {
    return this.releaseDue();
  }

  /** Returns how many orders were released by this run. */
  async releaseDue(): Promise<number> {
    const holdDays = await this.settings.get("hold_days");
    const cutoff = new Date(this.clock.now().getTime() - holdDays * DAY_MS);
    let released = 0;
    let after = "";
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN; chunk++) {
      const due = await this.prisma.$queryRaw<{ id: string }[]>`SELECT o."id" FROM "orders" o
        WHERE o."status" = 'PAID' AND o."paidAt" <= ${cutoff} AND o."id" > ${after}
          AND NOT EXISTS (SELECT 1 FROM "journal_entries" j WHERE j."refType" = ${ORDER_LEDGER_REF} AND j."refId" = o."id" AND j."description" = ${HOLD_RELEASE_DESCRIPTION})
          AND NOT EXISTS (SELECT 1 FROM "refunds" r WHERE r."orderId" = o."id" AND r."status" IN ('REQUESTED', 'APPROVED', 'PROCESSING'))
          AND (o."fulfilmentFailedAt" IS NULL OR EXISTS (SELECT 1 FROM "refunds" r WHERE r."orderId" = o."id" AND r."status" = 'REJECTED'))
        ORDER BY o."id" LIMIT ${CHUNK}`;
      for (const { id } of due) {
        try {
          if (await this.releaseOne(id)) released += 1;
        } catch (err) {
          // One bad order must not stop the others; it is retried on the next run.
          this.logger.error(`hold release of order ${id} failed: ${(err as Error).message}`);
        }
      }
      if (due.length < CHUNK) break;
      after = due[due.length - 1].id;
    }
    if (released > 0) this.logger.log(`released the hold on ${released} order(s)`);
    return released;
  }

  /** A live refund holds the seller share where it is; so does a failed delivery, unless its refund was rejected (nothing will be refunded). */
  private async isHeld(tx: Prisma.TransactionClient, order: { id: string; fulfilmentFailedAt: Date | null }): Promise<boolean> {
    if (await tx.refund.count({ where: { orderId: order.id, status: { in: ["REQUESTED", "APPROVED", "PROCESSING"] } } })) return true;
    if (!order.fulfilmentFailedAt) return false;
    return (await tx.refund.count({ where: { orderId: order.id, status: "REJECTED" } })) === 0;
  }

  private async releaseOne(orderId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "orders" WHERE "id" = ${orderId} AND "status" = 'PAID' FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return false; // refunded, or held by a refund / another worker: not ours to release now
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { select: { title: true } } } });
      // Decided under the order lock, where a refund request (which takes the same lock) cannot slip in: the hold stays while money may go back.
      if (await this.isHeld(tx, order)) return false;
      const sale = await tx.journalEntry.findUnique({
        where: { refType_refId_description: { refType: ORDER_LEDGER_REF, refId: orderId, description: SALE_DESCRIPTION } },
        include: { lines: { include: { account: { select: { kind: true, ownerType: true, ownerId: true } } } } },
      });
      if (!sale) {
        this.logger.error(`order ${orderId} is PAID but has no sale entry; its hold cannot be released`);
        return false;
      }
      const pending = sale.lines.find((l) => l.account.kind === "PENDING" && l.account.ownerType === order.sellerOwnerType && l.account.ownerId === order.sellerOwnerId);
      if (!pending || pending.amountPaise < 0n) {
        this.logger.error(`order ${orderId}: the sale entry has no seller PENDING credit; its hold cannot be released`);
        return false;
      }
      const share = pending.amountPaise;
      const seller = await this.accounts.ensureSellerAccounts(tx, order.sellerOwnerType, order.sellerOwnerId);
      const posted = await this.ledger.post(tx, {
        refType: ORDER_LEDGER_REF,
        refId: orderId,
        description: HOLD_RELEASE_DESCRIPTION,
        lines: [
          { accountId: seller.PENDING, amountPaise: -share },
          { accountId: seller.AVAILABLE, amountPaise: share },
        ],
      });
      if (posted.duplicate) return false;
      await this.outbox.enqueue(tx, {
        type: "order.hold_released",
        orderId,
        sellerOwnerType: order.sellerOwnerType,
        sellerOwnerId: order.sellerOwnerId,
        itemTitle: order.items[0]?.title ?? "your sale",
        amountPaise: toApi(share),
      });
      return true;
    });
  }
}
