import { Injectable } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { ProfilesService, toSummary } from "./profiles.service";

@Injectable()
export class FollowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
  ) {}

  /** Idempotent: counters move only when a row is actually inserted. */
  async follow(followerId: string, handle: string): Promise<void> {
    const target = await this.profiles.getByHandle(handle);
    if (target.userId === followerId) throw new AppError("FOLLOW_SELF", 400, "You cannot follow yourself");
    await this.profiles.ensure(followerId);

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

  /** Everyone this user follows (newest follow first), capped: the following feed filters on this list. */
  async followeeIds(followerId: string, max = 5000): Promise<string[]> {
    const rows = await this.prisma.follow.findMany({ where: { followerId }, orderBy: { createdAt: "desc" }, take: max, select: { followeeId: true } });
    return rows.map((r) => r.followeeId);
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    return (await this.prisma.follow.count({ where: { followerId, followeeId } })) > 0;
  }

  // Ordered by the other party's user id (UUIDv7, so roughly by account age): the cursor is that id, which is unique per list.
  async followers(handle: string, page: PageQuery) {
    const target = await this.profiles.getByHandle(handle);
    const rows = await this.prisma.follow.findMany({
      where: { followeeId: target.userId, ...(page.cursor ? { followerId: { gt: page.cursor } } : {}) },
      orderBy: { followerId: "asc" },
      take: page.limit + 1,
      include: { follower: true },
    });
    return toPage(rows.map((r) => ({ ...toSummary(r.follower) })), page.limit);
  }

  async following(handle: string, page: PageQuery) {
    const target = await this.profiles.getByHandle(handle);
    const rows = await this.prisma.follow.findMany({
      where: { followerId: target.userId, ...(page.cursor ? { followeeId: { gt: page.cursor } } : {}) },
      orderBy: { followeeId: "asc" },
      take: page.limit + 1,
      include: { followee: true },
    });
    return toPage(rows.map((r) => ({ ...toSummary(r.followee) })), page.limit);
  }

}
