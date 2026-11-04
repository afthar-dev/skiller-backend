import { Injectable, Optional } from "@nestjs/common";
import { OutboxService } from "../../common/outbox/outbox.service";
import { escapeLike } from "../../common/db/like";
import { Prisma, type Profile } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AccountService } from "../identity";
import { defaultDisplayName, generateHandle, isReservedHandle, isValidHandle, normalizeHandle } from "./handles";

export interface ProfileView {
  userId: string;
  handle: string;
  displayName: string;
  headline: string | null;
  about: string | null;
  avatarAssetId: string | null;
  bannerAssetId: string | null;
  location: string | null;
  links: unknown;
  followersCount: number;
  followingCount: number;
  isCreator: boolean;
  verifiedAt: string | null;
  updatedAt: string;
}

export interface ProfileSummary {
  id: string;
  handle: string;
  displayName: string;
  headline: string | null;
  avatarAssetId: string | null;
}

export interface ProfilePatch {
  handle?: string;
  displayName?: string;
  headline?: string | null;
  about?: string | null;
  location?: string | null;
  links?: { label: string; url: string }[];
  avatarAssetId?: string | null;
  bannerAssetId?: string | null;
}

export interface ExperienceInput {
  title: string;
  company: string;
  startDate: string;
  endDate?: string | null;
  description?: string | null;
}
export interface EducationInput {
  school: string;
  degree?: string | null;
  field?: string | null;
  startYear?: number | null;
  endYear?: number | null;
}
export interface PortfolioInput {
  title: string;
  url?: string | null;
  description?: string | null;
}

const GENERATION_ATTEMPTS = 10;

export const toProfileView = (p: Profile): ProfileView => ({
  userId: p.userId,
  handle: p.handle,
  displayName: p.displayName,
  headline: p.headline,
  about: p.about,
  avatarAssetId: p.avatarAssetId,
  bannerAssetId: p.bannerAssetId,
  location: p.location,
  links: p.links,
  followersCount: p.followersCount,
  followingCount: p.followingCount,
  isCreator: p.isCreator,
  verifiedAt: p.verifiedAt ? p.verifiedAt.toISOString() : null,
  updatedAt: p.updatedAt.toISOString(),
});

export const toSummary = (p: Pick<Profile, "userId" | "handle" | "displayName" | "headline" | "avatarAssetId">): ProfileSummary => ({
  id: p.userId,
  handle: p.handle,
  displayName: p.displayName,
  headline: p.headline,
  avatarAssetId: p.avatarAssetId,
});

const isoDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    @Optional() private readonly outbox?: OutboxService,
  ) {}

  /**
   * Creates the user's profile if missing and returns it. Safe to call any number of times, concurrently and from the outbox
   * handler (at-least-once): inserts are ON CONFLICT DO NOTHING, and a handle collision is retried with a new random suffix.
   */
  async ensure(userId: string, email?: string): Promise<Profile> {
    const existing = await this.prisma.profile.findUnique({ where: { userId } });
    if (existing) return existing;

    const address = email ?? await this.accounts.findEmail(userId);
    if (!address) throw new AppError("NOT_FOUND", 404, "User not found");

    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt++) {
      await this.prisma.profile.createMany({
        data: [{ userId, handle: generateHandle(address), displayName: defaultDisplayName(address) }],
        skipDuplicates: true,
      });
      // Nothing inserted means either another writer created this user's profile or the handle collided: re-read to tell which.
      const row = await this.prisma.profile.findUnique({ where: { userId } });
      if (row) return row;
    }
    throw new AppError("INTERNAL", 500, "Could not allocate a profile handle");
  }

  async getByHandle(handle: string): Promise<Profile> {
    const profile = await this.prisma.profile.findUnique({ where: { handle: normalizeHandle(handle) } });
    if (!profile) throw new AppError("PROFILE_NOT_FOUND", 404, "Profile not found");
    return profile;
  }

  async isCreator(userId: string): Promise<boolean> {
    const row = await this.prisma.profile.findUnique({ where: { userId }, select: { isCreator: true } });
    return row?.isCreator ?? false;
  }

  /** The name is still the one made from the email address when the profile was created: showing it publicly would expose the address's local part. */
  async isDefaultDisplayName(userId: string): Promise<boolean> {
    const profile = await this.ensure(userId);
    const email = await this.accounts.findEmail(userId);
    return email !== null && profile.displayName === defaultDisplayName(email);
  }

  async displayNameOf(userId: string): Promise<string> {
    return (await this.ensure(userId)).displayName;
  }

  /** Index-backed prefix match (profiles_handle_pattern_idx, text_pattern_ops); `prefix` must be lower-case. Newest first, below `cursor`. */
  async idsByHandlePrefix(prefix: string, cursor: string | undefined, take: number): Promise<string[]> {
    const rows = await this.prisma.profile.findMany({
      where: { handle: { startsWith: escapeLike(prefix) }, ...(cursor ? { userId: { lt: cursor } } : {}) },
      select: { userId: true },
      orderBy: { userId: "desc" },
      take,
    });
    return rows.map((r) => r.userId);
  }

  async summaries(userIds: string[]): Promise<Map<string, ProfileSummary>> {
    const rows = await this.prisma.profile.findMany({ where: { userId: { in: userIds } } });
    return new Map(rows.map((r) => [r.userId, toSummary(r)]));
  }

  /** `inTx` runs inside the update's transaction before the write, with the current row (used to attach/detach media so a rejected asset aborts the whole update). */
  async update(userId: string, patch: ProfilePatch, inTx?: (tx: Prisma.TransactionClient, current: Profile) => Promise<void>): Promise<ProfileView> {
    await this.ensure(userId);
    const data: Prisma.ProfileUpdateInput = {};
    if (patch.handle !== undefined) {
      const handle = normalizeHandle(patch.handle);
      // Reserved first: some reserved names (me, v1) are shorter than the minimum length.
      if (isReservedHandle(handle)) throw new AppError("HANDLE_RESERVED", 400, "This handle is reserved");
      if (!isValidHandle(handle)) {
        throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { handle: ["3-30 characters: letters, digits and underscores"] } });
      }
      data.handle = handle;
    }
    if (patch.displayName !== undefined) data.displayName = patch.displayName;
    if (patch.headline !== undefined) data.headline = patch.headline;
    if (patch.about !== undefined) data.about = patch.about;
    if (patch.location !== undefined) data.location = patch.location;
    if (patch.links !== undefined) data.links = patch.links as Prisma.InputJsonValue;
    if (patch.avatarAssetId !== undefined) data.avatarAssetId = patch.avatarAssetId;
    if (patch.bannerAssetId !== undefined) data.bannerAssetId = patch.bannerAssetId;

    try {
      return toProfileView(
        await this.prisma.$transaction(async (tx) => {
          const current = await tx.profile.findUniqueOrThrow({ where: { userId } });
          if (inTx) await inTx(tx, current);
          const row = await tx.profile.update({ where: { userId }, data });
          // Courses copy the creator's name for search: tell them (the handler reads the current name).
          if (row.displayName !== current.displayName) await this.outbox?.enqueue(tx, { type: "user.profile_updated", userId });
          return row;
        }),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError("HANDLE_TAKEN", 409, "This handle is already taken");
      }
      throw err;
    }
  }

  async replaceExperience(userId: string, items: ExperienceInput[]) {
    await this.ensure(userId);
    await this.prisma.$transaction([
      this.prisma.experience.deleteMany({ where: { userId } }),
      this.prisma.experience.createMany({
        data: items.map((i, position) => ({
          userId,
          position,
          title: i.title,
          company: i.company,
          startDate: isoDate(i.startDate),
          endDate: i.endDate ? isoDate(i.endDate) : null,
          description: i.description ?? null,
        })),
      }),
    ]);
    return this.experience(userId);
  }

  async replaceEducation(userId: string, items: EducationInput[]) {
    await this.ensure(userId);
    await this.prisma.$transaction([
      this.prisma.education.deleteMany({ where: { userId } }),
      this.prisma.education.createMany({
        data: items.map((i, position) => ({
          userId,
          position,
          school: i.school,
          degree: i.degree ?? null,
          field: i.field ?? null,
          startYear: i.startYear ?? null,
          endYear: i.endYear ?? null,
        })),
      }),
    ]);
    return this.education(userId);
  }

  async replaceSkills(userId: string, items: string[]) {
    await this.ensure(userId);
    const seen = new Set<string>();
    const unique = items.filter((s) => {
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await this.prisma.$transaction([
      this.prisma.profileSkill.deleteMany({ where: { userId } }),
      this.prisma.profileSkill.createMany({ data: unique.map((skill, position) => ({ userId, skill, position })) }),
    ]);
    return this.skills(userId);
  }

  async replacePortfolio(userId: string, items: PortfolioInput[]) {
    await this.ensure(userId);
    await this.prisma.$transaction([
      this.prisma.portfolioItem.deleteMany({ where: { userId } }),
      this.prisma.portfolioItem.createMany({
        data: items.map((i, position) => ({ userId, position, title: i.title, url: i.url ?? null, description: i.description ?? null })),
      }),
    ]);
    return this.portfolio(userId);
  }

  async experience(userId: string) {
    const rows = await this.prisma.experience.findMany({ where: { userId }, orderBy: { position: "asc" } });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      company: r.company,
      startDate: dateOnly(r.startDate),
      endDate: dateOnly(r.endDate),
      description: r.description,
    }));
  }

  async education(userId: string) {
    const rows = await this.prisma.education.findMany({ where: { userId }, orderBy: { position: "asc" } });
    return rows.map((r) => ({ id: r.id, school: r.school, degree: r.degree, field: r.field, startYear: r.startYear, endYear: r.endYear }));
  }

  async skills(userId: string): Promise<string[]> {
    const rows = await this.prisma.profileSkill.findMany({ where: { userId }, orderBy: { position: "asc" } });
    return rows.map((r) => r.skill);
  }

  async portfolio(userId: string) {
    const rows = await this.prisma.portfolioItem.findMany({ where: { userId }, orderBy: { position: "asc" } });
    return rows.map((r) => ({ id: r.id, title: r.title, url: r.url, mediaAssetId: r.mediaAssetId, description: r.description }));
  }
}
