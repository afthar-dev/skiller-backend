import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Queue } from "bullmq";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { PROMO_JOB_OPTIONS } from "../../common/queue/queue.options";
import { NotificationsService } from "../notifications";
import { CampaignAlerts } from "./campaign-alerts";
import { isApproved } from "./campaign-approval";
import { PROMO_SEND_JOB, type PromoJobData } from "./promo-mail.processor";
import { bumpStat } from "./campaign-stats";
import { APPROVAL_THRESHOLD, SegmentEvaluator, segmentSchema } from "./segment";

/** Recipients claimed and queued in one go. */
export const BATCH_SIZE = 100;
/** The sender queues no more promo mail while this many jobs wait: the queue (and Redis) stay small however big the campaign is. */
export const MAX_QUEUE_DEPTH = 500;
/** A recipient SENDING this long has had no word from the mail worker (the sender or the worker died): the mail may or may not have gone, so it is never sent again. */
export const SENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Batches one run does before it hands back (the next tick continues): a campaign cannot hog the worker. */
export const MAX_BATCHES_PER_RUN = 30;
const START_TX = { timeout: 30 * 60 * 1000, maxWait: 15_000 } as const;
const INSERT_CHUNK = 1000;
const DEPTH_STATES = ["waiting", "delayed", "active", "prioritized"] as const;

/**
 * Sends campaigns, in the background. Starting a campaign writes its recipient rows (idempotent). Then, while the `mail-promo` queue holds fewer than 500 jobs,
 * batches of up to 100 recipients are claimed PENDING -> SENDING (one statement, FOR UPDATE SKIP LOCKED, so parallel workers never take the same recipient) and
 * queued as `{campaignId, userId}`. From the claim on a recipient is never claimed again: if the sender dies before the job is queued, the row stays SENDING and
 * after 24 hours becomes UNKNOWN (counted, never sent), so a member gets at most one mail. PromoMailProcessor does the checks and the sending; the campaign is
 * SENT only when no recipient is PENDING or SENDING any more.
 */
