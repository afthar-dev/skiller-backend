import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AccountService } from "../identity";
import { MailService } from "../mail";
import type { MailData, MailTemplate } from "../mail";
import { NotificationFilters } from "./notification-filters";
import { defaultPreference, NOTIFICATION_TYPE_KEYS, type EffectivePreference, type NotificationType } from "./notification-types";

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  data?: Record<string, unknown>;
  /** Sent only if the recipient's `email` preference for this type is on. `to` skips the address lookup when the caller already has it. */
  email?: { [T in MailTemplate]: { template: T; data: MailData[T]; to?: string } }[MailTemplate];
  /**
   * Outbox event id. Makes notify() idempotent: the in-app row is unique per (userId, sourceEventId) and the mail job carries a key
   * derived from it, so an at-least-once redelivery neither duplicates the row nor the mail. Handlers must always pass it.
   */
  sourceEventId?: string;
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  data: unknown;
  readAt: string | null;
  createdAt: string;
}

const toView = (n: { id: string; type: string; title: string; body: string; link: string | null; data: unknown; readAt: Date | null; createdAt: Date }): NotificationView => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  link: n.link,
  data: n.data,
  readAt: n.readAt?.toISOString() ?? null,
  createdAt: n.createdAt.toISOString(),
});

/** Rows read per round when a page skips hidden notifications, and how many rounds a single request may spend. */
const MAX_ROUNDS = 20;
const COUNT_BATCH = 500;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly mail: MailService,
    private readonly filters: NotificationFilters,
  ) {}

  async preferenceFor(userId: string, type: NotificationType): Promise<EffectivePreference> {
    const row = await this.prisma.notificationPreference.findUnique({ where: { userId_type: { userId, type } } });
    return row ? { type, inApp: row.inApp, email: row.email } : defaultPreference(type);
  }

  /** Writes the in-app row and/or queues the email according to the user's preferences. Safe to call again with the same sourceEventId. */
  async notify(userId: string, input: NotifyInput): Promise<void> {
    const pref = await this.preferenceFor(userId, input.type);

    if (pref.inApp) {
      await this.prisma.notification.createMany({
        data: [
          {
            userId,
            type: input.type,
            title: input.title,
            body: input.body,
            link: input.link ?? null,
            data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
            sourceEventId: input.sourceEventId ?? null,
          },
        ],
        skipDuplicates: true,
      });
    }

    if (pref.email && input.email) {
      const to = input.email.to ?? (await this.accounts.findEmail(userId));
      if (to) {
        // Queued even when the row already existed: a crash between the insert and the enqueue must not lose the mail on
        // redelivery. The idempotency key makes the repeat a no-op.
        await this.mail.send(input.email.template, to, input.email.data as never, {
          idempotencyKey: input.sourceEventId ? `${input.sourceEventId}-${userId}-${input.type}` : undefined,
        });
      }
    }
  }

  /**
   * Notifications about content moderation took down, or people the user blocked, are left out. Hidden rows are skipped while reading, so a page is
   * full whenever enough shown rows exist; the cursor is the id of the last shown row of the page, so pages never repeat or skip a shown row.
   */
  async list(userId: string, page: PageQuery, unreadOnly: boolean) {
    const batch = Math.max(50, page.limit * 2);
    const shown: Awaited<ReturnType<typeof this.fetchBatch>> = [];
    let cursor = page.cursor;
    for (let round = 0; round < MAX_ROUNDS && shown.length <= page.limit; round++) {
      const rows = await this.fetchBatch(userId, unreadOnly, cursor, batch + 1);
      const scan = rows.slice(0, batch);
      const hidden = await this.filters.hidden(userId, scan);
      for (const n of scan) if (!hidden.has(n.id)) shown.push(n);
      if (rows.length <= batch) return { items: shown.slice(0, page.limit).map(toView), nextCursor: shown.length > page.limit ? shown[page.limit - 1].id : null };
      cursor = scan[scan.length - 1].id;
    }
    // Scan budget spent (a very long run of hidden rows): hand back what was found and continue from where the scan stopped.
    const items = shown.slice(0, page.limit);
    return { items: items.map(toView), nextCursor: shown.length > page.limit ? items[items.length - 1].id : cursor ?? null };
  }

  private fetchBatch(userId: string, unreadOnly: boolean, cursor: string | undefined, take: number) {
    return this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { readAt: null } : {}), ...(cursor ? { id: { lt: cursor } } : {}) },
      orderBy: { id: "desc" }, // UUIDv7: id order is time order
      take,
    });
  }

  /** What the list would show as unread: types no filter touches are one SQL count, the rest are checked row by row. */
  async unreadCount(userId: string): Promise<{ count: number }> {
    const filtered = this.filters.filteredTypes();
    let count = await this.prisma.notification.count({ where: { userId, readAt: null, ...(filtered.length ? { type: { notIn: filtered } } : {}) } });
    if (filtered.length === 0) return { count };
    let after: string | undefined;
    for (;;) {
      const rows = await this.prisma.notification.findMany({
        where: { userId, readAt: null, type: { in: filtered }, ...(after ? { id: { lt: after } } : {}) },
        orderBy: { id: "desc" },
        take: COUNT_BATCH,
      });
      if (rows.length === 0) break;
      const hidden = await this.filters.hidden(userId, rows);
      count += rows.length - hidden.size;
      if (rows.length < COUNT_BATCH) break;
      after = rows[rows.length - 1].id;
    }
    return { count };
  }

  /** Idempotent. Another user's (or an unknown) id is a 404, never a hint that the row exists. */
  async markRead(userId: string, id: string): Promise<NotificationView> {
    await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    const row = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!row) throw new AppError("NOTIFICATION_NOT_FOUND", 404, "Notification not found");
    return toView(row);
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: res.count };
  }

  async listPreferences(userId: string): Promise<{ items: EffectivePreference[] }> {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    const byType = new Map(rows.map((r) => [r.type, r]));
    return {
      items: NOTIFICATION_TYPE_KEYS.map((type) => {
        const r = byType.get(type);
        return r ? { type, inApp: r.inApp, email: r.email } : defaultPreference(type);
      }),
    };
  }

  /** Partial update: a field left out keeps its current effective value. */
  async updatePreferences(userId: string, items: { type: NotificationType; inApp?: boolean; email?: boolean }[]) {
    await this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        const row = await tx.notificationPreference.findUnique({ where: { userId_type: { userId, type: item.type } } });
        const current = row ?? defaultPreference(item.type);
        const inApp = item.inApp ?? current.inApp;
        const email = item.email ?? current.email;
        await tx.notificationPreference.upsert({
          where: { userId_type: { userId, type: item.type } },
          create: { userId, type: item.type, inApp, email },
          update: { inApp, email },
        });
      }
    });
    return this.listPreferences(userId);
  }
}
