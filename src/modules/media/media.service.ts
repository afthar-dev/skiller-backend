import { Inject, Injectable } from "@nestjs/common";
import { SettingsService } from "../admin";
import { Prisma, type MediaAsset } from "@prisma/client";
import type { Queue } from "bullmq";
import { v7 as uuidv7 } from "uuid";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import type { Redis } from "ioredis";
import { consumeRateLimit } from "../../common/redis/rate-limiter";
import { REDIS } from "../../common/redis/redis.constants";
import { PrismaService } from "../../common/prisma/prisma.service";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { EntitlementsService } from "../billing";
import { PermissionService } from "../rbac";
import { ProfilesService } from "../users";
import { MediaLifecycle } from "./media-lifecycle";
import { effectiveMaxBytes } from "./media-limits";
import { FILE_JOB, IMAGE_JOB, MAX_PENDING_UPLOADS, PART_RESIGNS_PER_HOUR, MEDIA_JOB_ATTEMPTS, MEDIA_RULES, PART_SIZE, SOURCE_BUCKET, TRANSCODE_JOB, UPLOADS_PER_HOUR, partSizes, sourceKeyOf, assetPrefix, requiresCreator, toApiPurpose, validateUpload, type ApiPurpose } from "./media.rules";
import { R2Client, isNoSuchUpload } from "./r2.client";

export interface MediaAssetDto {
  id: string;
  purpose: ApiPurpose;
  status: MediaAsset["status"];
  mime: string;
  size: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** Public-bucket assets once READY: image variants (`256`, `1024`) or `hls` + `poster`. Private assets have none. */
  urls: Record<string, string> | null;
  failureReason: string | null;
  createdAt: string;
}

export interface CreateUploadInput {
  purpose: MediaAsset["purpose"];
  filename: string;
  mime: string;
  size: number;
}

