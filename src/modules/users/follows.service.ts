import { Injectable } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { Prisma, Profile } from "@prisma/client";
import { UserBlocks } from "../moderation";
import { ProfilesService } from "./profiles.service";

@Injectable()
export class FollowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly blocks: UserBlocks,
  ) {}

  /** Idempotent: counters move only when a row is actually inserted. */
  async follow(followerId: string, handle: string): Promise<void> {
    const target = await this.profiles.getByHandle(handle);
    if (target.userId === followerId) throw new AppError("FOLLOW_SELF", 400, "You cannot follow yourself");
    await this.profiles.ensure(followerId);
    // A block works both ways: neither side can follow the other.
    if (await this.blocks.isBlockedEitherWay(followerId, target.userId)) throw new AppError("FOLLOW_BLOCKED", 403, "You cannot follow this member");

    await this.prisma.$transaction(async (tx) => {
      const created = await tx.follow.createMany({ data: [{ followerId, followeeId: target.userId }], skipDuplicates: true });
      if (created.count === 0) return;
      await tx.profile.update({ where: { userId: target.userId }, data: { followersCount: { increment: 1 } } });
      await tx.profile.update({ where: { userId: followerId }, data: { followingCount: { increment: 1 } } });
    });
  }

  /** Idempotent: unfollowing someone you do not follow changes nothing. */
  async unfollow(followerId: string, handle: string): Promise<void> {
    const target = await this.profiles.getByHandle(handle);
    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.follow.deleteMany({ where: { followerId, followeeId: target.userId } });
      if (removed.count === 0) return;
      await tx.profile.update({ where: { userId: target.userId }, data: { followersCount: { decrement: 1 } } });
      await tx.profile.update({ where: { userId: followerId }, data: { followingCount: { decrement: 1 } } });
    });
  }

  /** Removes the follow between two users in both directions inside `tx` and fixes the counters (a block ends any follow). */
  async removeBetween(tx: Prisma.TransactionClient, a: string, b: string): Promise<void> {
    for (const [followerId, followeeId] of [[a, b], [b, a]] as const) {
      const removed = await tx.follow.deleteMany({ where: { followerId, followeeId } });
      if (removed.count === 0) continue;
      await tx.profile.updateMany({ where: { userId: followeeId, followersCount: { gt: 0 } }, data: { followersCount: { decrement: 1 } } });
      await tx.profile.updateMany({ where: { userId: followerId, followingCount: { gt: 0 } }, data: { followingCount: { decrement: 1 } } });
    }
  }

  /** Everyone this user follows (newest follow first), capped: the following feed filters on this list. */
  async followeeIds(followerId: string, max = 5000): Promise<string[]> {
    const rows = await this.prisma.follow.findMany({ where: { followerId }, orderBy: { createdAt: "desc" }, take: max, select: { followeeId: true } });
    return rows.map((r) => r.followeeId);
  }

  /** How many members started following `userId` in [from, to). */
  async newFollowers(userId: string, from: Date, to: Date): Promise<number> {
    return this.prisma.follow.count({ where: { followeeId: userId, createdAt: { gte: from, lt: to } } });
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    return (await this.prisma.follow.count({ where: { followerId, followeeId } })) > 0;
  }

  // Ordered by the other party's user id (UUIDv7, so roughly by account age): the cursor is that id, which is unique per list.
  async followers(handle: string, page: PageQuery) {
    const target = await this.profiles.getByHandle(handle);
    return this.visiblePage(page, async (after, take) => {
      const rows = await this.prisma.follow.findMany({
        where: { followeeId: target.userId, ...(after ? { followerId: { gt: after } } : {}) },
        orderBy: { followerId: "asc" },
        take,
        include: { follower: true },
      });
      return rows.map((r) => r.follower);
    });
  }

  async following(handle: string, page: PageQuery) {
    const target = await this.profiles.getByHandle(handle);
    return this.visiblePage(page, async (after, take) => {
      const rows = await this.prisma.follow.findMany({
        where: { followerId: target.userId, ...(after ? { followeeId: { gt: after } } : {}) },
        orderBy: { followeeId: "asc" },
        take,
        include: { followee: true },
      });
      return rows.map((r) => r.followee);
    });
  }

  /**
   * A page of the profiles `fetch` yields in user-id order, without the suspended and deleted ones. Hidden members would otherwise leave
   * short pages (or empty ones with a cursor), so it keeps reading batches until the page and the one-extra row that signals more are full.
   */
  private async visiblePage(page: PageQuery, fetch: (after: string | undefined, take: number) => Promise<Profile[]>) {
    const take = page.limit + 1;
    const visible: Profile[] = [];
    let after = page.cursor;
    while (visible.length < take) {
      const batch = await fetch(after, take);
      const active = await this.profiles.activeIds(batch.map((p) => p.userId));
      visible.push(...batch.filter((p) => active.has(p.userId)));
      if (batch.length < take) break;
      after = batch[batch.length - 1].userId;
    }
    return toPage(await this.profiles.summarize(visible), page.limit);
  }

}
