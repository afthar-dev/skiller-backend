import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { RequirePermission } from "../rbac";
import { CAPTION_MAX } from "./reel-rules";
import { ReelsService } from "./reels.service";
import { ViewerResolver } from "../identity";

const createSchema = z
  .object({ mediaAssetId: z.string().min(1).max(64), caption: z.string().max(CAPTION_MAX), linkedCourseId: z.string().uuid().optional(), commentsEnabled: z.boolean().optional() })
  .strict();
const updateSchema = z
  .object({ caption: z.string().max(CAPTION_MAX).optional(), linkedCourseId: z.string().uuid().nullable().optional(), commentsEnabled: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Send at least one field to change" });

/** Public reads: generous per-IP cap, enough for scrolling a feed. */
export const reelReadLimit = () => RateLimit({ key: (req) => `reels:read:${req.ip}`, limit: 300, windowSec: 60 });

@ApiTags("Reels")
@Controller()
export class ReelsController {
  constructor(
    private readonly reels: ReelsService,
    private readonly viewer: ViewerResolver,
  ) {}

  @RequirePermission("reel.create")
  @Post("reels")
  @ApiOperation({ summary: "Post a reel from my REEL upload. A finished video is published at once (daily plan limit applies: LIMIT_REACHED waits for tomorrow); one still processing is published when ready" })
  @ApiZodBody(createSchema)
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.reels.create(user.id, createSchema.parse(body));
  }

  @AuthenticatedOnly()
  @Patch("reels/:id")
  @ApiOperation({ summary: "Edit my reel: caption (hashtags follow), linked course, comments on/off" })
  @ApiZodBody(updateSchema)
  update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.reels.update(user.id, id, updateSchema.parse(body));
  }

  @AuthenticatedOnly()
  @Delete("reels/:id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete my reel (soft delete; the day's posting slot is not given back)" })
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.reels.remove(user.id, id);
  }

  @AuthenticatedOnly()
  @Post("reels/:id/publish")
  @HttpCode(200)
  @ApiOperation({ summary: "Publish a reel that hit the daily limit (or whose video just finished): 403 ENTITLEMENT_LIMIT_REACHED while the day is still full" })
  publish(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.reels.publish(user.id, id);
  }

  @Public()
  @reelReadLimit()
  @Get("reels/:id")
  @ApiOperation({ summary: "A published reel (its creator also sees it while processing, failed or waiting for the daily limit)" })
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.reels.get(id, await this.viewer.viewerId(req));
  }

  @Public()
  @reelReadLimit()
  @Get("profiles/:handle/reels")
  @ApiOperation({ summary: "A creator's published reels, newest first" })
  @ApiPagination()
  async byHandle(@Param("handle") handle: string, @Query() query: Record<string, unknown>, @Req() req: Request) {
    return this.reels.byHandle(handle, parsePage(query), await this.viewer.viewerId(req));
  }
}
