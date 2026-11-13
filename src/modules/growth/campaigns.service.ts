import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type Campaign, type CampaignStatus } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import { assertSafeMarkdown } from "../courses";
import { AccountService } from "../identity";
import { MailService, renderMail } from "../mail";
import { contentHash, isApproved, mayApprove } from "./campaign-approval";
import { toCampaignView } from "./campaign-view";
import { APPROVAL_THRESHOLD, SegmentEvaluator, segmentSchema, type Segment } from "./segment";
import { UnsubscribeTokens } from "./unsubscribe-token";

export interface ActionMeta {
  ip?: string;
  requestId?: string;
}

export interface CampaignFields {
  name: string;
  subject: string;
  bodyMarkdown: string;
  segment: Segment;
}

const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;
const notFound = () => new AppError("CAMPAIGN_NOT_FOUND", 404, "Campaign not found");
const stateInvalid = (message: string) => new AppError("CAMPAIGN_STATE_INVALID", 409, message);
const approvalRequired = (audience: number) =>
  new AppError("CAMPAIGN_APPROVAL_REQUIRED", 409, `This campaign reaches more than ${APPROVAL_THRESHOLD} members: a second admin has to approve it first`, { audience, threshold: APPROVAL_THRESHOLD });
const selfApproval = () => new AppError("CAMPAIGN_SELF_APPROVAL", 403, "A campaign has to be approved by an admin other than its creator and the admin who last edited it");

