import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { UnrecoverableError, type Job } from "bullmq";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { JobProcessor } from "../../common/queue/job-processor";
import { ProcessorRegistry } from "../../common/queue/processor-registry";
import { QueueNames } from "../../common/queue/queue.constants";
import { SettingsService } from "../admin";
import { AccountService } from "../identity";
import { EmailSuppressions, MailDelivery, ResendApiError } from "../mail";
import { PromoPreferences } from "../notifications";
import { CampaignAlerts } from "./campaign-alerts";
import { bumpStat } from "./campaign-stats";
import { UnsubscribeTokens } from "./unsubscribe-token";

export const PROMO_SEND_JOB = "send";

/** All a promo job carries: who, for which campaign. The text, the address and the link are looked up when the mail is sent. */
export interface PromoJobData {
  campaignId: string;
  userId: string;
}

export type SkipReason = "account_inactive" | "suppressed" | "unsubscribed" | "marketing_opt_in_required" | "cancelled";

const CACHE_ENTRIES = 20;

/**
 * The worker of the `mail-promo` queue: one job, one member. The sender has already claimed the recipient (PENDING -> SENDING); this is the last stop before
 * Resend, so everything that can change while a job waits is looked at again here: the campaign must still be sending (paused: the recipient is released
 * back to PENDING for the resume; cancelled: skipped), the account active, the address not suppressed, the member not unsubscribed, and opt-in honoured when
 * the platform requires it. A recipient that is not SENDING any more (finished by an earlier delivery of this job, or written off as UNKNOWN) is left alone.
 * Resend gets a stable Idempotency-Key, so a job redelivered after the worker died mid-send still produces one mail. Rate limited by `promo_send_per_second`.
 */
@Injectable()
export class PromoMailProcessor implements JobProcessor, OnModuleInit {
  readonly queue = QueueNames.mailPromo;
  readonly jobNames = [PROMO_SEND_JOB];
  readonly concurrency = 4;
  private readonly logger = new Logger(PromoMailProcessor.name);
  /** The text of the campaigns being sent, keyed by campaign and valid for one `updatedAt`: one read per campaign, not one per member. */
  private readonly content = new Map<string, { updatedAt: number; subject: string; bodyMarkdown: string }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProcessorRegistry,
    private readonly accounts: AccountService,
    private readonly suppressions: EmailSuppressions,
    private readonly preferences: PromoPreferences,
    private readonly settings: SettingsService,
    private readonly delivery: MailDelivery,
    private readonly tokens: UnsubscribeTokens,
    private readonly alerts: CampaignAlerts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async limiter() {
    return { max: await this.settings.get("promo_send_per_second"), duration: 1000 };
  }

  async process(job: Job<PromoJobData>): Promise<void> {
    const { campaignId, userId } = job.data;
    const where = { campaignId_userId: { campaignId, userId } };
    const recipient = await this.prisma.campaignRecipient.findUnique({ where, select: { status: true } });
    if (!recipient || recipient.status !== "SENDING") return;

    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true, updatedAt: true } });
    if (campaign?.status === "PAUSED") return this.release(campaignId, userId);
    if (campaign?.status !== "SENDING") return this.skip(campaignId, userId, "cancelled");

    const [account] = await this.accounts.getMany([userId]);
    if (!account || account.status !== "ACTIVE") return this.skip(campaignId, userId, "account_inactive");
    const [suppressed, states, optInRequired] = await Promise.all([this.suppressions.find([account.email]), this.preferences.promoStates([userId]), this.settings.get("marketing_opt_in_required")]);
    if (suppressed.has(account.email.toLowerCase())) return this.skip(campaignId, userId, "suppressed");
    if (states.unsubscribed.has(userId)) return this.skip(campaignId, userId, "unsubscribed");
    if (optInRequired && !states.optedIn.has(userId)) return this.skip(campaignId, userId, "marketing_opt_in_required");

    const text = await this.contentOf(campaignId, campaign.updatedAt);
    if (!text) return this.skip(campaignId, userId, "cancelled");
    try {
      const { id } = await this.delivery.deliver("promo_campaign", account.email, { subject: text.subject, bodyMarkdown: text.bodyMarkdown, unsubscribeUrl: this.tokens.urlFor(userId) }, { idempotencyKey: `campaign-${campaignId}-${userId}` });
      await this.prisma.campaignRecipient.updateMany({ where: { campaignId, userId, status: "SENDING" }, data: { status: "SENT", sentAt: this.clock.now(), resendId: id } });
    } catch (err) {
      // 4xx (except 429) will never succeed on retry; 5xx, 429 and network errors are retried by the queue (backoff, then onExhausted).
      if (err instanceof ResendApiError && err.status >= 400 && err.status < 500 && err.status !== 429) throw new UnrecoverableError(`resend_${err.status}`);
      throw err;
    }
  }

  /** The job gave up (a permanent refusal, or every retry used): the recipient is FAILED, counted, and a failing campaign is reported. */
  async onExhausted(job: Job<PromoJobData>, err: Error): Promise<void> {
    const { campaignId, userId } = job.data;
    const reason = /^resend_\d{3}$/.test(err.message) ? err.message : "send_failed";
    const done = await this.prisma.campaignRecipient.updateMany({ where: { campaignId, userId, status: "SENDING" }, data: { status: "FAILED", skipReason: reason } });
    if (done.count === 0) return;
    await bumpStat(this.prisma, campaignId, "failed");
    await this.alerts.checkFailureRate(campaignId, false);
  }

  /** Paused while the job waited: the member goes back to PENDING and is queued again when the campaign resumes. */
  private async release(campaignId: string, userId: string) {
    await this.prisma.campaignRecipient.updateMany({ where: { campaignId, userId, status: "SENDING" }, data: { status: "PENDING", sendingAt: null } });
  }

  private async skip(campaignId: string, userId: string, reason: SkipReason) {
    await this.prisma.campaignRecipient.updateMany({ where: { campaignId, userId, status: "SENDING" }, data: { status: "SKIPPED", skipReason: reason } });
  }

  private async contentOf(campaignId: string, updatedAt: Date) {
    const cached = this.content.get(campaignId);
    if (cached && cached.updatedAt === updatedAt.getTime()) return cached;
    const row = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { subject: true, bodyMarkdown: true, updatedAt: true } });
    if (!row) return null;
    const fresh = { updatedAt: row.updatedAt.getTime(), subject: row.subject, bodyMarkdown: row.bodyMarkdown };
    this.content.delete(campaignId);
    this.content.set(campaignId, fresh);
    while (this.content.size > CACHE_ENTRIES) this.content.delete(this.content.keys().next().value as string);
    return fresh;
  }
}
