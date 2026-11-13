import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type Message } from "@prisma/client";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { badCursor, SignedCursor } from "../../common/http/signed-cursor";
import type { PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { REDIS } from "../../common/redis/redis.constants";
import { GigLookup, GIG_PAYMENT_NOTICE } from "../gigs";
import { UserStatusCache } from "../identity";
import { PostingRestrictions, UserBlocks } from "../moderation";
import { FollowsService, ProfilesService, type ProfileSummary } from "../users";
import { MessageStreamHub } from "./message-stream.hub";
import { toMessageView, type ConversationView, type MessageView } from "./message-view";
import { MessagingNotifier } from "./messaging-notifier";
import { conversationNotFound, messagingNotAllowed, messagingSelf, MESSAGES_PER_HOUR, NEW_CONVERSATIONS_PER_DAY, pairKeyOf } from "./messaging-rules";

const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;
const LIST_CURSOR = "conversations";
/** A unique-key clash on (senderId, clientMessageId): the same key arrived twice at once. */
const isClientMessageIdConflict = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && JSON.stringify(err.meta?.target ?? "").includes("clientMessageId");
const messagesCursor = (conversationId: string) => `messages:${conversationId}`;

interface ListRow {
  id: string;
  gigId: string | null;
  lastMessageAt: Date;
  archivedAt: Date | null;
  unreadCount: number;
}

/**
 * One-to-one text conversations. A conversation belongs to its two participants and to nobody else: every read and write goes through
 * `participation()`, and anyone else gets the same 404 as for an id that does not exist.
 *
 * Who may write to whom is decided in one place (`assertReachable`) and answered with one error (MESSAGING_NOT_ALLOWED), so a refusal never says whether
 * it was a block, the recipient's setting or their account. It runs on every send, not only when a conversation starts: a block ends the conversation for
 * writing at once. The recipient's `allowMessagesFrom` is checked when a conversation STARTS (a gig inquiry reaches the seller of that live gig whatever
 * the setting, as plan decision 5 says; people who already talk to each other keep talking until one blocks the other).
 */
@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly follows: FollowsService,
    private readonly blocks: UserBlocks,
    private readonly restrictions: PostingRestrictions,
    private readonly statuses: UserStatusCache,
    private readonly gigs: GigLookup,
    private readonly hub: MessageStreamHub,
    private readonly notifier: MessagingNotifier,
    private readonly cursors: SignedCursor,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Get-or-create the conversation with `recipientHandle` and append the first message. With a `clientMessageId` that this sender used before, nothing is
   * added: the earlier message and its conversation come back (`replayed`), before any permission check or cap, so a retry never costs a slot.
   */
  async start(
    senderId: string,
    input: { recipientHandle: string; gigId?: string; message: string; clientMessageId?: string },
  ): Promise<{ created: boolean; replayed: boolean; conversation: ConversationView; message: MessageView }> {
    if (input.clientMessageId) {
      const prior = await this.priorMessage(senderId, input.clientMessageId);
      if (prior) return this.replayOfStart(senderId, prior);
    }
    const recipient = await this.profiles.getByHandleAnyStatus(input.recipientHandle);
    const recipientId = recipient.userId;
    if (recipientId === senderId) throw messagingSelf();
    if (input.gigId && !(await this.gigs.liveGigOf(input.gigId, recipientId))) throw new AppError("GIG_NOT_FOUND", 404, "Gig not found");

    await this.assertReachable(senderId, recipientId);
    const pairKey = pairKeyOf(senderId, recipientId);
    const existing = await this.prisma.conversation.findUnique({ where: { pairKey }, select: { id: true } });
    if (!existing && !input.gigId) {
      if (recipient.allowMessagesFrom === "NONE") throw messagingNotAllowed();
      if (recipient.allowMessagesFrom === "FOLLOWING" && !(await this.follows.isFollowing(recipientId, senderId))) throw messagingNotAllowed();
    }
    if (!existing) await this.cap(`msg:new:${senderId}`, NEW_CONVERSATIONS_PER_DAY, 86400, "new_conversations_per_day");
    await this.cap(`msg:hour:${senderId}`, MESSAGES_PER_HOUR, 3600, "messages_per_hour");

    const now = this.clock.now();
    let done: { conversationId: string; created: boolean; message: Message };
    try {
      done = await this.prisma.$transaction(async (tx) => {
        const made = await tx.conversation.createMany({ data: [{ pairKey, gigId: input.gigId ?? null, createdAt: now, lastMessageAt: now }], skipDuplicates: true });
        const row = await tx.conversation.findUniqueOrThrow({ where: { pairKey }, select: { id: true } });
        await tx.conversationParticipant.createMany({ data: [senderId, recipientId].map((userId) => ({ conversationId: row.id, userId })), skipDuplicates: true });
        if (input.gigId && made.count === 0) await tx.conversation.update({ where: { id: row.id }, data: { gigId: input.gigId } });
        return { conversationId: row.id, created: made.count === 1, message: await this.append(tx, row.id, senderId, input.message, now, input.clientMessageId) };
      }, TX_OPTIONS);
    } catch (err) {
      // A parallel request with the same key won: its message is the answer.
      const prior = input.clientMessageId && isClientMessageIdConflict(err) ? await this.priorMessage(senderId, input.clientMessageId) : null;
      if (!prior) throw err;
      return this.replayOfStart(senderId, prior);
    }

    await this.afterSend(done.message, recipientId);
    const [conversation] = await this.views(senderId, [done.conversationId]);
    return { created: done.created, replayed: false, conversation, message: toMessageView(done.message) };
  }

  /** Sends a message. A `clientMessageId` this sender used before returns the earlier message (`replayed`) and sends nothing more. */
  async send(senderId: string, conversationId: string, body: string, clientMessageId?: string): Promise<{ replayed: boolean; message: MessageView }> {
    const { otherId } = await this.participation(senderId, conversationId);
    if (clientMessageId) {
      const prior = await this.priorMessage(senderId, clientMessageId);
      if (prior) return this.replayOfSend(prior, conversationId);
    }
    await this.assertReachable(senderId, otherId);
    await this.cap(`msg:hour:${senderId}`, MESSAGES_PER_HOUR, 3600, "messages_per_hour");
    let message: Message;
    try {
      message = await this.prisma.$transaction((tx) => this.append(tx, conversationId, senderId, body, this.clock.now(), clientMessageId), TX_OPTIONS);
    } catch (err) {
      const prior = clientMessageId && isClientMessageIdConflict(err) ? await this.priorMessage(senderId, clientMessageId) : null;
      if (!prior) throw err;
      return this.replayOfSend(prior, conversationId);
    }
    await this.afterSend(message, otherId);
    return { replayed: false, message: toMessageView(message) };
  }

  /** My conversations, most recently active first. Archived ones only with `archived`. */
  async list(userId: string, opts: { archived: boolean }, page: PageQuery): Promise<{ items: ConversationView[]; nextCursor: string | null }> {
    let after = Prisma.empty;
    if (page.cursor) {
      const c = this.cursors.verify(LIST_CURSOR, page.cursor);
      const t = typeof c.t === "string" ? new Date(c.t) : new Date(NaN);
      if (typeof c.id !== "string" || Number.isNaN(t.getTime())) throw badCursor();
      after = Prisma.sql`AND (c."lastMessageAt", c."id") < (${t}, ${c.id})`;
    }
    const rows = await this.prisma.$queryRaw<ListRow[]>(Prisma.sql`
      SELECT c."id", c."gigId", c."lastMessageAt", p."archivedAt",
        (SELECT COUNT(*) FROM "messages" m
          WHERE m."conversationId" = c."id" AND m."senderId" <> ${userId} AND m."status" = 'VISIBLE'
            AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt"))::int AS "unreadCount"
      FROM "conversation_participants" p
      JOIN "conversations" c ON c."id" = p."conversationId"
      WHERE p."userId" = ${userId} AND (p."archivedAt" IS NOT NULL) = ${opts.archived} ${after}
      ORDER BY c."lastMessageAt" DESC, c."id" DESC
      LIMIT ${page.limit + 1}`);
    const shown = rows.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return {
      items: await this.viewsFor(userId, shown),
      nextCursor: rows.length > page.limit && last ? this.cursors.sign(LIST_CURSOR, { t: last.lastMessageAt.toISOString(), id: last.id }) : null,
    };
  }

  /**
   * Messages of one of my conversations. Newest first with a cursor to older ones; with `after` (the id of the newest message the client has) the
   * messages since then, oldest first: the polling fallback when the live stream is not available.
   */
  async messages(userId: string, conversationId: string, page: PageQuery, after?: string): Promise<{ items: MessageView[]; nextCursor: string | null }> {
    await this.participation(userId, conversationId);
    if (after !== undefined) {
      const rows = await this.prisma.message.findMany({ where: { conversationId, id: { gt: after } }, orderBy: { id: "asc" }, take: page.limit });
      return { items: rows.map(toMessageView), nextCursor: null };
    }
    let before: string | undefined;
    if (page.cursor) {
      const c = this.cursors.verify(messagesCursor(conversationId), page.cursor);
      if (typeof c.id !== "string") throw badCursor();
      before = c.id;
    }
    const rows = await this.prisma.message.findMany({ where: { conversationId, ...(before ? { id: { lt: before } } : {}) }, orderBy: { id: "desc" }, take: page.limit + 1 });
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return { items: items.map(toMessageView), nextCursor: rows.length > page.limit && last ? this.cursors.sign(messagesCursor(conversationId), { id: last.id }) : null };
  }

  /** Everything up to now (or to the newest message, if that was sent "later" than the clock) is read. Never moves backwards. */
  async markRead(userId: string, conversationId: string): Promise<{ conversationId: string; unreadCount: number }> {
    await this.participation(userId, conversationId);
    const { lastMessageAt } = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { lastMessageAt: true } });
    const upTo = new Date(Math.max(this.clock.now().getTime(), lastMessageAt.getTime()));
    await this.prisma.conversationParticipant.updateMany({ where: { conversationId, userId, OR: [{ lastReadAt: null }, { lastReadAt: { lt: upTo } }] }, data: { lastReadAt: upTo } });
    return { conversationId, unreadCount: 0 };
  }

  /** Visible messages from others after my lastReadAt, over all my conversations. */
  async unreadTotal(userId: string): Promise<{ count: number }> {
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count"
      FROM "conversation_participants" p
      JOIN "messages" m ON m."conversationId" = p."conversationId"
      WHERE p."userId" = ${userId} AND m."senderId" <> ${userId} AND m."status" = 'VISIBLE'
        AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")`;
    return { count: rows[0]?.count ?? 0 };
  }

  async setArchived(userId: string, conversationId: string, archived: boolean): Promise<void> {
    await this.participation(userId, conversationId);
    await this.prisma.conversationParticipant.updateMany({ where: { conversationId, userId }, data: { archivedAt: archived ? this.clock.now() : null } });
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The conversation if `userId` is one of its two participants, with the other one; otherwise the same 404 as for a conversation that does not exist. */
  private async participation(userId: string, conversationId: string): Promise<{ otherId: string }> {
    const rows = await this.prisma.conversationParticipant.findMany({ where: { conversationId }, select: { userId: true } });
    const ids = rows.map((r) => r.userId);
    if (!ids.includes(userId)) throw conversationNotFound();
    const otherId = ids.find((id) => id !== userId);
    if (!otherId) throw conversationNotFound();
    return { otherId };
  }

  /** May `senderId` write to `recipientId` right now? One answer for every "no" (see the class comment); the sender's own posting ban is their own business. */
  private async assertReachable(senderId: string, recipientId: string): Promise<void> {
    await this.restrictions.assertCanPost(senderId);
    if (await this.blocks.isBlockedEitherWay(senderId, recipientId)) throw messagingNotAllowed();
    if ((await this.statuses.get(recipientId)) !== "ACTIVE") throw messagingNotAllowed();
  }

  /** One slot of a rolling-window cap; the refusal says which cap it was. */
  private async cap(key: string, limit: number, windowSec: number, scope: string): Promise<void> {
    try {
      await consumeRateLimit(this.redis, key, limit, windowSec);
    } catch (err) {
      if (err instanceof AppError && err.code === "RATE_LIMITED") throw new AppError("RATE_LIMITED", 429, "You are sending messages too fast; try again later", { ...err.details, scope, limit });
      throw err;
    }
  }

  /**
   * Adds a message under the conversation's row lock. Times in a conversation strictly increase (a message is never stamped at or before the previous
   * one), so "created after lastReadAt" means exactly "unread" even for two messages in the same millisecond.
   */
  private async append(tx: Prisma.TransactionClient, conversationId: string, senderId: string, body: string, now: Date, clientMessageId?: string): Promise<Message> {
    const rows = await tx.$queryRaw<{ lastMessageAt: Date }[]>`SELECT "lastMessageAt" FROM "conversations" WHERE "id" = ${conversationId} FOR UPDATE`;
    const previous = rows[0]?.lastMessageAt;
    if (!previous) throw conversationNotFound();
    const createdAt = new Date(Math.max(now.getTime(), previous.getTime() + 1));
    const message = await tx.message.create({ data: { conversationId, senderId, body, createdAt, clientMessageId: clientMessageId ?? null } });
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: createdAt } });
    // A new message brings the conversation back into both inboxes.
    await tx.conversationParticipant.updateMany({ where: { conversationId, archivedAt: { not: null } }, data: { archivedAt: null } });
    return message;
  }

  /** The message this sender already sent with this key, if any. */
  private priorMessage(senderId: string, clientMessageId: string): Promise<Message | null> {
    return this.prisma.message.findUnique({ where: { senderId_clientMessageId: { senderId, clientMessageId } } });
  }

  private async replayOfStart(senderId: string, prior: Message) {
    const [conversation] = await this.views(senderId, [prior.conversationId]);
    if (!conversation) throw conversationNotFound();
    return { created: false, replayed: true, conversation, message: toMessageView(prior) };
  }

  private replayOfSend(prior: Message, conversationId: string): { replayed: true; message: MessageView } {
    if (prior.conversationId !== conversationId) throw new AppError("CLIENT_MESSAGE_ID_REUSED", 409, "That clientMessageId was used for another conversation");
    return { replayed: true, message: toMessageView(prior) };
  }

  /** After the commit, best effort: push to both sides' live streams (the sender's other devices too) and tell the recipient. */
  private async afterSend(message: Message, recipientId: string): Promise<void> {
    const view = toMessageView(message);
    const event = { event: "message", data: { conversationId: message.conversationId, message: view } };
    await Promise.all([this.hub.publish(message.senderId, event), this.hub.publish(recipientId, event)]);
    await this.notifier.newMessage(recipientId, message.senderId, message.conversationId);
  }

  private async views(userId: string, ids: string[]): Promise<ConversationView[]> {
    const rows = await this.prisma.$queryRaw<ListRow[]>`
      SELECT c."id", c."gigId", c."lastMessageAt", p."archivedAt",
        (SELECT COUNT(*) FROM "messages" m
          WHERE m."conversationId" = c."id" AND m."senderId" <> ${userId} AND m."status" = 'VISIBLE'
            AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt"))::int AS "unreadCount"
      FROM "conversation_participants" p JOIN "conversations" c ON c."id" = p."conversationId"
      WHERE p."userId" = ${userId} AND c."id" IN (${Prisma.join(ids)})`;
    return this.viewsFor(userId, rows);
  }

  /** Counterpart, gig and last message for a set of my conversations, in the order given. */
  private async viewsFor(userId: string, rows: ListRow[]): Promise<ConversationView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [others, lasts, gigs] = await Promise.all([
      this.prisma.conversationParticipant.findMany({ where: { conversationId: { in: ids }, userId: { not: userId } }, select: { conversationId: true, userId: true } }),
      this.prisma.$queryRaw<Message[]>`
        SELECT m.* FROM "conversations" c
        JOIN LATERAL (SELECT * FROM "messages" WHERE "conversationId" = c."id" ORDER BY "id" DESC LIMIT 1) m ON TRUE
        WHERE c."id" IN (${Prisma.join(ids)})`,
      this.gigs.visibleCards(userId, rows.flatMap((r) => (r.gigId ? [r.gigId] : []))),
    ]);
    const profiles = await this.profiles.summaries(others.map((o) => o.userId));
    const otherOf = new Map<string, ProfileSummary | null>(others.map((o) => [o.conversationId, profiles.get(o.userId) ?? null]));
    const lastOf = new Map(lasts.map((m) => [m.conversationId, m]));
    return rows.map((r) => {
      const last = lastOf.get(r.id);
      return {
        id: r.id,
        gigId: r.gigId,
        gig: r.gigId ? (gigs.get(r.gigId) ?? null) : null,
        paymentNotice: r.gigId ? GIG_PAYMENT_NOTICE : null,
        lastMessageAt: r.lastMessageAt.toISOString(),
        unreadCount: r.unreadCount,
        archived: r.archivedAt !== null,
        counterpart: otherOf.get(r.id) ?? null,
        lastMessage: last ? toMessageView(last) : null,
      };
    });
  }
}
