import { Body, Controller, forwardRef, Get, HttpCode, Inject, Patch, Post, Put } from "@nestjs/common";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AccountService } from "../identity";
import { PermissionService } from "../rbac";
import { RolesService } from "../rbac";
import { MediaService } from "../media";
import { CreatorService } from "./creator.service";
import { ProfilesService, toOwnProfileView } from "./profiles.service";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { ApiJsonResponse, educationItemSchema, experienceItemSchema, listOf, objectSchema, ownProfileViewSchema, portfolioItemSchema, schemas } from "../../common/openapi/responses";

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
    allowMessagesFrom: z.enum(["EVERYONE", "FOLLOWING", "NONE"]).optional(),
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
@ApiTags("Me")
@Controller("me")
export class MeController {
  constructor(
    private readonly accounts: AccountService,
    private readonly profiles: ProfilesService,
    private readonly roles: RolesService,
    private readonly permissions: PermissionService,
    private readonly creator: CreatorService,
    // users and media import each other through their index files; forwardRef keeps this working whichever index loads first.
    @Inject(forwardRef(() => MediaService)) private readonly media: MediaService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Current user, profile, roles and effective platform permissions" })
  @ApiJsonResponse(200, "Current user.", objectSchema({ user: { type: "object", additionalProperties: true }, profile: ownProfileViewSchema, roles: { type: "array", items: schemas.str }, permissions: { type: "array", items: schemas.str } }))
  async me(@CurrentUser() auth: AuthUser) {
    const [user, profile, roles, effective] = await Promise.all([
      this.accounts.get(auth.id),
      // Profile creation is async (outbox handler in the worker); creating it here keeps /me valid right after sign-up.
      this.profiles.ensure(auth.id),
      this.roles.platformRoleKeys(auth.id),
      this.permissions.effective(auth.id),
    ]);
    return { user, profile: toOwnProfileView(profile), roles, permissions: [...effective.platform].sort() };
  }

  @Patch("profile")
  @ApiOperation({ summary: "Update profile fields (avatar/banner by media asset id; allowMessagesFrom: EVERYONE | FOLLOWING (people you follow) | NONE decides who may start a conversation with you)" })
  @ApiZodBody(profilePatch)
  @ApiJsonResponse(200, "Updated profile.", ownProfileViewSchema)
  updateProfile(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    const patch = profilePatch.parse(body);
    // Attaching happens in the profile update's own transaction: a media asset that is not usable rejects the whole PATCH.
    return this.profiles.update(auth.id, patch, async (tx, current) => {
      // Attach the new asset and release the one it replaces (or the one being cleared) in the same transaction.
      const swap = async (next: string | null | undefined, old: string | null, purpose: "AVATAR" | "BANNER") => {
        if (next === undefined || next === old) return;
        if (next) await this.media.attach(tx, next, auth.id, purpose);
        if (old) await this.media.detach(tx, old);
      };
      await swap(patch.avatarAssetId, current.avatarAssetId, "AVATAR");
      await swap(patch.bannerAssetId, current.bannerAssetId, "BANNER");
    });
  }

  @Put("experience")
  @ApiOperation({ summary: "Replace the experience list" })
  @ApiZodBody(experienceList)
  @ApiJsonResponse(200, "The experience list after the replace.", listOf(experienceItemSchema))
  async experience(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    return { items: await this.profiles.replaceExperience(auth.id, experienceList.parse(body).items) };
  }

  @Put("education")
  @ApiOperation({ summary: "Replace the education list" })
  @ApiZodBody(educationList)
  @ApiJsonResponse(200, "The education list after the replace.", listOf(educationItemSchema))
  async education(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    return { items: await this.profiles.replaceEducation(auth.id, educationList.parse(body).items) };
  }

  @Put("skills")
  @ApiOperation({ summary: "Replace the skills list" })
  @ApiZodBody(skillList)
  @ApiJsonResponse(200, "The skills list after the replace.", listOf(schemas.str))
  async skills(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    return { items: await this.profiles.replaceSkills(auth.id, skillList.parse(body).items) };
  }

  @Put("portfolio")
  @ApiOperation({ summary: "Replace the portfolio list" })
  @ApiZodBody(portfolioList)
  @ApiJsonResponse(200, "The portfolio list after the replace.", listOf(portfolioItemSchema))
  async portfolio(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    return { items: await this.profiles.replacePortfolio(auth.id, portfolioList.parse(body).items) };
  }

  @Post("become-creator")
  @HttpCode(200)
  @ApiOperation({ summary: "Accept the creator terms and gain the creator role" })
  @ApiZodBody(creatorBody)
  @ApiJsonResponse(200, "Creator status.", objectSchema({ isCreator: { type: "boolean" }, changed: { type: "boolean" } }))
  async becomeCreator(@CurrentUser() auth: AuthUser, @Body() body: unknown) {
    creatorBody.parse(body);
    const { changed } = await this.creator.becomeCreator(auth.id);
    return { isCreator: true, changed };
  }
}
