import { Controller, Delete, Get, HttpCode, Param, Put, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { AppError } from "../../common/errors/app-error";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination } from "../../common/openapi/zod-schema";
import { ApiJsonResponse, objectSchema, pageSchema, relationItemSchema } from "../../common/openapi/responses";
import { UserBlocks, type RelationPage } from "../moderation";
import { FollowsService } from "./follows.service";
import { ProfilesService } from "./profiles.service";

/** The member-facing side of blocks and mutes (the data and the rules live in the moderation module; handles and follows belong here). */
@ApiTags("Blocks and mutes")
@Controller()
@AuthenticatedOnly()
export class RelationsController {
  constructor(
    private readonly blocks: UserBlocks,
    private readonly profiles: ProfilesService,
    private readonly follows: FollowsService,
  ) {}

  @Put("blocks/:handle")
  @HttpCode(200)
  @ApiOperation({ summary: "Block a member (idempotent). Neither of you sees the other's reels or comments; any follow between you ends; they cannot follow or comment on you" })
  @ApiJsonResponse(200, "Blocked.", objectSchema({ blocked: { type: "boolean" } }))
  async block(@CurrentUser() user: AuthUser, @Param("handle") handle: string) {
    const target = await this.target(user.id, handle, "block");
    await this.blocks.block(user.id, target, (tx) => this.follows.removeBetween(tx, user.id, target));
    return { blocked: true };
  }

  @Delete("blocks/:handle")
  @HttpCode(200)
  @ApiOperation({ summary: "Unblock a member (idempotent)" })
  @ApiJsonResponse(200, "Not blocked.", objectSchema({ blocked: { type: "boolean" } }))
  async unblock(@CurrentUser() user: AuthUser, @Param("handle") handle: string) {
    await this.blocks.unblock(user.id, (await this.profiles.getByHandleAnyStatus(handle)).userId);
    return { blocked: false };
  }

  @Put("mutes/:handle")
  @HttpCode(200)
  @ApiOperation({ summary: "Mute a creator (idempotent): their reels leave your feeds and search. Nothing else changes" })
  @ApiJsonResponse(200, "Muted.", objectSchema({ muted: { type: "boolean" } }))
  async mute(@CurrentUser() user: AuthUser, @Param("handle") handle: string) {
    await this.blocks.mute(user.id, await this.target(user.id, handle, "mute"));
    return { muted: true };
  }

  @Delete("mutes/:handle")
  @HttpCode(200)
  @ApiOperation({ summary: "Unmute a creator (idempotent)" })
  @ApiJsonResponse(200, "Not muted.", objectSchema({ muted: { type: "boolean" } }))
  async unmute(@CurrentUser() user: AuthUser, @Param("handle") handle: string) {
    await this.blocks.unmute(user.id, (await this.profiles.getByHandleAnyStatus(handle)).userId);
    return { muted: false };
  }

  @Get("me/blocks")
  @ApiOperation({ summary: "Members I blocked, newest first" })
  @ApiJsonResponse(200, "A page of blocked members.", pageSchema(relationItemSchema))
  @ApiPagination()
  async myBlocks(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.withProfiles(await this.blocks.blockedBy(user.id, parsePage(query)));
  }

  @Get("me/mutes")
  @ApiOperation({ summary: "Creators I muted, newest first" })
  @ApiJsonResponse(200, "A page of muted creators.", pageSchema(relationItemSchema))
  @ApiPagination()
  async myMutes(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.withProfiles(await this.blocks.mutedBy(user.id, parsePage(query)));
  }

  private async target(me: string, handle: string, verb: string): Promise<string> {
    const profile = await this.profiles.getByHandle(handle);
    if (profile.userId === me) throw new AppError("RELATION_SELF", 400, `You cannot ${verb} yourself`);
    return profile.userId;
  }

  private async withProfiles(page: RelationPage) {
    const summaries = await this.profiles.summaries(page.items.map((i) => i.userId));
    return {
      items: page.items.flatMap((i) => {
        const s = summaries.get(i.userId);
        return s ? [{ id: s.id, handle: s.handle, displayName: s.displayName, since: i.since.toISOString() }] : [];
      }),
      nextCursor: page.nextCursor,
    };
  }
}
