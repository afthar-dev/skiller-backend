import { Body, Controller, Get, HttpCode, Patch, Post, Put } from "@nestjs/common";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AccountService } from "../identity/account.service";
import { PermissionService } from "../rbac/permission.service";
import { RolesService } from "../rbac/roles.service";
import { MediaService } from "../media/media.service";
import { CreatorService } from "./creator.service";
import { ProfilesService, toProfileView } from "./profiles.service";

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL");
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const date = z.string().date();

const assetId = z.string().uuid().nullable().optional();

// .strict() everywhere: unknown fields (isCreator, ...) are rejected, not silently dropped.
const profilePatch = z
  .object({
    handle: z.string().max(60).optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    headline: optText(120),
    about: optText(5000),
    location: optText(80),
    links: z.array(z.object({ label: z.string().trim().min(1).max(40), url: httpUrl }).strict()).max(10).optional(),
    avatarAssetId: assetId,
    bannerAssetId: assetId,
  })
  .strict();

const experienceList = z
  .object({
    items: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            company: z.string().trim().min(1).max(120),
            startDate: date,
            endDate: date.nullable().optional(),
            description: optText(2000),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

const year = z.number().int().min(1900).max(2100);
const educationList = z
  .object({
    items: z
      .array(
        z
          .object({
            school: z.string().trim().min(1).max(120),
            degree: optText(120),
            field: optText(120),
            startYear: year.nullable().optional(),
            endYear: year.nullable().optional(),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

const skillList = z.object({ items: z.array(z.string().trim().min(1).max(40)).max(50) }).strict();

const portfolioList = z
  .object({
    items: z
      .array(z.object({ title: z.string().trim().min(1).max(120), url: httpUrl.nullable().optional(), description: optText(2000) }).strict())
      .max(30),
  })
  .strict();

const creatorBody = z.object({ acceptTerms: z.literal(true) }).strict();

@AuthenticatedOnly()
@Controller("me")
export class MeController {
  constructor(
    private readonly accounts: AccountService,
    private readonly profiles: ProfilesService,
    private readonly roles: RolesService,
    private readonly permissions: PermissionService,
    private readonly creator: CreatorService,
    private readonly media: MediaService,
  ) {}

  @Get()
  async me(@CurrentUser() auth: AuthUser) {
    const [user, profile, roles, effective] = await Promise.all([
      this.accounts.get(auth.id),
      // Profile creation is async (outbox handler in the worker); creating it here keeps /me valid right after sign-up.
      this.profiles.ensure(auth.id),
      this.roles.platformRoleKeys(auth.id),
      this.permissions.effective(auth.id),
    ]);
    return { user, profile: toProfileView(profile), roles, permissions: [...effective.platform].sort() };
  }

  @Patch("profile")
  updateProfile(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    const patch = profilePatch.parse(body);
    // Attaching happens in the profile update's own transaction: a media asset that is not usable rejects the whole PATCH.
    return this.profiles.update(auth.id, patch, async (tx) => {
      if (patch.avatarAssetId) await this.media.attach(tx, patch.avatarAssetId, auth.id, "AVATAR");
      if (patch.bannerAssetId) await this.media.attach(tx, patch.bannerAssetId, auth.id, "BANNER");
    });
  }

  @Put("experience")
  async experience(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    return { items: await this.profiles.replaceExperience(auth.id, experienceList.parse(body).items) };
  }

  @Put("education")
  async education(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    return { items: await this.profiles.replaceEducation(auth.id, educationList.parse(body).items) };
  }

  @Put("skills")
  async skills(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    return { items: await this.profiles.replaceSkills(auth.id, skillList.parse(body).items) };
  }

  @Put("portfolio")
  async portfolio(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    return { items: await this.profiles.replacePortfolio(auth.id, portfolioList.parse(body).items) };
  }

  @Post("become-creator")
  @HttpCode(200)
  async becomeCreator(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    creatorBody.parse(body);
    const { changed } = await this.creator.becomeCreator(auth.id);
    return { isCreator: true, changed };
  }
}