export interface UploadPart {
  partNumber: number;
  etag: string;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Client,
    private readonly lifecycle: MediaLifecycle,
    private readonly profiles: ProfilesService,
    private readonly permissions: PermissionService,
    private readonly settings: SettingsService,
    private readonly entitlements: EntitlementsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QueueNames.mediaTranscode) private readonly transcodeQueue: Queue,
    @InjectQueue(QueueNames.mediaLight) private readonly lightQueue: Queue,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async createUpload(userId: string, input: CreateUploadInput): Promise<{ assetId: string; partSize: number; partUrls: string[]; putHeaders?: Record<string, string> }> {
    const { purpose } = input;
    if (requiresCreator(purpose) && !(await this.profiles.isCreator(userId))) {
      throw new AppError("CREATOR_REQUIRED", 403, "Only creators can upload this kind of media");
    }
    const maxBytes = await effectiveMaxBytes(this.settings, purpose);
    const rule = validateUpload(purpose, input.mime, input.size, { maxBytes });
    await this.enforceCaps(userId);
    // Plan storage quota: everything the user has stored or is uploading (PENDING included, FAILED excluded) plus this file.
    await this.entitlements.check({ ownerType: "USER", ownerId: userId }, "storage_gb", (await this.storageUsedBytes(userId)) + input.size);
    const id = uuidv7();
    const objectKey = sourceKeyOf(id);
    const mime = input.mime.toLowerCase();

    await this.prisma.mediaAsset.create({
      data: { id, ownerId: userId, purpose, bucket: rule.bucket, objectKey, filename: input.filename.slice(0, 255), mime: input.mime.toLowerCase(), declaredSize: BigInt(input.size) },
    });
    try {
      if (rule.kind === "image") {
        // Images are capped at 10 MB = one part: a single presigned PUT, no multipart upload. The URL only accepts
        // exactly the declared length and content type.
        const url = await this.r2.presignPut(SOURCE_BUCKET, objectKey, { contentLength: input.size, contentType: mime });
        return { assetId: id, partSize: PART_SIZE, partUrls: [url], putHeaders: { "Content-Type": mime } };
      }
      const uploadId = await this.r2.createMultipart(SOURCE_BUCKET, objectKey, mime);
      await this.prisma.mediaAsset.update({ where: { id }, data: { uploadId } });
      const partUrls = await this.r2.presignParts(
        SOURCE_BUCKET,
        objectKey,
        uploadId,
        partSizes(input.size).map((size, i) => ({ partNumber: i + 1, size })),
      );
      return { assetId: id, partSize: PART_SIZE, partUrls };
    } catch (err) {
      await this.prisma.mediaAsset.deleteMany({ where: { id } });
      throw err;
    }
  }

  /**
   * Bytes counted against the owner's plan storage: declared sizes of every asset that is not FAILED. Course-lesson videos are
   * uploaded (and owned) by the creator, so they count for the creator. Billing shows this through the UsageRegistry.
   */
  async storageUsedBytes(userId: string): Promise<number> {
    const sum = await this.prisma.mediaAsset.aggregate({ where: { ownerId: userId, status: { in: ["PENDING", "UPLOADED", "PROCESSING", "READY"] } }, _sum: { declaredSize: true } });
    return Number(sum._sum.declaredSize ?? 0n);
  }

  /**
   * Resume support: fresh (1 h) signed URLs for specific parts of a multipart upload that is still PENDING. Owner only
   * (anyone else sees 404), at most 60 calls per hour per user.
   */
  async resignParts(userId: string, assetId: string, partNumbers: number[]): Promise<{ parts: { partNumber: number; url: string }[] }> {
    const asset = await this.owned(userId, assetId);
    if (asset.status !== "PENDING") throw new AppError("UPLOAD_NOT_PENDING", 409, "This upload is no longer waiting for parts");
    if (!asset.uploadId) throw new AppError("UPLOAD_NOT_MULTIPART", 409, "This upload is a single request and has no parts; use the URL returned when it was created");
    const sizes = partSizes(Number(asset.declaredSize));
    const wanted = [...new Set(partNumbers)].sort((a, b) => a - b);
    const outOfRange = wanted.filter((n) => n > sizes.length);
    if (outOfRange.length > 0) {
      throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { partNumbers: [`must be between 1 and ${sizes.length} for this upload`] } });
    }
    try {
      await consumeRateLimit(this.redis, `media-parts:${userId}`, PART_RESIGNS_PER_HOUR, 3600);
    } catch (err) {
      if (err instanceof AppError && err.code === "RATE_LIMITED") throw new AppError("RATE_LIMITED", 429, "Too many part re-sign requests; try again later", err.details);
      throw err;
    }
    const urls = await this.r2.presignParts(
      SOURCE_BUCKET,
      asset.objectKey,
      asset.uploadId,
      wanted.map((partNumber) => ({ partNumber, size: sizes[partNumber - 1] })),
    );
    return { parts: wanted.map((partNumber, i) => ({ partNumber, url: urls[i] })) };
  }

  /**
   * Idempotent and safe under concurrency: the PENDING -> UPLOADED flip is a conditional update, so exactly one caller
   * finalises the upload and enqueues the job (and the BullMQ jobId is the asset id as a second guard). Everyone else
   * just gets the current state.
   */
  async complete(userId: string, assetId: string, parts: UploadPart[] = []): Promise<MediaAssetDto> {
    const asset = await this.owned(userId, assetId);
    if (asset.status !== "PENDING") return this.dto(asset);

    const claimed = await this.prisma.mediaAsset.updateMany({ where: { id: assetId, status: "PENDING" }, data: { status: "UPLOADED" } });
    if (claimed.count === 0) return this.dto(await this.owned(userId, assetId));

    try {
      await this.finalizeStorage(asset, parts);
    } catch (err) {
      // Not uploaded yet / bad etags: let the client fix it and call complete again. A size mismatch already marked FAILED.
      await this.prisma.mediaAsset.updateMany({ where: { id: assetId, status: "UPLOADED" }, data: { status: "PENDING" } });
      throw err;
    }

    const kind = MEDIA_RULES[asset.purpose].kind;
    const job = kind === "image" ? IMAGE_JOB : kind === "video" ? TRANSCODE_JOB : FILE_JOB;
    try {
      await (kind === "video" ? this.transcodeQueue : this.lightQueue).add(job, { assetId }, { jobId: assetId, attempts: MEDIA_JOB_ATTEMPTS, backoff: { type: "fixed", delay: 5000 } });
    } catch (err) {
      await this.prisma.mediaAsset.updateMany({ where: { id: assetId, status: "UPLOADED" }, data: { status: "PENDING" } });
      throw err;
    }
    // The worker may already be past this point (it moves the asset itself); the guard keeps this from going backwards.
    await this.prisma.mediaAsset.updateMany({ where: { id: assetId, status: "UPLOADED" }, data: { status: "PROCESSING" } });
    return this.dto(await this.owned(userId, assetId));
  }

  /** Owner, or anyone with `media.manage_any`. Everyone else sees 404. */
  async get(userId: string, assetId: string): Promise<MediaAssetDto> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || (asset.ownerId !== userId && !(await this.permissions.has(userId, "media.manage_any")))) throw this.notFound();
    return this.dto(asset);
  }

  /** Owner, purpose, state and duration of an asset, for modules that decide who may attach it. Not an access check: attach() re-verifies under a row lock. */
  async assetInfo(assetId: string): Promise<{ ownerId: string; purpose: MediaAsset["purpose"]; status: MediaAsset["status"]; durationSec: number | null } | null> {
    return this.prisma.mediaAsset.findUnique({ where: { id: assetId }, select: { ownerId: true, purpose: true, status: true, durationSec: true } });
  }

  /**
   * Marks the asset as in use. Call it inside the same transaction that stores the reference (profile, org, ...).
   * The asset must belong to `ownerId`, have the given purpose and be READY. Unattached assets are deleted after 24 h.
   */
  async attach(tx: Prisma.TransactionClient, assetId: string, ownerId: string, purpose: MediaAsset["purpose"]): Promise<void> {
    // Row lock: concurrent attaches / detaches of one asset serialise, so "exactly one attachment" holds.
    await tx.$queryRaw`SELECT "id" FROM "media_assets" WHERE "id" = ${assetId} FOR UPDATE`;
    const asset = await tx.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.ownerId !== ownerId || asset.purpose !== purpose || asset.status !== "READY") {
      throw new AppError("MEDIA_NOT_USABLE", 422, "This media cannot be used here: it must be your own, fully processed upload of the right type");
    }
    // An asset belongs to exactly one target. Callers re-saving the same target skip attach/detach when the id is unchanged.
    if (asset.attachedAt) throw new AppError("MEDIA_NOT_USABLE", 409, "This media is already in use somewhere else; upload it again to use it here");
    await tx.mediaAsset.update({ where: { id: assetId }, data: { attachedAt: this.clock.now(), detachedAt: null } });
  }

  /**
   * Releases an asset that a profile / org no longer references. It stays for 24 h (caches, in-flight pages), then the
   * cleanup job deletes it. Call it in the same transaction that drops the reference. Safe because an asset has exactly one attachment (see attach).
   */
  async detach(tx: Prisma.TransactionClient, assetId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "media_assets" WHERE "id" = ${assetId} FOR UPDATE`;
    await tx.mediaAsset.updateMany({ where: { id: assetId, attachedAt: { not: null } }, data: { attachedAt: null, detachedAt: this.clock.now() } });
  }

  private async enforceCaps(userId: string): Promise<void> {
    const pending = await this.prisma.mediaAsset.count({ where: { ownerId: userId, status: "PENDING" } });
    if (pending >= MAX_PENDING_UPLOADS) {
      throw new AppError("UPLOAD_LIMIT_REACHED", 429, `You have ${MAX_PENDING_UPLOADS} unfinished uploads; finish or wait for them to expire`);
    }
    try {
      await consumeRateLimit(this.redis, `media-upload:${userId}`, UPLOADS_PER_HOUR, 3600);
    } catch (err) {
      if (err instanceof AppError && err.code === "RATE_LIMITED") throw new AppError("UPLOAD_LIMIT_REACHED", 429, "Too many upload sessions; try again later", err.details);
      throw err;
    }
  }

  private async finalizeStorage(asset: MediaAsset, parts: UploadPart[]): Promise<void> {
    if (asset.uploadId) {
      if (parts.length === 0) throw new AppError("UPLOAD_INCOMPLETE", 409, "Parts are required to complete a multipart upload");
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      try {
        await this.r2.completeMultipart(SOURCE_BUCKET, asset.objectKey, asset.uploadId, ordered);
      } catch (err) {
        // A previous attempt may have completed the upload and then failed later: the object is then already in place.
        if (!isNoSuchUpload(err)) throw new AppError("UPLOAD_INCOMPLETE", 409, "The upload could not be completed; check the part list and ETags");
      }
    }
    const head = await this.r2.head(SOURCE_BUCKET, asset.objectKey);
    if (!head) throw new AppError("UPLOAD_INCOMPLETE", 409, "The file has not been uploaded yet");
    if (head.size !== Number(asset.declaredSize)) {
      await this.r2.delete(SOURCE_BUCKET, asset.objectKey).catch(() => undefined);
      await this.lifecycle.markFailed(asset.id, "UPLOAD_SIZE_MISMATCH");
      throw new AppError("UPLOAD_SIZE_MISMATCH", 422, "The uploaded file size does not match the declared size", { declared: Number(asset.declaredSize), actual: head.size });
    }
    // The worker reads the source with If-Match on this ETag: replacing the object after this point (the single-PUT URL
    // stays valid for its TTL) makes the job fail instead of processing swapped bytes.
    await this.prisma.mediaAsset.update({ where: { id: asset.id }, data: { sourceEtag: head.etag ?? null } });
  }

  private async owned(userId: string, assetId: string): Promise<MediaAsset> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.ownerId !== userId) throw this.notFound();
    return asset;
  }

  private notFound() {
    return new AppError("MEDIA_NOT_FOUND", 404, "Media not found");
  }

  dto(a: MediaAsset): MediaAssetDto {
    return {
      id: a.id,
      purpose: toApiPurpose(a.purpose),
      status: a.status,
      mime: a.mime,
      size: Number(a.declaredSize),
      durationSec: a.durationSec,
      width: a.width,
      height: a.height,
      urls: this.urls(a),
      failureReason: a.failureReason,
      createdAt: a.createdAt.toISOString(),
    };
  }

  private urls(a: MediaAsset): Record<string, string> | null {
    if (a.bucket !== "PUBLIC" || a.status !== "READY") return null;
    const base = this.config.r2.publicBaseUrl;
    const prefix = assetPrefix(a);
    const renditions = a.renditions as Record<string, unknown> | unknown[] | null;
    if (a.purpose === "REEL") {
      const out: Record<string, string> = { hls: `${base}/${prefix}/hls/index.m3u8` };
      if (a.posterKey) out.poster = `${base}/${a.posterKey}`;
      return out;
    }
    if (renditions && !Array.isArray(renditions)) {
      return Object.fromEntries(Object.entries(renditions).map(([size, key]) => [size, `${base}/${String(key)}`]));
    }
    return null;
  }
}

