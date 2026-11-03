import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AccountService } from "../identity/account.service";
import { MailService } from "../mail/mail.service";
import type { MailData, MailTemplate } from "../mail/mail.types";
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

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly mail: MailService,
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

  async list(userId: string, page: PageQuery, unreadOnly: boolean) {
    const rows = await this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { readAt: null } : {}), ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: "desc" }, // UUIDv7: id order is time order
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: items.map(toView), nextCursor };
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    return { count: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
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
