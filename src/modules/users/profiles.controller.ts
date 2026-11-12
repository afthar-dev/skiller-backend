import { Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { SessionService } from "../identity";
import { TokenService } from "../identity";
import { FollowsService } from "./follows.service";
import { ProfilesService } from "./profiles.service";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { ApiJsonResponse, ApiNoContent, pageSchema, profileSummarySchema, publicProfileSchema } from "../../common/openapi/responses";

@ApiTags("Profiles")
@Controller("profiles")
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly follows: FollowsService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
  ) {}

  /** Public route with optional auth: a valid bearer token adds viewer-specific fields; anything else is treated as anonymous. */
  private async optionalViewerId(req: Request): Promise<string | null> {
    const match = typeof req.headers.authorization === "string" ? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization) : null;
    if (!match) return null;
    try {
      const { sub, sid } = this.tokens.verifyAccess(match[1]);
      return (await this.sessions.isRevoked(sid)) ? null : sub;
    } catch {
      return null;
    }
  }

  @Public()
  @Get(":handle")
  @ApiOperation({ summary: "Public profile by handle (adds isFollowing for a signed-in viewer)" })
  @ApiJsonResponse(200, "The profile with its experience, education, skills and portfolio.", publicProfileSchema)
  async get(@Param("handle") handle: string, @Req() req: Request) {
    const profile = await this.profiles.getByHandle(handle);
    const viewerId = await this.optionalViewerId(req);
    const [experience, education, skills, portfolio, isFollowing] = await Promise.all([
      this.profiles.experience(profile.userId),
      this.profiles.education(profile.userId),
      this.profiles.skills(profile.userId),
      this.profiles.portfolio(profile.userId),
      viewerId ? this.follows.isFollowing(viewerId, profile.userId) : Promise.resolve(undefined),
    ]);
    return { ...(await this.profiles.viewOf(profile)), experience, education, skills, portfolio, ...(isFollowing === undefined ? {} : { isFollowing }) };
  }

  @AuthenticatedOnly()
  @Post(":handle/follow")
  @HttpCode(204)
  @ApiOperation({ summary: "Follow a profile" })
  @ApiNoContent("Following.")
  async follow(@CurrentUser() user: AuthUser, @Param("handle") handle: string) {
    await this.follows.follow(user.id, handle);
  }

  @AuthenticatedOnly()
  @Delete(":handle/follow")
  @HttpCode(204)
  @ApiOperation({ summary: "Unfollow a profile" })
  @ApiNoContent("Not following.")
  async unfollow(@CurrentUser() user: AuthUser, @Param("handle") handle: string) {
    await this.follows.unfollow(user.id, handle);
  }

  @Public()
  @Get(":handle/followers")
  @ApiOperation({ summary: "List followers" })
  @ApiJsonResponse(200, "A page of followers.", pageSchema(profileSummarySchema))
  @ApiPagination()
  followers(@Param("handle") handle: string, @Query() query: { cursor?: unknown; limit?: unknown }) {
    return this.follows.followers(handle, parsePage(query));
  }

  @Public()
  @Get(":handle/following")
  @ApiOperation({ summary: "List followed profiles" })
  @ApiJsonResponse(200, "A page of followed profiles.", pageSchema(profileSummarySchema))
  @ApiPagination()
  following(@Param("handle") handle: string, @Query() query: { cursor?: unknown; limit?: unknown }) {
    return this.follows.following(handle, parsePage(query));
  }
}
