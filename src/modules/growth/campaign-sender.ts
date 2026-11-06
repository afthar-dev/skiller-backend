import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, type Campaign } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SettingsService } from "../admin";
import { AccountService } from "../identity";
import { EmailSuppressions, MailService } from "../mail";
import { PromoPreferences } from "../notifications";
import { SegmentEvaluator, segmentSchema } from "./segment";
import { UnsubscribeTokens } from "./unsubscribe-token";

/** Recipients taken, mailed and recorded in one go. */
export const BATCH_SIZE = 100;
/** A claim older than this was left behind by a worker that died mid-batch; the recipient is taken again. */
export const STALE_CLAIM_MS = 5 * 60 * 1000;
/** Batches one run does before it hands back (the next tick continues): a campaign cannot hog the worker. */
export const MAX_BATCHES_PER_RUN = 30;
const START_TX = { timeout: 30 * 60 * 1000, maxWait: 15_000 } as const;
const INSERT_CHUNK = 1000;

export type SkipReason = "account_inactive" | "suppressed" | "unsubscribed" | "marketing_opt_in_required" | "cancelled";

/**
 * Sends campaigns, in the background. Starting a campaign writes its recipient rows (idempotent), then batches of 100 are claimed with
 * FOR UPDATE SKIP LOCKED (so parallel workers never take the same recipient), checked one by one against suppressions, preferences and
 * the opt-in rule, and queued as promotional mail with the key `campaign-<id>-<user>`, so the same member can never get the same campaign
 * twice (not from a retry, a resume, or a re-claimed batch). Pause and cancel are read before every batch. A claim left by a dead worker
 * goes stale after five minutes and the recipient is taken again.
 */
@Injectable()
export class CampaignSender {
  private readonly logger = new Logger(CampaignSender.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly segments: SegmentEvaluator,
    private readonly accounts: AccountService,
    private readonly suppressions: EmailSuppressions,
    private readonly preferences: PromoPreferences,
    private readonly settings: SettingsService,
    private readonly mail: MailService,
    private readonly tokens: UnsubscribeTokens,
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
   */
  async start(campaignId: string): Promise<void> {
    await this.prisma.$transaction(async (lock) => {
      const [{ locked }] = await lock.$queryRaw<[{ locked: boolean }]>`SELECT pg_try_advisory_xact_lock(hashtext(${`campaign-start:${campaignId}`})) AS "locked"`;
      if (!locked) return;
      const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign || campaign.status !== "SCHEDULED") return;
      const segment = segmentSchema.parse(campaign.segment);
      await this.segments.stream(segment, async (userIds) => {
        for (let i = 0; i < userIds.length; i += INSERT_CHUNK) {
          await this.prisma.campaignRecipient.createMany({ data: userIds.slice(i, i + INSERT_CHUNK).map((userId) => ({ campaignId, userId })), skipDuplicates: true });
        }
      });
      const audienceSize = await this.prisma.campaignRecipient.count({ where: { campaignId } });
      await this.prisma.campaign.updateMany({ where: { id: campaignId, status: "SCHEDULED" }, data: { status: "SENDING", startedAt: this.clock.now(), audienceSize } });
    }, START_TX);
  }

  /** Works through a SENDING campaign in batches until it is done, paused, cancelled, or `maxBatches` have been done. */
  async run(campaignId: string, opts: { maxBatches?: number } = {}): Promise<void> {
    const maxBatches = opts.maxBatches ?? MAX_BATCHES_PER_RUN;
    for (let i = 0; i < maxBatches; i++) {
      const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
      // Paused, cancelled or finished: stop at once (checked before every batch).
      if (!campaign || campaign.status !== "SENDING") return;
      const claimed = await this.claim(campaignId);
      if (claimed.length === 0) {
        await this.finishIfDone(campaignId);
        return;
      }
      await this.process(campaign, claimed);
      if (claimed.length < BATCH_SIZE) await this.finishIfDone(campaignId);
    }
  }

  /** Takes up to a batch of PENDING recipients nobody else holds (SKIP LOCKED), stamping them as held now. One statement. */
  private async claim(campaignId: string): Promise<string[]> {
    const now = this.clock.now();
    const stale = new Date(now.getTime() - STALE_CLAIM_MS);
    const rows = await this.prisma.$queryRaw<Array<{ userId: string }>>`
      UPDATE "campaign_recipients" SET "claimedAt" = ${now}
      WHERE ("campaignId", "userId") IN (
        SELECT "campaignId", "userId" FROM "campaign_recipients"
        WHERE "campaignId" = ${campaignId} AND "status" = 'PENDING' AND ("claimedAt" IS NULL OR "claimedAt" < ${stale})
        ORDER BY "userId" LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED)
      RETURNING "userId"`;
    return rows.map((r) => r.userId);
  }