@Injectable()
export class CampaignSender {
  private readonly logger = new Logger(CampaignSender.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly segments: SegmentEvaluator,
    private readonly notifications: NotificationsService,
    private readonly alerts: CampaignAlerts,
    @InjectQueue(QueueNames.mailPromo) private readonly queue: Queue,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** One pass of the worker: start campaigns that are due, then work on the ones that are sending. */
  async tick(opts: { maxBatches?: number } = {}): Promise<void> {
    const due = await this.prisma.campaign.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: this.clock.now() } }, select: { id: true }, orderBy: { scheduledAt: "asc" }, take: 20 });
    for (const c of due) await this.start(c.id);
    const sending = await this.prisma.campaign.findMany({ where: { status: "SENDING" }, select: { id: true }, orderBy: { startedAt: "asc" }, take: 20 });
    for (const c of sending) await this.run(c.id, { maxBatches: opts.maxBatches ?? MAX_BATCHES_PER_RUN });
  }

  /**
   * SCHEDULED -> SENDING: writes one PENDING row per matching member. Safe to run twice (rows are inserted with skipDuplicates) and to run in two
   * workers at once (one holds the advisory lock, the other leaves). The campaign stays SCHEDULED until every row is written, so a crash here is retried.
   * The audience is evaluated again first: a campaign scheduled when it was small may have grown past the approval threshold since, and then it
   * only starts with a second admin's approval of exactly this content. Otherwise it goes back to DRAFT (no recipients written) and its creator is told.
   */
  async start(campaignId: string): Promise<void> {
    let refused: { id: string; name: string; createdById: string; audience: number } | undefined;
    await this.prisma.$transaction(async (lock) => {
      const [{ locked }] = await lock.$queryRaw<[{ locked: boolean }]>`SELECT pg_try_advisory_xact_lock(hashtext(${`campaign-start:${campaignId}`})) AS "locked"`;
      if (!locked) return;
      const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign || campaign.status !== "SCHEDULED") return;
      const segment = segmentSchema.parse(campaign.segment);
      const audience = await this.segments.count(segment);
      if (audience > APPROVAL_THRESHOLD && !isApproved(campaign)) {
        const back = await this.prisma.campaign.updateMany({ where: { id: campaignId, status: "SCHEDULED" }, data: { status: "DRAFT", scheduledAt: null } });
        if (back.count > 0) refused = { id: campaign.id, name: campaign.name, createdById: campaign.createdById, audience };
        return;
      }
      await this.segments.stream(segment, async (userIds) => {
        for (let i = 0; i < userIds.length; i += INSERT_CHUNK) {
          await this.prisma.campaignRecipient.createMany({ data: userIds.slice(i, i + INSERT_CHUNK).map((userId) => ({ campaignId, userId })), skipDuplicates: true });
        }
      });
      const audienceSize = await this.prisma.campaignRecipient.count({ where: { campaignId } });
      await this.prisma.campaign.updateMany({ where: { id: campaignId, status: "SCHEDULED" }, data: { status: "SENDING", startedAt: this.clock.now(), audienceSize } });
    }, START_TX);
    if (refused) {
      this.logger.warn(`campaign ${refused.id} not started: audience ${refused.audience} is above ${APPROVAL_THRESHOLD} and it has no valid second-admin approval`);
      await this.notifications.notify(refused.createdById, {
        type: "campaign.approval_needed",
        title: "Campaign needs approval before it can send",
        body: `"${refused.name}" now reaches more than ${APPROVAL_THRESHOLD} members, or was changed after it was approved. It is back in draft: ask another admin (not its creator or last editor) to approve it, then send it again.`,
        data: { campaignId: refused.id, audience: refused.audience },
      });
    }
  }

  /** Works through a SENDING campaign in batches until it is done, paused, cancelled, the queue is full, or `maxBatches` have been done. */
  async run(campaignId: string, opts: { maxBatches?: number } = {}): Promise<void> {
    const maxBatches = opts.maxBatches ?? MAX_BATCHES_PER_RUN;
    await this.writeOffStale(campaignId);
    for (let i = 0; i < maxBatches; i++) {
      const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
      // Paused, cancelled or finished: stop at once (checked before every batch).
      if (!campaign || campaign.status !== "SENDING") return;
      const room = MAX_QUEUE_DEPTH - (await this.queueDepth());
      if (room <= 0) return; // backpressure: the mail worker is behind; the next tick looks again
      const limit = Math.min(BATCH_SIZE, room);
      const claimed = await this.claimBatch(campaignId, limit);
      if (claimed.length === 0) {
        await this.finishIfDone(campaignId);
        return;
      }
      await this.enqueue(campaignId, claimed);
      if (claimed.length < limit) {
        await this.finishIfDone(campaignId);
        return;
      }
    }
  }

  /** Takes up to `limit` PENDING recipients nobody else holds (SKIP LOCKED) and makes them SENDING, stamped now. One statement; a recipient is claimed once. */
  async claimBatch(campaignId: string, limit: number): Promise<string[]> {
    const now = this.clock.now();
    const rows = await this.prisma.$queryRaw<Array<{ userId: string }>>`
      UPDATE "campaign_recipients" SET "status" = 'SENDING', "sendingAt" = ${now}
      WHERE ("campaignId", "userId") IN (
        SELECT "campaignId", "userId" FROM "campaign_recipients"
        WHERE "campaignId" = ${campaignId} AND "status" = 'PENDING'
        ORDER BY "userId" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING "userId"`;
    return rows.map((r) => r.userId);
  }

  private async queueDepth(): Promise<number> {
    const counts = await this.queue.getJobCounts(...DEPTH_STATES);
    return DEPTH_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  }

  /**
   * Queues the claimed recipients. If the queue refuses (Redis trouble) the jobs that did not get in are known never to run, so those recipients go
   * back to PENDING; any that cannot be told stay SENDING (and become UNKNOWN), never risking a second mail.
   */
  private async enqueue(campaignId: string, userIds: string[]): Promise<void> {
    const jobId = (userId: string) => `campaign-${campaignId}-${userId}`;
    try {
      await this.queue.addBulk(userIds.map((userId) => ({ name: PROMO_SEND_JOB, data: { campaignId, userId } satisfies PromoJobData, opts: { ...PROMO_JOB_OPTIONS, jobId: jobId(userId) } })));
    } catch (err) {
      this.logger.error(`campaign ${campaignId}: could not queue ${userIds.length} mails: ${(err as Error).message}`);
      try {
        const queued = await Promise.all(userIds.map((userId) => this.queue.getJob(jobId(userId))));
        const absent = userIds.filter((_, i) => !queued[i]);
        if (absent.length > 0) await this.prisma.campaignRecipient.updateMany({ where: { campaignId, userId: { in: absent }, status: "SENDING" }, data: { status: "PENDING", sendingAt: null } });
      } catch {
        // Redis is down for the check too: they stay SENDING.
      }
      throw err;
    }
  }

  /** SENDING for more than 24 hours: no word ever came, so the mail may or may not have gone. Written off as UNKNOWN, counted, never sent. */
  private async writeOffStale(campaignId: string): Promise<void> {
    const cutoff = new Date(this.clock.now().getTime() - SENDING_TIMEOUT_MS);
    const lost = await this.prisma.campaignRecipient.updateMany({ where: { campaignId, status: "SENDING", sendingAt: { lt: cutoff } }, data: { status: "UNKNOWN" } });
    if (lost.count === 0) return;
    this.logger.warn(`campaign ${campaignId}: ${lost.count} recipients written off as UNKNOWN (no word from the mail worker for 24 hours)`);
    await bumpStat(this.prisma, campaignId, "unknown", lost.count);
  }

  /** SENT when no recipient is waiting or in flight any more. */
  private async finishIfDone(campaignId: string): Promise<void> {
    const open = await this.prisma.campaignRecipient.count({ where: { campaignId, status: { in: ["PENDING", "SENDING"] } } });
    if (open > 0) return;
    const done = await this.prisma.campaign.updateMany({ where: { id: campaignId, status: "SENDING" }, data: { status: "SENT", finishedAt: this.clock.now() } });
    if (done.count > 0) await this.alerts.checkFailureRate(campaignId, true);
  }

  /** A Resend webhook event for a mail we sent: stamps the recipient (first time only) and counts it once in the campaign's stats. */
  async onResendEvent(type: string, resendId: string): Promise<void> {
    const column = EVENT_COLUMNS[type];
    if (!column) return;
    const recipient = await this.prisma.campaignRecipient.findUnique({ where: { resendId }, select: { campaignId: true, userId: true } });
    if (!recipient) return;
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
        UPDATE "campaign_recipients" SET ${Prisma.raw(`"${column.field}"`)} = ${this.clock.now()}
        WHERE "campaignId" = ${recipient.campaignId} AND "userId" = ${recipient.userId} AND ${Prisma.raw(`"${column.field}"`)} IS NULL
        RETURNING "userId"`);
      if (rows.length === 0) return;
      await bumpStat(tx, recipient.campaignId, column.stat);
    });
  }
}

const EVENT_COLUMNS: Record<string, { field: string; stat: string }> = {
  "email.delivered": { field: "deliveredAt", stat: "delivered" },
  "email.opened": { field: "openedAt", stat: "opened" },
  "email.clicked": { field: "clickedAt", stat: "clicked" },
  "email.bounced": { field: "bouncedAt", stat: "bounced" },
  "email.complained": { field: "complainedAt", stat: "complained" },
};
