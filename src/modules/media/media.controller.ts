import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { AuthenticatedOnly } from "../../common/auth/authenticated-only.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { API_PURPOSES, toPurpose } from "./media.rules";
import { MediaService } from "./media.service";
import { PlaybackService } from "./playback.service";

const createSchema = z
  .object({
    purpose: z.enum(API_PURPOSES),
    filename: z.string().trim().min(1).max(255),
    mime: z.string().trim().min(1).max(100),
    size: z.number().int().min(1),
  })
  .strict();

const completeSchema = z
  .object({
    parts: z
      .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }).strict())
      .max(10_000)
      .optional(),
  })
  .strict();

const idParam = z.string().uuid();

@Controller("media")
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly playback: PlaybackService,
  ) {}

  /** Starts an upload session: returns presigned URLs the client PUTs the bytes to (one per 10 MB part). */
  @Post("uploads")
  @RequirePermission("media.upload")
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = createSchema.parse(body);
    return this.media.createUpload(user.id, { ...input, purpose: toPurpose(input.purpose) });
  }

  @Post("uploads/:id/complete")
  @HttpCode(200)
  @RequirePermission("media.upload")
  complete(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.media.complete(user.id, idParam.parse(id), completeSchema.parse(body ?? {}).parts);
  }

  /** Signed HLS manifest URL (10-minute token) for a private lesson video. Access is decided by the registered playback policies. */
  @Get(":id/playback")
  @AuthenticatedOnly()
  playbackGrant(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.playback.grant(user.id, idParam.parse(id));
  }

  /** Poll target for the frontend: status plus public URLs once READY. */
  @Get(":id")
  @RequirePermission("media.upload")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.media.get(user.id, idParam.parse(id));
  }
}