  /** SENT when no recipient is waiting any more. A recipient someone else holds right now is still waiting. */
  private async finishIfDone(campaignId: string): Promise<void> {
    const waiting = await this.prisma.campaignRecipient.count({ where: { campaignId, status: "PENDING" } });
    if (waiting === 0) await this.prisma.campaign.updateMany({ where: { id: campaignId, status: "SENDING" }, data: { status: "SENT", finishedAt: this.clock.now() } });
  }

  private async process(campaign: Campaign, userIds: string[]): Promise<void> {
    const accounts = new Map((await this.accounts.getMany(userIds)).map((a) => [a.id, a]));
    const emails = [...accounts.values()].map((a) => a.email);
    const [suppressed, prefs, optInRequired] = await Promise.all([this.suppressions.find(emails), this.preferences.promoStates(userIds), this.settings.get("marketing_opt_in_required")]);

    const skips = new Map<SkipReason, string[]>();
    const skip = (reason: SkipReason, userId: string) => skips.set(reason, [...(skips.get(reason) ?? []), userId]);
    const toSend: Array<{ userId: string; email: string }> = [];
    for (const userId of userIds) {
      const account = accounts.get(userId);
      if (!account || account.status !== "ACTIVE") skip("account_inactive", userId);
      else if (suppressed.has(account.email.toLowerCase())) skip("suppressed", userId);
      else if (prefs.unsubscribed.has(userId)) skip("unsubscribed", userId);
      else if (optInRequired && !prefs.optedIn.has(userId)) skip("marketing_opt_in_required", userId);
      else toSend.push({ userId, email: account.email });
    }

    for (const { userId, email } of toSend) {
      await this.mail.send(
        "promo_campaign",
        email,
        { subject: campaign.subject, bodyMarkdown: campaign.bodyMarkdown, unsubscribeUrl: this.tokens.urlFor(userId) },
        { category: "promotional", idempotencyKey: `campaign-${campaign.id}-${userId}`, ref: { kind: "campaign", key: `${campaign.id}:${userId}` } },
      );
    }
    const now = this.clock.now();
    if (toSend.length > 0) {
      await this.prisma.campaignRecipient.updateMany({ where: { campaignId: campaign.id, userId: { in: toSend.map((s) => s.userId) }, status: "PENDING" }, data: { status: "SENT", sentAt: now } });
    }
    for (const [reason, ids] of skips) {
      await this.prisma.campaignRecipient.updateMany({ where: { campaignId: campaign.id, userId: { in: ids }, status: "PENDING" }, data: { status: "SKIPPED", skipReason: reason } });
    }
    this.logger.log(`campaign ${campaign.id}: batch of ${userIds.length}, ${toSend.length} queued, ${userIds.length - toSend.length} skipped`);
  }

  /** The mail worker's word on a queued mail: Resend's id on success, or why it did not go out. */
  async onMailOutcome(campaignId: string, userId: string, outcome: { outcome: "sent"; resendId: string } | { outcome: "skipped" | "failed"; reason: string }): Promise<void> {
    if (outcome.outcome === "sent") {
      await this.prisma.campaignRecipient.updateMany({ where: { campaignId, userId, resendId: null }, data: { resendId: outcome.resendId } });
    } else if (outcome.outcome === "skipped") {
      await this.prisma.campaignRecipient.updateMany({ where: { campaignId, userId, status: "SENT" }, data: { status: "SKIPPED", skipReason: outcome.reason } });
    } else {
      await this.prisma.campaignRecipient.updateMany({ where: { campaignId, userId, status: "SENT" }, data: { status: "FAILED", skipReason: outcome.reason } });
    }
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
      await tx.$executeRaw(Prisma.sql`
        UPDATE "campaigns" SET "stats" = jsonb_set(COALESCE("stats", '{}'::jsonb), ARRAY[${column.stat}]::text[], to_jsonb(COALESCE(("stats"->>${column.stat})::int, 0) + 1))
        WHERE "id" = ${recipient.campaignId}`);
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
