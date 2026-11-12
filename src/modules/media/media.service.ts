import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
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
import { PermissionService, PlatformRoleDirectory } from "../rbac";
import { ProfilesService } from "../users";
import { MediaAttachments } from "./media-attachments";
import { MediaLifecycle } from "./media-lifecycle";
import { effectiveMaxBytes } from "./media-limits";
import { FILE_JOB, IMAGE_JOB, MAX_PENDING_UPLOADS, PART_RESIGNS_PER_HOUR, MEDIA_JOB_ATTEMPTS, MEDIA_RULES, PART_SIZE, SOURCE_BUCKET, TRANSCODE_JOB, UPLOADS_PER_HOUR, partSizes, sourceKeyOf, requiresCreator, toApiPurpose, validateUpload, type ApiPurpose } from "./media.rules";
import { publicUrlsOf } from "./media-url-resolver";
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
  /** Upload for an organization's course: counts against the organization's storage_gb and needs an org_owner / org_instructor role there. */
  orgId?: string;
}

export interface UploadPart {
  partNumber: number;
  etag: string;
}

const COUNTED_STATUSES: MediaAsset["status"][] = ["PENDING", "UPLOADED", "PROCESSING", "READY"];
/** Purposes an organization's course can use (lesson videos, resources, trailer, thumbnail). */
const ORG_UPLOAD_PURPOSES: ReadonlySet<MediaAsset["purpose"]> = new Set(["COURSE_LESSON", "COURSE_RESOURCE", "COURSE_PROMO", "THUMBNAIL"]);
const ORG_UPLOAD_ROLES = ["org_owner", "org_instructor"];

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2Client,
    private readonly lifecycle: MediaLifecycle,
    private readonly attachments: MediaAttachments,
    // users and media import each other through their index files; forwardRef keeps this working whichever index loads first.
    @Inject(forwardRef(() => ProfilesService)) private readonly profiles: ProfilesService,
    private readonly permissions: PermissionService,
    private readonly roles: PlatformRoleDirectory,
    private readonly settings: SettingsService,
    private readonly entitlements: EntitlementsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectQueue(QueueNames.mediaTranscode) private readonly transcodeQueue: Queue,
    @InjectQueue(QueueNames.mediaLight) private readonly lightQueue: Queue,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async createUpload(userId: string, input: CreateUploadInput): Promise<{ assetId: string; partSize: number; partUrls: string[]; putHeaders?: Record<string, string> }> {
    const { purpose, orgId } = input;
    if (orgId) {
      if (!ORG_UPLOAD_PURPOSES.has(purpose)) throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { orgId: ["only course media can be uploaded for an organization"] } });
      const roles = await this.roles.roleKeysInOrg(userId, orgId);
      if (!roles.some((r) => ORG_UPLOAD_ROLES.includes(r))) throw new AppError("FORBIDDEN", 403, "Only organization owners and instructors can upload course media for the organization");
    } else if (requiresCreator(purpose) && !(await this.profiles.isCreator(userId))) {
      throw new AppError("CREATOR_REQUIRED", 403, "Only creators can upload this kind of media");
    }
    const maxBytes = await effectiveMaxBytes(this.settings, purpose);
    const rule = validateUpload(purpose, input.mime, input.size, { maxBytes });
    await this.enforceCaps(userId);
    // Plan storage quota: everything the owner has stored or is uploading (PENDING included, FAILED excluded) plus this file. Uploads made for an
    // organization are the organization's (its plan, its usage); everything else is the uploader's.
    if (orgId) await this.entitlements.check({ ownerType: "ORG", ownerId: orgId }, "storage_gb", (await this.orgStorageUsedBytes(orgId)) + input.size);
    else await this.entitlements.check({ ownerType: "USER", ownerId: userId }, "storage_gb", (await this.storageUsedBytes(userId)) + input.size);
    const id = uuidv7();
    const objectKey = sourceKeyOf(id);
    const mime = input.mime.toLowerCase();

    await this.prisma.mediaAsset.create({
      data: { id, ownerId: userId, orgId: orgId ?? null, purpose, bucket: rule.bucket, objectKey, filename: input.filename.slice(0, 255), mime: input.mime.toLowerCase(), declaredSize: BigInt(input.size) },
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
   * Bytes counted against a user's plan storage: declared sizes of every asset they uploaded that is not FAILED and was not made for an
   * organization (those belong to the organization). Billing shows this through the UsageRegistry.
   */
  async storageUsedBytes(userId: string): Promise<number> {
    const sum = await this.prisma.mediaAsset.aggregate({ where: { ownerId: userId, orgId: null, status: { in: COUNTED_STATUSES } }, _sum: { declaredSize: true } });
    return Number(sum._sum.declaredSize ?? 0n);
  }

  /**
   * Bytes counted against an organization's plan storage: every non-FAILED asset uploaded for the organization (`orgId`), whichever of its
   * authors uploaded it and whether or not it is attached yet. An ORG course accepts only such assets, so course media of an organization
   * is exactly what is counted here.
   */
  async orgStorageUsedBytes(orgId: string): Promise<number> {
    const sum = await this.prisma.mediaAsset.aggregate({ where: { orgId, status: { in: COUNTED_STATUSES } }, _sum: { declaredSize: true } });
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

  /**
   * The owner gives up a PENDING upload. The PENDING -> FAILED flip is conditional (so it cannot race a complete), FAILED assets count neither
   * toward the pending cap nor the storage quota, and the cleanup job removes them later. The R2 multipart upload is aborted so no parts linger.
   */
  async abort(userId: string, assetId: string): Promise<void> {
    const asset = await this.owned(userId, assetId);
    if (asset.status !== "PENDING") throw new AppError("UPLOAD_NOT_PENDING", 409, "This upload is no longer waiting for parts");
    const claimed = await this.prisma.mediaAsset.updateMany({ where: { id: assetId, status: "PENDING" }, data: { status: "FAILED", failureReason: "ABORTED_BY_OWNER" } });
    if (claimed.count === 0) throw new AppError("UPLOAD_NOT_PENDING", 409, "This upload is no longer waiting for parts");
    if (asset.uploadId) {
      try {
        await this.r2.abortMultipart(SOURCE_BUCKET, asset.objectKey, asset.uploadId);
      } catch (err) {
        // The asset is already off the caps; storage expires stray parts, and the purger aborts again when it removes the asset.
        this.logger.warn(`could not abort multipart upload of ${assetId}: ${(err as Error).message}`);
      }
    }
  }

  /** Owner, or anyone with `media.manage_any`. Everyone else sees 404. */
  async get(userId: string, assetId: string): Promise<MediaAssetDto> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || (asset.ownerId !== userId && !(await this.permissions.has(userId, "media.manage_any")))) throw this.notFound();
    return this.dto(asset);
  }

  /** Processing state of several assets at once (ids that do not exist are absent from the map). Inside a transaction pass it as `db`: the global client would need a second pooled connection. */
  async assetStatuses(assetIds: string[], db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<Map<string, MediaAsset["status"]>> {
    if (assetIds.length === 0) return new Map();
    const rows = await db.mediaAsset.findMany({ where: { id: { in: assetIds } }, select: { id: true, status: true } });
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  /** Owner, purpose, state and duration of an asset, for modules that decide who may attach it. Not an access check: attach() re-verifies under a row lock. */
  assetInfo(assetId: string, db?: Prisma.TransactionClient | PrismaService) {
    return this.attachments.assetInfo(assetId, db);
  }

  /** Where a READY private file (a course resource) lives, for a caller that has already decided the user may download it. */
  async privateFile(assetId: string): Promise<{ objectKey: string; filename: string | null } | null> {
    const a = await this.prisma.mediaAsset.findUnique({ where: { id: assetId }, select: { objectKey: true, filename: true, bucket: true, status: true } });
    return a && a.bucket === "PRIVATE" && a.status === "READY" ? { objectKey: a.objectKey, filename: a.filename } : null;
  }

  /**
   * Marks the asset as in use. Call it inside the same transaction that stores the reference (profile, org, ...).
   * The asset must belong to `ownerId`, have the given purpose and be READY. Unattached assets are deleted after 24 h.
   */
  attach(tx: Prisma.TransactionClient, assetId: string, ownerId: string, purpose: MediaAsset["purpose"]): Promise<void> {
    return this.attachments.attach(tx, assetId, ownerId, purpose);
  }

  /**
   * Releases an asset that a profile / org no longer references. It stays for 24 h (caches, in-flight pages), then the
   * cleanup job deletes it. Call it in the same transaction that drops the reference. Safe because an asset has exactly one attachment (see attach).
   */
  detach(tx: Prisma.TransactionClient, assetId: string): Promise<void> {
    return this.attachments.detach(tx, assetId);
  }

  /** Public URLs (see MediaAssetDto.urls) of READY public assets, by id; ids that are unknown, not ready or private are absent. */
  async publicUrls(assetIds: string[]): Promise<Map<string, Record<string, string>>> {
    if (assetIds.length === 0) return new Map();
    const rows = await this.prisma.mediaAsset.findMany({ where: { id: { in: [...new Set(assetIds)] } } });
    const out = new Map<string, Record<string, string>>();
    for (const row of rows) {
      const urls = this.urls(row);
      if (urls) out.set(row.id, urls);
    }
    return out;
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
    return publicUrlsOf(a, this.config.r2.publicBaseUrl);
  }
}

