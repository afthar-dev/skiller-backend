import { Injectable, Logger } from "@nestjs/common";
import type { UserStatus } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import type { PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AccountService } from "../identity";
import { SessionService } from "../identity";
import { UserStatusCache } from "../identity";
import { AuditService } from "../audit";
import { SUPER_ADMIN_ROLE_KEY } from "../rbac";
import { RolesService, type MutationMeta } from "../rbac";
import { ProfilesService } from "../users";

export interface UserSearch {
  q?: string;
  status?: UserStatus;
  role?: string;
}

const MAX_SCAN_ROUNDS = 5;

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly profiles: ProfilesService,
    private readonly roles: RolesService,
    private readonly sessions: SessionService,
    private readonly statuses: UserStatusCache,
    private readonly audit: AuditService,
  ) {}

  /**
   * Candidate ids come from an index-backed driver (email prefix + handle prefix, role holders, or the users PK), newest first;
   * the other filters are applied to each batch. The scan is bounded (MAX_SCAN_ROUNDS batches per request), so a request never
   * walks the table: a short page with a non-null nextCursor just means "keep paging".
   */
  async search(filter: UserSearch, page: PageQuery) {
    const want = page.limit + 1;
    const batchSize = Math.max(want * 2, 20);
    const q = filter.q?.trim().toLowerCase();
    const kept: string[] = [];
    let cursor = page.cursor;
    let exhausted = false;

    for (let round = 0; round < MAX_SCAN_ROUNDS && kept.length < want && !exhausted; round++) {
      const batch = await this.candidates(q, filter.role, cursor, batchSize);
      if (batch.length < batchSize) exhausted = true;
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1];
      let ids = batch;
      if (filter.status) ids = await this.accounts.filterByStatus(ids, filter.status);
      if (filter.role && q) ids = await this.roles.filterByPlatformRole(ids, filter.role);
      kept.push(...ids);
    }

    const items = kept.slice(0, page.limit);
    const hasMore = kept.length > page.limit;
    const nextCursor = hasMore ? items[items.length - 1] : exhausted ? null : (cursor ?? null);
    return { items: await this.hydrate(items), nextCursor };
  }

  private async candidates(q: string | undefined, role: string | undefined, cursor: string | undefined, take: number): Promise<string[]> {
    if (q) {
      const [byEmail, byHandle] = await Promise.all([this.accounts.idsByEmailPrefix(q, cursor, take), this.profiles.idsByHandlePrefix(q, cursor, take)]);
      return [...new Set([...byEmail, ...byHandle])].sort((a, b) => (a < b ? 1 : -1)).slice(0, take);
    }
    if (role) return this.roles.userIdsWithPlatformRole(role, cursor, take);
    return this.accounts.listIds(cursor, take);
  }

  private async hydrate(ids: string[]) {
    const [accounts, profiles, roles] = await Promise.all([this.accounts.getMany(ids), this.profiles.summaries(ids), this.roles.platformRoleKeysMany(ids)]);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return ids.flatMap((id) => {
      const a = byId.get(id);
      if (!a) return [];
      const p = profiles.get(id);
      return [{ id, email: a.email, status: a.status, handle: p?.handle ?? null, displayName: p?.displayName ?? null, roles: roles.get(id) ?? [], createdAt: a.createdAt.toISOString() }];
    });
  }

  async detail(userId: string) {
    const account = await this.accounts.find(userId);
    if (!account) throw this.notFound();
    const [profiles, grants, activeSessions, audit] = await Promise.all([
      this.profiles.summaries([userId]),
      this.roles.listUserGrants(userId),
      this.sessions.countActive(userId),
      this.audit.list({ targetType: "user", targetId: userId }, { limit: 20 }),
    ]);
    return {
      user: { id: account.id, email: account.email, status: account.status, emailVerifiedAt: account.emailVerifiedAt?.toISOString() ?? null, createdAt: account.createdAt.toISOString() },
      profile: profiles.get(userId) ?? null,
      roles: grants,
      activeSessions,
      recentAudit: audit.items,
    };
  }

  /**
   * Ruling: the status change and its audit row commit first and are never rolled back. A suspended user is then blocked by
   * AuthGuard as soon as the status cache is busted (it reads the committed status); revoking sessions closes the remaining
   * access-token window. If the bust or the revocation fails (Redis down) the request answers 503 but the suspension stands;
   * repeating the call is idempotent and finishes the job (no second audit row). Rolling back instead would un-suspend a user
   * because of an infrastructure fault, which is the wrong failure direction.
   */
  async suspend(actorId: string, targetId: string, reason: string, meta: MutationMeta = {}) {
    if (actorId === targetId) throw new AppError("ADMIN_SELF_ACTION", 403, "You cannot suspend your own account");
    if (!(await this.accounts.find(targetId))) throw this.notFound();
    if ((await this.roles.platformRoleKeys(targetId)).includes(SUPER_ADMIN_ROLE_KEY) && !(await this.roles.platformRoleKeys(actorId)).includes(SUPER_ADMIN_ROLE_KEY)) {
      throw new AppError("ROLE_ESCALATION_DENIED", 403, "Only a super admin can suspend a super admin");
    }

    const previous = await this.prisma.$transaction(async (tx) => {
      const from = await this.accounts.changeStatus(tx, targetId, "SUSPENDED");
      if (from === null) throw this.notFound();
      if (from !== "SUSPENDED") {
        await this.audit.record(tx, { actorId, action: "user.suspend", targetType: "user", targetId, before: { status: from }, after: { status: "SUSPENDED", reason }, ...meta });
      }
      return from;
    });

    await this.enforceSuspension(targetId);
    return { id: targetId, status: "SUSPENDED" as const, changed: previous !== "SUSPENDED" };
  }

  async unsuspend(actorId: string, targetId: string, meta: MutationMeta = {}) {
    if (actorId === targetId) throw new AppError("ADMIN_SELF_ACTION", 403, "You cannot change your own account status");
    if ((await this.roles.platformRoleKeys(targetId)).includes(SUPER_ADMIN_ROLE_KEY) && !(await this.roles.platformRoleKeys(actorId)).includes(SUPER_ADMIN_ROLE_KEY)) {
      throw new AppError("ROLE_ESCALATION_DENIED", 403, "Only a super admin can unsuspend a super admin");
    }
    const previous = await this.prisma.$transaction(async (tx) => {
      // changeStatus locks the row and throws USER_DELETED for a deleted account (the throw rolls back), so no unlocked pre-read.
      const from = await this.accounts.changeStatus(tx, targetId, "ACTIVE");
      if (from === null) throw this.notFound();
      if (from === "SUSPENDED") {
        await this.audit.record(tx, { actorId, action: "user.unsuspend", targetType: "user", targetId, before: { status: from }, after: { status: "ACTIVE" }, ...meta });
      }
      return from;
    });
    await this.bustStatus(targetId);
    return { id: targetId, status: "ACTIVE" as const, changed: previous === "SUSPENDED" };
  }

  async revokeSessions(actorId: string, targetId: string, meta: MutationMeta = {}) {
    if (!(await this.accounts.find(targetId))) throw this.notFound();
    const before = await this.sessions.countActive(targetId);
    await this.sessions.revokeAllForUser(targetId); // 503 SERVICE_UNAVAILABLE when Redis markers cannot be written; nothing is audited then
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actorId, action: "user.revoke_sessions", targetType: "user", targetId, before: { activeSessions: before }, after: { activeSessions: 0 }, ...meta }));
    return { id: targetId, revoked: before };
  }

  /**
   * Fail-closed: overwrite the cached status with SUSPENDED (falling back to DEL), and revoke sessions regardless of whether
   * the status write worked. Any failure surfaces as 503 once both were attempted; the suspension stays committed and repeating is safe.
   */
  private async enforceSuspension(userId: string) {
    const failures: unknown[] = [];
    try {
      await this.statuses.put(userId, "SUSPENDED");
    } catch {
      await this.bustStatus(userId).catch((err: unknown) => failures.push(err));
    }
    await this.sessions.revokeAllForUser(userId).catch((err: unknown) => failures.push(err));
    if (failures.length > 0) {
      throw failures.find((e): e is AppError => e instanceof AppError && e.status === 503) ?? failures[0];
    }
  }

  private async bustStatus(userId: string) {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.statuses.bust(userId);
        return;
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, 25 * attempt));
      }
    }
    this.logger.error(`could not bust status cache for user ${userId}: ${(last as Error).message}`);
    throw new AppError("SERVICE_UNAVAILABLE", 503, "The account status is saved but could not be applied everywhere yet; repeat the request");
  }

  private notFound() {
    return new AppError("NOT_FOUND", 404, "User not found");
  }
}
