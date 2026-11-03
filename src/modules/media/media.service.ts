import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type MediaAsset } from "@prisma/client";
import type { Queue } from "bullmq";
import { v7 as uuidv7 } from "uuid";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { APP_CONFIG } from "../../common/config/config.module";
import type { AppConfig } from "../../common/config/config.schema";
import { AppError } from "../../common/errors/app-error";
import { PrismaService } from "../../common/prisma/prisma.service";
import { QueueNames } from "../../common/queue/queue.constants";
import { InjectQueue } from "../../common/queue/queue.decorators";
import { PermissionService } from "../rbac/permission.service";
import { ProfilesService } from "../users/profiles.service";
import { MediaLifecycle } from "./media-lifecycle";
import { MEDIA_RULES, PART_SIZE, assetPrefix, requiresCreator, toApiPurpose, validateUpload, type ApiPurpose } from "./media.rules";
import { R2Client, isNoSuchUpload } from "./r2.client";

export const TRANSCODE_JOB = "media.transcode";
export const IMAGE_JOB = "media.image";
/** Two attempts: the second one covers a transient storage / ffmpeg failure; the final failure marks the asset FAILED. */
export const MEDIA_JOB_ATTEMPTS = 2;

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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QueueNames.media) private readonly queue: Queue,
  ) {}

  async createUpload(userId: string, input: CreateUploadInput): Promise<{ assetId: string; partSize: number; partUrls: string[] }> {
    const { purpose } = input;
    if (requiresCreator(purpose) && !(await this.profiles.isCreator(userId))) {
      throw new AppError("CREATOR_REQUIRED", 403, "Only creators can upload this kind of media");
    }
    const rule = validateUpload(purpose, input.mime, input.size);
    const id = uuidv7();
    const objectKey = `${assetPrefix({ purpose, ownerId: userId, id })}/source`;

    await this.prisma.mediaAsset.create({
      data: { id, ownerId: userId, purpose, bucket: rule.bucket, objectKey, filename: input.filename.slice(0, 255), mime: input.mime.toLowerCase(), declaredSize: BigInt(input.size) },
    });
    try {
      if (rule.kind === "image") {
        // Images are capped at 10 MB = one part: a single presigned PUT, no multipart upload.
        return { assetId: id, partSize: PART_SIZE, partUrls: [await this.r2.presignPut(rule.bucket, objectKey)] };
      }
      const uploadId = await this.r2.createMultipart(rule.bucket, objectKey, input.mime.toLowerCase());
      await this.prisma.mediaAsset.update({ where: { id }, data: { uploadId } });
      const partUrls = await this.r2.presignParts(rule.bucket, objectKey, uploadId, Math.ceil(input.size / PART_SIZE));
      return { assetId: id, partSize: PART_SIZE, partUrls };
    } catch (err) {
      await this.prisma.mediaAsset.deleteMany({ where: { id } });
      throw err;
    }
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
    if (kind === "file") {
      // Nothing to process: documents are usable as soon as the bytes are in place.
      await this.lifecycle.markReady(assetId);
    } else {
      try {
        await this.queue.add(kind === "image" ? IMAGE_JOB : TRANSCODE_JOB, { assetId }, { jobId: assetId, attempts: MEDIA_JOB_ATTEMPTS, backoff: { type: "fixed", delay: 5000 } });
      } catch (err) {
        await this.prisma.mediaAsset.updateMany({ where: { id: assetId, status: "UPLOADED" }, data: { status: "PENDING" } });
        throw err;
      }
      // The worker may already be past this point (it moves the asset itself); the guard keeps this from going backwards.
      await this.prisma.mediaAsset.updateMany({ where: { id: assetId, status: "UPLOADED" }, data: { status: "PROCESSING" } });
    }
    return this.dto(await this.owned(userId, assetId));
  }

  /** Owner, or anyone with `media.manage_any`. Everyone else sees 404. */
  async get(userId: string, assetId: string): Promise<MediaAssetDto> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || (asset.ownerId !== userId && !(await this.permissions.has(userId, "media.manage_any")))) throw this.notFound();
    return this.dto(asset);
  }

  /**
   * Marks the asset as in use. Call it inside the same transaction that stores the reference (profile, org, ...).
   * The asset must belong to `ownerId`, have the given purpose and be READY. Unattached assets are deleted after 24 h.
   */
  async attach(tx: Prisma.TransactionClient, assetId: string, ownerId: string, purpose: MediaAsset["purpose"]): Promise<void> {
    const usable = { id: assetId, ownerId, purpose, status: "READY" as const };
    const flipped = await tx.mediaAsset.updateMany({ where: { ...usable, attachedAt: null }, data: { attachedAt: this.clock.now() } });
    if (flipped.count === 1) return;
    // Already attached is fine (re-saving the same avatar); anything else is not usable.
    if ((await tx.mediaAsset.count({ where: usable })) === 0) {
      throw new AppError("MEDIA_NOT_USABLE", 422, "This media cannot be used here: it must be your own, fully processed upload of the right type");
    }
  }

  private async finalizeStorage(asset: MediaAsset, parts: UploadPart[]): Promise<void> {
    if (asset.uploadId) {
      if (parts.length === 0) throw new AppError("UPLOAD_INCOMPLETE", 409, "Parts are required to complete a multipart upload");
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      try {
        await this.r2.completeMultipart(asset.bucket, asset.objectKey, asset.uploadId, ordered);
      } catch (err) {
        // A previous attempt may have completed the upload and then failed later: the object is then already in place.
        if (!isNoSuchUpload(err)) throw new AppError("UPLOAD_INCOMPLETE", 409, "The upload could not be completed; check the part list and ETags");
      }
    }
    const head = await this.r2.head(asset.bucket, asset.objectKey);
    if (!head) throw new AppError("UPLOAD_INCOMPLETE", 409, "The file has not been uploaded yet");
    if (head.size !== Number(asset.declaredSize)) {
      await this.r2.delete(asset.bucket, asset.objectKey).catch(() => undefined);
      await this.lifecycle.markFailed(asset.id, "UPLOAD_SIZE_MISMATCH");
      throw new AppError("UPLOAD_SIZE_MISMATCH", 422, "The uploaded file size does not match the declared size", { declared: Number(asset.declaredSize), actual: head.size });
    }
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

