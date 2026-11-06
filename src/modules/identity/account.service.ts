import { Injectable } from "@nestjs/common";
import type { Prisma, UserStatus } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { escapeLike } from "../../common/db/like";
import { PrismaService } from "../../common/prisma/prisma.service";

export interface Account {
  id: string;
  email: string;
  status: UserStatus;
}

export interface AccountDetail extends Account {
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

const detailSelect = { id: true, email: true, status: true, emailVerifiedAt: true, createdAt: true } as const;

/** Read access to the identity-owned user row for other modules. */
@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async findEmail(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    return user?.email ?? null;
  }

  async findIdByEmail(email: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true } });
    return user?.id ?? null;
  }

  async get(userId: string): Promise<Account> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, status: true } });
    if (!user) throw new AppError("AUTH_TOKEN_INVALID", 401, "Invalid access token");
    return user;
  }

  async find(userId: string): Promise<AccountDetail | null> {
    return this.prisma.user.findUnique({ where: { id: userId }, select: detailSelect });
  }

  /** Newest first. */
  async getMany(userIds: string[]): Promise<AccountDetail[]> {
    if (userIds.length === 0) return [];
    return this.prisma.user.findMany({ where: { id: { in: userIds } }, select: detailSelect, orderBy: { id: "desc" } });
  }

  /** User ids, newest first, strictly below `cursor`. */
  async listIds(cursor: string | undefined, take: number): Promise<string[]> {
    const rows = await this.prisma.user.findMany({ where: cursor ? { id: { lt: cursor } } : {}, select: { id: true }, orderBy: { id: "desc" }, take });
    return rows.map((r) => r.id);
  }

  /** Ids of ACTIVE accounts in id order, strictly above `cursor`: a stable walk over a large audience, one bounded page at a time. */
  async activeIdsAfter(cursor: string | undefined, take: number): Promise<string[]> {
    const rows = await this.prisma.user.findMany({ where: { status: "ACTIVE", ...(cursor ? { id: { gt: cursor } } : {}) }, select: { id: true }, orderBy: { id: "asc" }, take });
    return rows.map((r) => r.id);
  }

  /** Index-backed prefix match (users_email_pattern_idx, text_pattern_ops). `prefix` must already be lower-case: emails are stored lower-case. */
  async idsByEmailPrefix(prefix: string, cursor: string | undefined, take: number): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { email: { startsWith: escapeLike(prefix) }, ...(cursor ? { id: { lt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: "desc" },
      take,
    });
    return rows.map((r) => r.id);
  }

  async filterByStatus(userIds: string[], status: UserStatus): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.prisma.user.findMany({ where: { id: { in: userIds }, status }, select: { id: true } });
    const keep = new Set(rows.map((r) => r.id));
    return userIds.filter((id) => keep.has(id));
  }

  /**
   * Moves the user to `to` inside the caller's transaction (so the audit row commits with it). The row is locked first, so
   * concurrent transitions are serialised. Returns the previous status, or null if the user does not exist; throws USER_DELETED when a deleted account would be revived.
   */
  async changeStatus(tx: Prisma.TransactionClient, userId: string, to: UserStatus): Promise<UserStatus | null> {
    const rows = await tx.$queryRaw<{ status: UserStatus }[]>`SELECT "status" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    if (rows.length === 0) return null;
    const from = rows[0].status;
    if (from === "DELETED" && to !== "DELETED") throw new AppError("USER_DELETED", 409, "The account has been deleted");
    if (from !== to) await tx.user.update({ where: { id: userId }, data: { status: to } });
    return from;
  }
}
