import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, type ReportReason, type ReportTargetType } from "@prisma/client";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import type { PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { REDIS } from "../../common/redis/redis.constants";
import { SettingsService } from "../admin";
import { AuditService } from "../audit";
import { NotificationsService } from "../notifications";
import { ModerationTargetRegistry, type ModerationTarget } from "./moderation-target";
import { BAN_DAYS, STRIKE_LIFETIME_DAYS, STRIKES_FOR_BAN } from "./posting-restrictions";

export const REPORTS_PER_HOUR = 20;
export const NOTE_MAX = 500;
export const DECISION_NOTE_MAX = 1000;
export const REPORT_REASONS = ["SPAM", "HARASSMENT", "HATE", "SEXUAL", "VIOLENCE", "MISINFORMATION", "COPYRIGHT", "OTHER"] as const satisfies readonly ReportReason[];
export const REPORT_TARGET_TYPES = ["REEL", "REEL_COMMENT", "COURSE_REVIEW", "COURSE_QA"] as const satisfies readonly ReportTargetType[];

const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;
const DAY_MS = 24 * 3600_000;

const targetNotFound = () => new AppError("REPORT_TARGET_NOT_FOUND", 404, "Nothing to report here");
const selfModeration = () => new AppError("MODERATION_SELF", 403, "You cannot decide on your own content, or on content in a course you author");
const noOpenReports = () => new AppError("NO_OPEN_REPORTS", 409, "This item has no open reports");

export interface ActionMeta {
  actorId: string;
  ip?: string;
  requestId?: string;
}

export interface ReportInput {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  note?: string;
}

export interface QueueItem {
  targetType: ReportTargetType;
  targetId: string;
  ownerId: string | null;
  reportCount: number;
  reasons: Partial<Record<ReportReason, number>>;
  firstReportedAt: string;
  lastReportedAt: string;
  /** Held back automatically when the report threshold was reached. */
  autoHidden: boolean;
  preview: { text: string; status: string } | null;
}

export interface DecisionView {
  targetType: ReportTargetType;
  targetId: string;
  decision: "UPHELD" | "DISMISSED";
  reports: number;
  /** Upheld: the strike the author received. */
  strike: { id: string; expiresAt: string } | null;
  /** Upheld: the author is barred from posting until this time (three active strikes). */
  restrictedUntil: string | null;
  /** Dismissed: held-back content that came back. */
  restored: boolean;
}

/** Strips control characters and trims; the note is shown to moderators only. */
export function cleanNote(raw: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

/**
 * Reports, the moderator queue and decisions. Content lives with its owner (reels, comments, course reviews and Q&A) behind a registered
 * ModerationTarget; this service only decides. Every change to one target (a new report, a decision) runs under one advisory lock for that target,
 * so the auto-hide fires once and two moderators cannot both decide.
 */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ModerationTargetRegistry,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** A member reports content. Repeating it is harmless (`created: false`). */
  async report(reporterId: string, input: ReportInput): Promise<{ id: string; created: boolean }> {
    const target = this.targetFor(input.targetType);
    const owner = await target.ownerOf(input.targetId);
    if (!owner) throw targetNotFound();
    if (owner === reporterId) throw new AppError("REPORT_OWN_CONTENT", 400, "You cannot report your own content");

    const where = { targetType_targetId_reporterId: { targetType: input.targetType, targetId: input.targetId, reporterId } };
    const existing = await this.prisma.report.findUnique({ where });
    if (existing) return { id: existing.id, created: false };
    await consumeRateLimit(this.redis, `report:${reporterId}`, REPORTS_PER_HOUR, 3600);

    const threshold = await this.settings.get("report_autohide_threshold");
    const note = input.note ? cleanNote(input.note, NOTE_MAX) || null : null;
    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, input.targetType, input.targetId);
      const created = await tx.report.createMany({ data: [{ targetType: input.targetType, targetId: input.targetId, reporterId, reason: input.reason, note, createdAt: this.clock.now() }], skipDuplicates: true });
      const row = await tx.report.findUniqueOrThrow({ where });
      if (created.count === 0) return { id: row.id, created: false, hidden: false };
      // Distinct reporters: the unique key (target, reporter) makes every OPEN row one reporter.
      const open = await tx.report.count({ where: { targetType: input.targetType, targetId: input.targetId, status: "OPEN" } });
      let hidden = false;
      if (open >= threshold) {
        const hold = await tx.moderationHold.createMany({ data: [{ targetType: input.targetType, targetId: input.targetId }], skipDuplicates: true });
        if (hold.count === 1) {
          hidden = await target.hide(tx, input.targetId);
          if (hidden) await this.audit.record(tx, { actorId: null, action: "moderation.autohide", targetType: input.targetType.toLowerCase(), targetId: input.targetId, before: { reports: open - 1 }, after: { reports: open, threshold } });
          else await tx.moderationHold.deleteMany({ where: { targetType: input.targetType, targetId: input.targetId } });
        }
      }
      return { id: row.id, created: true, hidden };
    }, TX_OPTIONS);

    if (outcome.hidden) {
      await this.notify(owner, { type: "moderation.hidden", title: "Your content is under review", body: "Several people reported your content, so it is hidden until a moderator has looked at it.", data: { targetType: input.targetType, targetId: input.targetId } });
    }
    return { id: outcome.id, created: outcome.created };
  }

  /** Open reports grouped by content, longest waiting first. */
  async queue(filter: { type?: ReportTargetType }, page: PageQuery): Promise<{ items: QueueItem[]; nextCursor: string | null }> {
    const after = decodeCursor(page.cursor);
    const typeFilter = filter.type ? Prisma.sql`AND "targetType" = ${filter.type}::"ReportTargetType"` : Prisma.empty;
    const afterFilter = after ? Prisma.sql`HAVING (MIN("createdAt"), "targetType"::text, "targetId") > (${after.t}, ${after.type}, ${after.id})` : Prisma.empty;
    const groups = await this.prisma.$queryRaw<{ targetType: ReportTargetType; targetId: string; reports: number; firstAt: Date; lastAt: Date }[]>(Prisma.sql`
      SELECT "targetType", "targetId", COUNT(*)::int AS "reports", MIN("createdAt") AS "firstAt", MAX("createdAt") AS "lastAt"
      FROM "reports" WHERE "status" = 'OPEN' ${typeFilter}
      GROUP BY "targetType", "targetId" ${afterFilter}
      ORDER BY MIN("createdAt") ASC, "targetType"::text ASC, "targetId" ASC
      LIMIT ${page.limit + 1}`);
    const shown = groups.slice(0, page.limit);
    const items = await Promise.all(shown.map((g) => this.queueItem(g)));
    const last = shown[shown.length - 1];
    return { items, nextCursor: groups.length > page.limit && last ? encodeCursor({ t: last.firstAt, type: last.targetType, id: last.targetId }) : null };
  }

  /** Upheld: the content is removed, every open report on it is closed as UPHELD and the author gets ONE strike (three active strikes bar them from posting for a week). */
  async uphold(meta: ActionMeta, type: ReportTargetType, id: string, rawNote: string): Promise<DecisionView> {
    const target = this.targetFor(type);
    const owner = await this.assertMayDecide(target, id, meta.actorId);
    if (!owner) throw new AppError("TARGET_GONE", 409, "This content no longer exists; dismiss the reports instead");
    const note = cleanNote(rawNote, DECISION_NOTE_MAX);
    const now = this.clock.now();

    const result = await this.prisma.$transaction(async (tx): Promise<DecisionView> => {
      await this.lock(tx, type, id);
      const open = await tx.report.findMany({ where: { targetType: type, targetId: id, status: "OPEN" }, orderBy: { id: "asc" }, select: { id: true } });
      if (open.length === 0) throw noOpenReports();
      await tx.report.updateMany({ where: { targetType: type, targetId: id, status: "OPEN" }, data: { status: "UPHELD", decidedBy: meta.actorId, decidedAt: now, decisionNote: note } });
      await target.remove(tx, id);
      await tx.moderationHold.deleteMany({ where: { targetType: type, targetId: id } });

      const strike = await tx.strike.create({ data: { userId: owner, reportId: open[0].id, createdAt: now, expiresAt: new Date(now.getTime() + STRIKE_LIFETIME_DAYS * DAY_MS) } });
      const active = await tx.strike.count({ where: { userId: owner, expiresAt: { gt: now } } });
      let restrictedUntil: Date | null = null;
      if (active >= STRIKES_FOR_BAN) {
        restrictedUntil = new Date(now.getTime() + BAN_DAYS * DAY_MS);
        const current = await tx.userRestriction.findUnique({ where: { userId: owner } });
        if (current && current.until.getTime() > restrictedUntil.getTime()) restrictedUntil = current.until;
        await tx.userRestriction.upsert({
          where: { userId: owner },
          create: { userId: owner, until: restrictedUntil, reason: `${active} active strikes` },
          update: { until: restrictedUntil, reason: `${active} active strikes` },
        });
      }
      await this.audit.record(tx, {
        actorId: meta.actorId,
        ip: meta.ip,
        requestId: meta.requestId,
        action: "moderation.uphold",
        targetType: type.toLowerCase(),
        targetId: id,
        before: { openReports: open.length },
        after: { removed: true, note, strikeId: strike.id, ownerId: owner, activeStrikes: active, restrictedUntil: restrictedUntil?.toISOString() ?? null },
      });
      return { targetType: type, targetId: id, decision: "UPHELD", reports: open.length, strike: { id: strike.id, expiresAt: strike.expiresAt.toISOString() }, restrictedUntil: restrictedUntil?.toISOString() ?? null, restored: false };
    }, TX_OPTIONS);

    await this.notify(owner, { type: "moderation.removed", title: "Your content was removed", body: "A moderator found that your content breaks the rules and removed it. You received a strike.", data: { targetType: type, targetId: id } });
    await this.notify(owner, { type: "moderation.strike", title: "You received a strike", body: "Strikes expire after 90 days. Three active strikes bar you from posting reels and comments for 7 days.", data: { strikeId: result.strike?.id } });
    if (result.restrictedUntil) {
      await this.notify(owner, { type: "moderation.restricted", title: "You cannot post for a while", body: `You cannot post reels or comments until ${result.restrictedUntil}.`, data: { until: result.restrictedUntil } });
    }
    return result;
  }

  /** Dismissed: open reports are closed; content the threshold held back comes back. No strike. */
  async dismiss(meta: ActionMeta, type: ReportTargetType, id: string, rawNote: string): Promise<DecisionView> {
    const target = this.targetFor(type);
    const owner = await this.assertMayDecide(target, id, meta.actorId);
    const note = cleanNote(rawNote, DECISION_NOTE_MAX);
    const now = this.clock.now();

    const result = await this.prisma.$transaction(async (tx): Promise<DecisionView> => {
      await this.lock(tx, type, id);
      const open = await tx.report.count({ where: { targetType: type, targetId: id, status: "OPEN" } });
      if (open === 0) throw noOpenReports();
      await tx.report.updateMany({ where: { targetType: type, targetId: id, status: "OPEN" }, data: { status: "DISMISSED", decidedBy: meta.actorId, decidedAt: now, decisionNote: note } });
      const held = await tx.moderationHold.deleteMany({ where: { targetType: type, targetId: id } });
      const restored = held.count === 1 ? await target.restore(tx, id) : false;
      await this.audit.record(tx, {
        actorId: meta.actorId,
        ip: meta.ip,
        requestId: meta.requestId,
        action: "moderation.dismiss",
        targetType: type.toLowerCase(),
        targetId: id,
        before: { openReports: open },
        after: { restored, note },
      });
      return { targetType: type, targetId: id, decision: "DISMISSED", reports: open, strike: null, restrictedUntil: null, restored };
    }, TX_OPTIONS);

    if (result.restored && owner) {
      await this.notify(owner, { type: "moderation.restored", title: "Your content is back", body: "A moderator reviewed the reports and your content is visible again.", data: { targetType: type, targetId: id } });
    }
    return result;
  }

  private targetFor(type: ReportTargetType): ModerationTarget {
    const target = this.registry.get(type);
    if (!target) throw new AppError("REPORT_TARGET_UNSUPPORTED", 400, "This kind of content cannot be reported");
    return target;
  }

  /** Moderators do not decide on their own content, nor on content in a course they author. Returns the content's owner (null when it is gone). */
  private async assertMayDecide(target: ModerationTarget, id: string, actorId: string): Promise<string | null> {
    const owner = await target.ownerOf(id);
    if (owner === actorId || (await target.conflictsWith?.(id, actorId))) throw selfModeration();
    return owner;
  }

  private async queueItem(g: { targetType: ReportTargetType; targetId: string; reports: number; firstAt: Date; lastAt: Date }): Promise<QueueItem> {
    const target = this.registry.get(g.targetType);
    const [reasons, hold, ownerId, preview] = await Promise.all([
      this.prisma.report.groupBy({ by: ["reason"], where: { targetType: g.targetType, targetId: g.targetId, status: "OPEN" }, _count: { _all: true } }),
      this.prisma.moderationHold.findUnique({ where: { targetType_targetId: { targetType: g.targetType, targetId: g.targetId } } }),
      target ? target.ownerOf(g.targetId) : null,
      target?.preview ? target.preview(g.targetId) : null,
    ]);
    return {
      targetType: g.targetType,
      targetId: g.targetId,
      ownerId,
      reportCount: g.reports,
      reasons: Object.fromEntries(reasons.map((r) => [r.reason, r._count._all])),
      firstReportedAt: g.firstAt.toISOString(),
      lastReportedAt: g.lastAt.toISOString(),
      autoHidden: hold !== null,
      preview,
    };
  }

  private lock(tx: Prisma.TransactionClient, type: ReportTargetType, id: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`moderation:${type}:${id}`}))`;
  }

  /** Best effort: a failed notification never undoes a decision. */
  private async notify(userId: string, input: Parameters<NotificationsService["notify"]>[1]): Promise<void> {
    try {
      await this.notifications.notify(userId, input);
    } catch (err) {
      this.logger.error(`could not notify user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

interface QueueCursor {
  t: Date;
  type: string;
  id: string;
}

const encodeCursor = (c: QueueCursor) => Buffer.from(`${c.t.toISOString()}|${c.type}|${c.id}`).toString("base64url");
function decodeCursor(raw: string | undefined): QueueCursor | null {
  if (!raw) return null;
  const [at, type, id] = Buffer.from(raw, "base64url").toString().split("|");
  const t = new Date(at ?? "");
  if (!type || !id || Number.isNaN(t.getTime()) || !(REPORT_TARGET_TYPES as readonly string[]).includes(type)) {
    throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { cursor: ["invalid"] } });
  }
  return { t, type, id };
}
