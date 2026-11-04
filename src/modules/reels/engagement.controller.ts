import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { Public } from "../../common/auth/public.decorator";
import { parsePage } from "../../common/http/pagination";
import { ApiPagination, ApiZodBody } from "../../common/openapi/zod-schema";
import { CommentsService, COMMENT_MAX } from "./comments.service";
import { EngagementService, SHARE_CHANNELS } from "./engagement.service";
import { reelReadLimit } from "./reels.controller";
import { ViewerResolver } from "./viewer";

const shareSchema = z.object({ channel: z.enum(SHARE_CHANNELS) }).strict();
const commentSchema = z.object({ body: z.string().max(COMMENT_MAX), parentId: z.string().uuid().optional() }).strict();
const editSchema = z.object({ body: z.string().max(COMMENT_MAX) }).strict();

@ApiTags("Reel engagement")
@Controller()
export class EngagementController {
  constructor(
    private readonly engagement: EngagementService,
    private readonly viewer: ViewerResolver,
  ) {}

  @AuthenticatedOnly()
  @Put("reels/:id/like")
  @HttpCode(200)
  @ApiOperation({ summary: "Like a reel (idempotent; 120 likes or unlikes a minute)" })
  like(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.engagement.like(user.id, id);
  }

  @AuthenticatedOnly()
  @Delete("reels/:id/like")
  @HttpCode(200)
  @ApiOperation({ summary: "Remove my like (idempotent)" })
  unlike(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.engagement.unlike(user.id, id);
  }

  @AuthenticatedOnly()
  @Put("reels/:id/save")
  @HttpCode(200)
  @ApiOperation({ summary: "Save a reel (idempotent; 120 saves or unsaves a minute)" })
  save(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.engagement.save(user.id, id);
  }

  @AuthenticatedOnly()
  @Delete("reels/:id/save")
  @HttpCode(200)
  @ApiOperation({ summary: "Remove my save (idempotent)" })
  unsave(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.engagement.unsave(user.id, id);
  }

  @Public()
  @Post("reels/:id/shares")
  @HttpCode(200)
  @ApiOperation({ summary: "Record a share. Counted once per signed-in user per reel per IST day; anonymous shares are accepted but not counted. 30 a minute" })
  @ApiZodBody(shareSchema)
  async share(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    const { channel } = shareSchema.parse(body);
    return this.engagement.share(await this.viewer.viewerId(req), req.ip ?? "unknown", id, channel);
  }

  @AuthenticatedOnly()
  @Get("me/saved-reels")
  @ApiOperation({ summary: "My saved reels that are still public, most recently saved first" })
  @ApiPagination()
  savedReels(@CurrentUser() user: AuthUser, @Query() query: Record<string, unknown>) {
    return this.engagement.savedReels(user.id, parsePage(query));
  }
}

@ApiTags("Reel comments")
@Controller("reels/:id/comments")
export class CommentsController {
  constructor(
    private readonly comments: CommentsService,
    private readonly viewer: ViewerResolver,
  ) {}

  @Public()
  @reelReadLimit()
  @Get()
  @ApiOperation({ summary: "Top-level comments of a reel, newest first, with reply counts. A deleted comment that has replies shows as [deleted]" })
  @ApiPagination()
  async list(@Param("id") id: string, @Query() query: Record<string, unknown>, @Req() req: Request) {
    return this.comments.list(id, await this.viewer.viewerId(req), parsePage(query));
  }

  @Public()
  @reelReadLimit()
  @Get(":commentId/replies")
  @ApiOperation({ summary: "Replies to a top-level comment, oldest first" })
  @ApiPagination()
  async replies(@Param("id") id: string, @Param("commentId") commentId: string, @Query() query: Record<string, unknown>, @Req() req: Request) {
    return this.comments.replies(id, commentId, await this.viewer.viewerId(req), parsePage(query));
  }

  @AuthenticatedOnly()
  @Post()
  @ApiOperation({ summary: "Comment on a reel (plain text, 1000 characters) or reply to a comment (one level: a reply to a reply joins the same thread). 30 a minute; 403 COMMENTS_DISABLED when the creator turned comments off" })
  @ApiZodBody(commentSchema)
  create(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.comments.create(user.id, id, commentSchema.parse(body));
  }

  @AuthenticatedOnly()
  @Patch(":commentId")
  @ApiOperation({ summary: "Edit my comment" })
  @ApiZodBody(editSchema)
  edit(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("commentId") commentId: string, @Body() body: unknown) {
    return this.comments.edit(user.id, id, commentId, editSchema.parse(body).body);
  }

  @AuthenticatedOnly()
  @Delete(":commentId")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a comment: its author, or the creator of the reel" })
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("commentId") commentId: string) {
    await this.comments.remove(user.id, id, commentId);
  }
}
