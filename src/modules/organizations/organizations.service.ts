import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type Organization } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import type { PageQuery } from "../../common/http/pagination";
import { OutboxService } from "../../common/outbox/outbox.service";
import { PrismaService } from "../../common/prisma/prisma.service";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { REDIS } from "../../common/redis/redis.constants";
import { AuditService } from "../audit";
import { EntitlementsService } from "../billing";
import { AccountService } from "../identity";
import { MailService } from "../mail";
import { MediaService } from "../media";
import { PermissionService } from "../rbac";
import { RolesService, type MutationMeta } from "../rbac";
import { ProfilesService } from "../users";

export const INVITABLE_ROLE_KEYS = ["org_instructor", "org_learner"] as const;
export type InvitableRoleKey = (typeof INVITABLE_ROLE_KEYS)[number];

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITES_PER_HOUR = 50;

export interface OrgView {
  id: string;
  slug: string;
  name: string;
  logoAssetId: string | null;
  about: string | null;
  ownerId: string;
  createdAt: string;
}

const toView = (o: Organization): OrgView => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  logoAssetId: o.logoAssetId,
  about: o.about,
  ownerId: o.ownerId,
  createdAt: o.createdAt.toISOString(),
});

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : `org-${base || randomBytes(3).toString("hex")}`;
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly mail: MailService,
    private readonly accounts: AccountService,
    private readonly profiles: ProfilesService,
    private readonly media: MediaService,
    private readonly entitlements: EntitlementsService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private alreadyMember() {
    return new AppError("ORG_ALREADY_MEMBER", 409, "This person is already a member of the organization");
  }

  async idForSlug(slug: string): Promise<string | null> {
    const org = await this.prisma.organization.findUnique({ where: { slug: slug.toLowerCase() }, select: { id: true } });
    return org?.id ?? null;
  }

  private async getRow(slug: string): Promise<Organization> {
    const org = await this.prisma.organization.findUnique({ where: { slug: slug.toLowerCase() } });
    if (!org) throw new AppError("ORG_NOT_FOUND", 404, "Organization not found");
    return org;
  }

  async get(slug: string): Promise<OrgView> {
    return toView(await this.getRow(slug));
  }

  async create(userId: string, input: { name: string; slug?: string; about?: string | null; logoAssetId?: string | null }, meta: MutationMeta = {}): Promise<OrgView> {
    const explicit = input.slug !== undefined;
    const base = input.slug ?? slugify(input.name);

    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base.slice(0, 33)}-${randomBytes(2).toString("hex")}`;
      try {
        const org = await this.prisma.$transaction(async (tx) => {
          if (input.logoAssetId) await this.media.attach(tx, input.logoAssetId, userId, "AVATAR");
          const created = await tx.organization.create({ data: { slug, name: input.name, about: input.about ?? null, logoAssetId: input.logoAssetId ?? null, ownerId: userId } });
          await this.roles.grantSystem(userId, "org_owner", tx, created.id);
          await this.outbox.enqueue(tx, { type: "org.created", orgId: created.id, ownerId: userId });
          await this.outbox.enqueue(tx, { type: "rbac.permissions_changed", userIds: [userId] });
          await this.audit.record(tx, { actorId: userId, action: "org.create", targetType: "organization", targetId: created.id, before: null, after: toView(created), ...meta });
          return created;
        });
        await this.permissions.invalidateUser(userId);
        return toView(org);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (explicit) throw new AppError("ORG_SLUG_TAKEN", 409, "This organization slug is already taken");
      }
    }
    throw new AppError("ORG_SLUG_TAKEN", 409, "Could not allocate an organization slug; provide one");
  }

  async update(actorId: string, slug: string, patch: { name?: string; about?: string | null; logoAssetId?: string | null }, meta: MutationMeta = {}): Promise<OrgView> {
    const current = await this.getRow(slug);
    const data: Prisma.OrganizationUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.about !== undefined) data.about = patch.about;
    if (patch.logoAssetId !== undefined) data.logoAssetId = patch.logoAssetId;
    const updated = await this.prisma.$transaction(async (tx) => {
      // Logos are uploaded with purpose "avatar" by whoever manages the org; the uploader owns the asset.
      if (patch.logoAssetId !== undefined && patch.logoAssetId !== current.logoAssetId) {
        if (patch.logoAssetId) await this.media.attach(tx, patch.logoAssetId, actorId, "AVATAR");
        if (current.logoAssetId) await this.media.detach(tx, current.logoAssetId);
      }
      const row = await tx.organization.update({ where: { id: current.id }, data });
      await this.audit.record(tx, { actorId, action: "org.update", targetType: "organization", targetId: current.id, before: toView(current), after: toView(row), ...meta });
      return row;
    });
    return toView(updated);
  }

  async invite(actorId: string, slug: string, input: { email: string; roleKey: InvitableRoleKey }, meta: MutationMeta = {}): Promise<{ id: string; email: string; roleKey: string; expiresAt: string }> {
    const org = await this.getRow(slug);
    await consumeRateLimit(this.redis, `org-invite:${actorId}`, INVITES_PER_HOUR, 3600);

    const email = input.email.trim().toLowerCase();
    const existingUserId = await this.accounts.findIdByEmail(email);
    if (existingUserId && (await this.roles.isOrgMember(org.id, existingUserId))) throw this.alreadyMember();
    // Plan seat limit: invited members (people with an org role, not counting the owner) plus pending invites, counting this one (a re-invite of the same address replaces its old invite).
    const seats = await this.seatsUsed(org.id, email, org.ownerId);
    await this.entitlements.check({ ownerType: "ORG", ownerId: org.id }, "org_seats", seats + 1);
    const raw = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.clock.now().getTime() + INVITE_TTL_MS);
    const inviterName = await this.profiles.displayNameOf(actorId);

    const invite = await this.prisma.$transaction(async (tx) => {
      // A fresh invite supersedes any older pending one for the same address.
      await tx.orgInvite.deleteMany({ where: { orgId: org.id, email, acceptedAt: null } });
      const created = await tx.orgInvite.create({ data: { orgId: org.id, email, roleKey: input.roleKey, tokenHash: hashToken(raw), expiresAt, invitedById: actorId } });
      await this.outbox.enqueue(tx, { type: "org.member_invited", orgId: org.id, email, inviteId: created.id });
      await this.audit.record(tx, { actorId, action: "org.invite", targetType: "org_invite", targetId: created.id, before: null, after: { orgId: org.id, email, roleKey: input.roleKey }, ...meta });
      return created;
    });

    await this.mail.send("org_invite", email, { orgName: org.name, inviterName, acceptUrl: `${this.config.webBaseUrl}/org-invites/accept?token=${raw}` });
    return { id: invite.id, email, roleKey: invite.roleKey, expiresAt: expiresAt.toISOString() };
  }

  /** Seats in use: members holding any org role except the owner (who is not a seat) plus pending, unexpired invites, optionally ignoring the invite to `exceptEmail`. */
  async seatsUsed(orgId: string, exceptEmail?: string, ownerId?: string): Promise<number> {
    const owner = ownerId ?? (await this.prisma.organization.findUnique({ where: { id: orgId }, select: { ownerId: true } }))?.ownerId;
    const members = await this.roles.countOrgMembers(orgId, owner);
    const pending = await this.prisma.orgInvite.count({ where: { orgId, acceptedAt: null, expiresAt: { gt: this.clock.now() }, ...(exceptEmail ? { email: { not: exceptEmail } } : {}) } });
    return members + pending;
  }

  async accept(userId: string, rawToken: string, meta: MutationMeta = {}): Promise<{ orgId: string; slug: string; roleKey: string }> {
    const invite = await this.prisma.orgInvite.findUnique({ where: { tokenHash: hashToken(rawToken) }, include: { org: true } });
    if (!invite) throw new AppError("INVITE_INVALID", 404, "Invitation not found");

    // Checked before state so a wrong account learns nothing about whether the invite was used or expired.
    const account = await this.accounts.get(userId);
    if (account.email !== invite.email) {
      throw new AppError("INVITE_EMAIL_MISMATCH", 403, "This invitation was sent to a different email address");
    }
    if (invite.acceptedAt) throw new AppError("INVITE_USED", 409, "This invitation has already been used");
    const now = this.clock.now();
    if (invite.expiresAt.getTime() <= now.getTime()) throw new AppError("INVITE_EXPIRED", 410, "This invitation has expired");

    await this.prisma.$transaction(async (tx) => {
      // Single-use claim: concurrent accepts race on this UPDATE and only one sees count 1.
      // Serialises accepts for one person+org so the membership check below cannot race a second accept.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`org-member:${invite.orgId}:${userId}`}))`;
      if (await this.roles.isOrgMember(invite.orgId, userId, tx)) throw this.alreadyMember();
      const claimed = await tx.orgInvite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: now } });
      if (claimed.count === 0) throw new AppError("INVITE_USED", 409, "This invitation has already been used");
      await this.roles.grantSystem(userId, invite.roleKey, tx, invite.orgId);
      await this.outbox.enqueue(tx, { type: "role.granted", userId, roleKey: invite.roleKey, grantedBy: invite.invitedById });
      await this.outbox.enqueue(tx, { type: "rbac.permissions_changed", userIds: [userId] });
      await this.audit.record(tx, { actorId: userId, action: "org.invite_accept", targetType: "org_invite", targetId: invite.id, before: null, after: { orgId: invite.orgId, roleKey: invite.roleKey }, ...meta });
    });
    await this.permissions.invalidateUser(userId);
    return { orgId: invite.orgId, slug: invite.org.slug, roleKey: invite.roleKey };
  }

  async members(slug: string, page: PageQuery) {
    const org = await this.getRow(slug);
    const result = await this.roles.listOrgMembers(org.id, page);
    const profiles = await this.profiles.summaries(result.items.map((i) => i.userId));
    return {
      nextCursor: result.nextCursor,
      items: result.items.map((i) => {
        const p = profiles.get(i.userId);
        return { userId: i.userId, roles: i.roles, handle: p?.handle ?? null, displayName: p?.displayName ?? null };
      }),
    };
  }

  async removeMember(actorId: string, slug: string, userId: string, meta: MutationMeta = {}): Promise<void> {
    const org = await this.getRow(slug);
    if (userId === org.ownerId) throw new AppError("ORG_OWNER_REQUIRED", 409, "The organization owner cannot be removed");
    const removed = await this.roles.removeOrgMember(actorId, org.id, userId, meta);
    if (!removed) throw new AppError("NOT_FOUND", 404, "Member not found");
  }
}
