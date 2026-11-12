import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { z } from "zod";
import type { AuthUser } from "../../common/auth/auth-user";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { OptionalAuth, OptionalUser } from "../../common/auth/optional-auth.decorator";
import { RateLimit } from "../../common/redis/rate-limit.decorator";
import { RequirePermission } from "../rbac";
import { API_PURPOSES, toPurpose } from "./media.rules";
import { MediaService } from "./media.service";
import { PlaybackService } from "./playback.service";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../../common/openapi/zod-schema";
import { ApiJsonResponse, ApiNoContent, mediaAssetSchema, objectSchema, schemas } from "../../common/openapi/responses";

const createSchema = z
  .object({
    purpose: z.enum(API_PURPOSES),
    filename: z.string().trim().min(1).max(255),
    mime: z.string().trim().min(1).max(100),
    size: z.number().int().min(1),
    orgId: z.string().uuid().optional(),
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

const partsSchema = z.object({ partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(1000) }).strict();

/** Signed-out visitors (free previews) are limited per address; signed-in users per account (PLAYBACKS_PER_HOUR in PlaybackService). */
export const ANON_PLAYBACKS_PER_HOUR = 60;

const idParam = z.string().uuid();

@ApiTags("Media")
@Controller("media")
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly playback: PlaybackService,
  ) {}

  /** Starts an upload session: returns presigned URLs the client PUTs the bytes to (one per 10 MB part). */
  @Post("uploads")
  @RequirePermission("media.upload")
  @ApiOperation({ summary: "Start an upload: returns presigned PUT URLs (one per 10 MB part)" })
  @ApiZodBody(createSchema)
  @ApiJsonResponse(201, "Upload session.", objectSchema({ assetId: schemas.str, partSize: { type: "integer" }, partUrls: { type: "array", items: schemas.str }, putHeaders: { type: "object", additionalProperties: schemas.str } }, ["assetId", "partSize", "partUrls"]))
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = createSchema.parse(body);
    return this.media.createUpload(user.id, { ...input, purpose: toPurpose(input.purpose) });
  }

  /** Resume: fresh 1 h signed URLs for the given part numbers of a still-pending multipart upload. */
  @Post("uploads/:id/parts")
  @HttpCode(200)
  @RequirePermission("media.upload")
  @ApiOperation({ summary: "Re-sign upload part URLs (valid 1 h) to resume a pending multipart upload; 60 requests per hour" })
  @ApiZodBody(partsSchema)
  @ApiJsonResponse(200, "Fresh part URLs.", objectSchema({ parts: { type: "array", items: objectSchema({ partNumber: { type: "integer" }, url: schemas.str }, ["partNumber", "url"]) } }, ["parts"]))
  parts(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.media.resignParts(user.id, idParam.parse(id), partsSchema.parse(body).partNumbers);
  }

  @Post("uploads/:id/complete")
  @HttpCode(200)
  @RequirePermission("media.upload")
  @ApiOperation({ summary: "Finish an upload; queues processing" })
  @ApiZodBody(completeSchema, { required: false })
  @ApiJsonResponse(200, "Asset state after completion.", mediaAssetSchema)
  complete(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: unknown) {
    return this.media.complete(user.id, idParam.parse(id), completeSchema.parse(body ?? {}).parts);
  }

  /** Gives up a pending upload: aborts the multipart upload and frees the slot of the 10 pending uploads cap. */
  @Delete("uploads/:id")
  @HttpCode(204)
  @RequirePermission("media.upload")
  @ApiOperation({ summary: "Abort my own PENDING upload (aborts the multipart upload; it no longer counts toward the 10 pending uploads). 404 for someone else's asset, 409 UPLOAD_NOT_PENDING once it is past PENDING" })
  @ApiNoContent("Aborted.")
  async abort(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.media.abort(user.id, idParam.parse(id));
  }

  /** Signed HLS manifest URL (10-minute token) for a private lesson video. Access is decided by the registered playback policies. */
  @Get(":id/playback")
  @OptionalAuth()
  @RateLimit({ key: (req) => `playback:ip:${req.ip}`, limit: ANON_PLAYBACKS_PER_HOUR, windowSec: 3600, anonymousOnly: true })
  @ApiOperation({ summary: "Signed HLS manifest URL for a private lesson video (token valid 10 minutes; re-call to refresh). Works signed out for the video of a free-preview lesson of a published course (60 per hour per address); everything else needs a token" })
  @ApiJsonResponse(200, "Playback grant. The token in manifestUrl expires after 10 minutes: call this route again and reload the manifest.", objectSchema({ manifestUrl: schemas.str, expiresAt: schemas.isoDate, watermark: schemas.str }))
  playbackGrant(@OptionalUser() user: AuthUser | null, @Param("id") id: string) {
    return this.playback.grant(user?.id ?? null, idParam.parse(id));
  }

  /** Poll target for the frontend: status plus public URLs once READY. */
  @Get(":id")
  @RequirePermission("media.upload")
  @ApiOperation({ summary: "Asset status plus public URLs once READY" })
  @ApiJsonResponse(200, "Asset state.", mediaAssetSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.media.get(user.id, idParam.parse(id));
  }
}
