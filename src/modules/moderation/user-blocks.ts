import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";
import { PrismaService } from "../../common/prisma/prisma.service";
import { REDIS } from "../../common/redis/redis.constants";

export const RELATIONS_CACHE_TTL_SEC = 60;
// Same scheme as the permission cache: entries live under rel:{userId}:{epoch}; a change bumps the epoch of everyone it concerns, so a reader that
// loaded the database before the change and writes after it lands on an old-epoch key nobody reads again. Epoch keys have no TTL on purpose.
const epochKey = (userId: string) => `rel:epoch:${userId}`;
const cacheKey = (userId: string, epoch: number) => `rel:${userId}:${epoch}`;

/** What a viewer must not see: `blocked` = people they blocked plus people who blocked them (a block works both ways); `muted` = creators they muted. */
export interface ViewerRelations {
  blocked: Set<string>;
  muted: Set<string>;
}

export interface RelationPage {
  items: Array<{ userId: string; since: Date }>;
  nextCursor: string | null;
}

const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;

/**
 * Blocks and mutes. `relations()` is the one cached per-viewer lookup every read path uses (Redis, 60 s, epoch-keyed, busted on every change).
 * A block is symmetric in effect: either side sees nothing of the other.
 */
@Injectable()
export class UserBlocks {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async relations(viewerId: string | null): Promise<ViewerRelations> {
    if (!viewerId) return { blocked: new Set(), muted: new Set() };
    // Epoch first, then the database: anything changed after this read bumps the epoch past it.
    let epoch = 0;
    try {
      epoch = Number(await this.redis.get(epochKey(viewerId))) || 0;
      const cached = await this.redis.get(cacheKey(viewerId, epoch));
      if (cached) {
        const parsed = JSON.parse(cached) as { b: string[]; m: string[] };
        return { blocked: new Set(parsed.b), muted: new Set(parsed.m) };
      }
    } catch {
      // cache unavailable or corrupt: read through
    }
    const [mine, theirs, muted] = await Promise.all([
      this.prisma.userBlock.findMany({ where: { blockerId: viewerId }, select: { blockedId: true } }),
      this.prisma.userBlock.findMany({ where: { blockedId: viewerId }, select: { blockerId: true } }),
      this.prisma.userMute.findMany({ where: { userId: viewerId }, select: { mutedId: true } }),
    ]);
    const blocked = new Set([...mine.map((r) => r.blockedId), ...theirs.map((r) => r.blockerId)]);
    const mutedSet = new Set(muted.map((r) => r.mutedId));
    await this.redis.set(cacheKey(viewerId, epoch), JSON.stringify({ b: [...blocked], m: [...mutedSet] }), "EX", RELATIONS_CACHE_TTL_SEC).catch(() => undefined);
    return { blocked, muted: mutedSet };
  }

  async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    return (await this.relations(a)).blocked.has(b);
  }

  /** Blocks `blockedId`; `alsoInTx` runs in the same transaction (the users module removes follows both ways there). Idempotent. */
  async block(blockerId: string, blockedId: string, alsoInTx?: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.userBlock.createMany({ data: [{ blockerId, blockedId }], skipDuplicates: true });
      if (alsoInTx) await alsoInTx(tx);
    }, TX_OPTIONS);
    await this.changed(blockerId, blockedId);
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.prisma.userBlock.deleteMany({ where: { blockerId, blockedId } });
    await this.changed(blockerId, blockedId);
  }

  async mute(userId: string, mutedId: string): Promise<void> {
    await this.prisma.userMute.createMany({ data: [{ userId, mutedId }], skipDuplicates: true });
    await this.changed(userId);
  }

  async unmute(userId: string, mutedId: string): Promise<void> {
    await this.prisma.userMute.deleteMany({ where: { userId, mutedId } });
    await this.changed(userId);
  }

  /** People `userId` blocked (not the ones who blocked them), newest first. */
  async blockedBy(userId: string, page: { limit: number; cursor?: string }): Promise<RelationPage> {
    const after = decodeCursor(page.cursor);
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId: userId, ...(after ? { OR: [{ createdAt: { lt: after.t } }, { createdAt: after.t, blockedId: { lt: after.id } }] } : {}) },
      orderBy: [{ createdAt: "desc" }, { blockedId: "desc" }],
      take: page.limit + 1,
    });
    return toPage(rows.map((r) => ({ userId: r.blockedId, since: r.createdAt })), page.limit);
  }

  async mutedBy(userId: string, page: { limit: number; cursor?: string }): Promise<RelationPage> {
    const after = decodeCursor(page.cursor);
    const rows = await this.prisma.userMute.findMany({
      where: { userId, ...(after ? { OR: [{ createdAt: { lt: after.t } }, { createdAt: after.t, mutedId: { lt: after.id } }] } : {}) },
      orderBy: [{ createdAt: "desc" }, { mutedId: "desc" }],
      take: page.limit + 1,
    });
    return toPage(rows.map((r) => ({ userId: r.mutedId, since: r.createdAt })), page.limit);
  }

  private async changed(...userIds: string[]): Promise<void> {
    try {
      for (const id of new Set(userIds)) await this.redis.incr(epochKey(id));
    } catch {
      // The entries expire in 60 s anyway.
    }
  }
}

function toPage(rows: RelationPage["items"], limit: number): RelationPage {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? Buffer.from(`${last.since.toISOString()}|${last.userId}`).toString("base64url") : null };
}

function decodeCursor(raw: string | undefined): { t: Date; id: string } | null {
  if (!raw) return null;
  const [at, id] = Buffer.from(raw, "base64url").toString().split("|");
  const t = new Date(at ?? "");
  if (!id || Number.isNaN(t.getTime())) return null;
  return { t, id };
}