/** The admin side of campaigns: compose, preview (counts only), test, approve, send, pause, resume, cancel. Sending itself is CampaignSender's. */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly segments: SegmentEvaluator,
    private readonly mail: MailService,
    private readonly accounts: AccountService,
    private readonly tokens: UnsubscribeTokens,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(actorId: string, input: CampaignFields, meta: ActionMeta = {}) {
    const bodyMarkdown = assertSafeMarkdown(input.bodyMarkdown);
    const row = await this.prisma.$transaction(async (tx) => {
      const c = await tx.campaign.create({ data: { name: input.name, subject: input.subject, bodyMarkdown, segment: input.segment as Prisma.InputJsonValue, createdById: actorId, lastEditedById: actorId } });
      await this.audit.record(tx, { actorId, action: "campaign.create", targetType: "campaign", targetId: c.id, after: { name: c.name, subject: c.subject, segment: input.segment }, ...meta });
      return c;
    }, TX_OPTIONS);
    return toCampaignView(row);
  }

  async list(page: PageQuery, status?: CampaignStatus) {
    const rows = await this.prisma.campaign.findMany({ where: { ...(status ? { status } : {}), ...(page.cursor ? { id: { lt: page.cursor } } : {}) }, orderBy: { id: "desc" }, take: page.limit + 1 });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: items.map(toCampaignView), nextCursor };
  }

  /** The campaign with counts of its recipients by state and by reason for skipping: totals only, never a member. */
  async get(id: string) {
    const c = await this.find(id);
    const groups = await this.prisma.campaignRecipient.groupBy({ by: ["status", "skipReason"], where: { campaignId: id }, _count: { _all: true } });
    const recipients: Record<string, number> = {};
    const skipped: Record<string, number> = {};
    for (const g of groups) {
      recipients[g.status] = (recipients[g.status] ?? 0) + g._count._all;
      if (g.status === "SKIPPED" && g.skipReason) skipped[g.skipReason] = g._count._all;
    }
    return { ...toCampaignView(c), recipients, skipped };
  }

  /** Only a draft can be edited. An edit withdraws any approval (the approver agreed to what was there) and makes the editor the last editor, who cannot approve it. */
  async update(actorId: string, id: string, patch: Partial<CampaignFields>, meta: ActionMeta = {}) {
    const bodyMarkdown = patch.bodyMarkdown === undefined ? undefined : assertSafeMarkdown(patch.bodyMarkdown);
    const row = await this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.status !== "DRAFT") throw stateInvalid("Only a draft campaign can be edited");
      const data: Prisma.CampaignUncheckedUpdateInput = { approvedById: null, approvedAt: null, approvalHash: null, lastEditedById: actorId };
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.subject !== undefined) data.subject = patch.subject;
      if (bodyMarkdown !== undefined) data.bodyMarkdown = bodyMarkdown;
      if (patch.segment !== undefined) data.segment = patch.segment as Prisma.InputJsonValue;
      const c = await tx.campaign.update({ where: { id }, data });
      await this.audit.record(tx, {
        actorId,
        action: "campaign.update",
        targetType: "campaign",
        targetId: id,
        before: { name: before.name, subject: before.subject, segment: before.segment, approvedById: before.approvedById },
        after: { name: c.name, subject: c.subject, segment: c.segment, approvedById: null },
        ...meta,
      });
      return c;
    }, TX_OPTIONS);
    return toCampaignView(row);
  }

  /**
   * How many members match right now, whether sending needs a second admin, and the mail as members will get it: the subject and the HTML from
   * the same renderer the sender uses (with the asking admin's own unsubscribe link). No member data leaves this method.
   */
  async preview(actorId: string, id: string) {
    const c = await this.find(id);
    const audience = await this.segments.count(this.segmentOf(c));
    const { subject, html } = await renderMail("promo_campaign", { subject: c.subject, bodyMarkdown: c.bodyMarkdown, unsubscribeUrl: this.tokens.urlFor(actorId) });
    return { audience, requiresApproval: audience > APPROVAL_THRESHOLD, subject, html };
  }

  /** One mail, to the acting admin's own address, marked [Test]; nobody else can be named. */
  async testSend(actorId: string, id: string) {
    const c = await this.find(id);
    const to = await this.accounts.findEmail(actorId);
    if (!to) throw notFound();
    // Transactional: an admin who unsubscribed themselves from promotions still gets to see their test.
    await this.mail.send("promo_campaign", to, { subject: `[Test] ${c.subject}`, bodyMarkdown: c.bodyMarkdown, unsubscribeUrl: this.tokens.urlFor(actorId) });
    return { sent: true as const };
  }

  async approve(actorId: string, id: string, meta: ActionMeta = {}) {
    const row = await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, id);
      if (c.status !== "DRAFT") throw stateInvalid("Only a draft campaign can be approved");
      if (!mayApprove(c, actorId)) throw selfApproval();
      if (c.approvedById === actorId && isApproved(c)) return c;
      const updated = await tx.campaign.update({ where: { id }, data: { approvedById: actorId, approvedAt: this.clock.now(), approvalHash: contentHash(c) } });
      await this.audit.record(tx, { actorId, action: "campaign.approve", targetType: "campaign", targetId: id, after: { approvedById: actorId }, ...meta });
      return updated;
    }, TX_OPTIONS);
    return toCampaignView(row);
  }

  /** DRAFT -> SCHEDULED. Above the threshold the campaign must already be approved by someone other than its creator. The sender picks it up when `scheduledAt` has passed. */
  async send(actorId: string, id: string, scheduledAt: Date | undefined, meta: ActionMeta = {}) {
    const current = await this.find(id);
    const audience = await this.segments.count(this.segmentOf(current));
    const row = await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, id);
      if (c.status !== "DRAFT") throw stateInvalid("Only a draft campaign can be sent");
      if (audience > APPROVAL_THRESHOLD && !isApproved(c)) throw approvalRequired(audience);
      const at = scheduledAt ?? this.clock.now();
      const updated = await tx.campaign.update({ where: { id }, data: { status: "SCHEDULED", scheduledAt: at } });
      await this.audit.record(tx, { actorId, action: "campaign.send", targetType: "campaign", targetId: id, before: { status: "DRAFT" }, after: { status: "SCHEDULED", scheduledAt: at.toISOString(), audience }, ...meta });
      return updated;
    }, TX_OPTIONS);
    return toCampaignView(row);
  }

  pause(actorId: string, id: string, meta: ActionMeta = {}) {
    return this.move(actorId, id, "campaign.pause", ["SENDING"], "PAUSED", meta);
  }

  resume(actorId: string, id: string, meta: ActionMeta = {}) {
    return this.move(actorId, id, "campaign.resume", ["PAUSED"], "SENDING", meta);
  }

  /** Stops a campaign that has not finished; recipients it did not reach are marked skipped (reason `cancelled`), and mail already queued is dropped by the mail worker when it gets to it. */
  async cancel(actorId: string, id: string, meta: ActionMeta = {}) {
    const row = await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, id);
      if (c.status === "CANCELLED") return c;
      if (!["SCHEDULED", "SENDING", "PAUSED", "DRAFT"].includes(c.status)) throw stateInvalid("This campaign has already finished");
      const updated = await tx.campaign.update({ where: { id }, data: { status: "CANCELLED", finishedAt: this.clock.now() } });
      await tx.campaignRecipient.updateMany({ where: { campaignId: id, status: "PENDING" }, data: { status: "SKIPPED", skipReason: "cancelled" } });
      await this.audit.record(tx, { actorId, action: "campaign.cancel", targetType: "campaign", targetId: id, before: { status: c.status }, after: { status: "CANCELLED" }, ...meta });
      return updated;
    }, TX_OPTIONS);
    return toCampaignView(row);
  }

  private async move(actorId: string, id: string, action: string, from: CampaignStatus[], to: CampaignStatus, meta: ActionMeta) {
    const row = await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, id);
      if (c.status === to) return c;
      if (!from.includes(c.status)) throw stateInvalid(`A campaign that is ${c.status.toLowerCase()} cannot be ${to === "PAUSED" ? "paused" : "resumed"}`);
      const updated = await tx.campaign.update({ where: { id }, data: { status: to } });
      await this.audit.record(tx, { actorId, action, targetType: "campaign", targetId: id, before: { status: c.status }, after: { status: to }, ...meta });
      return updated;
    }, TX_OPTIONS);
    return toCampaignView(row);
  }

  private segmentOf(c: Campaign): Segment {
    return segmentSchema.parse(c.segment);
  }

  private async find(id: string): Promise<Campaign> {
    const c = await this.prisma.campaign.findUnique({ where: { id } });
    if (!c) throw notFound();
    return c;
  }

  private async lock(tx: Prisma.TransactionClient, id: string): Promise<Campaign> {
    await tx.$queryRaw`SELECT "id" FROM "campaigns" WHERE "id" = ${id} FOR UPDATE`;
    const c = await tx.campaign.findUnique({ where: { id } });
    if (!c) throw notFound();
    return c;
  }
}
