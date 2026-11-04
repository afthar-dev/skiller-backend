import type { MediaBucket, MediaPurpose } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";

const MB = 1024 * 1024;

export const PART_SIZE = 10 * MB;
/** Single-PUT URLs (images, up to 10 MB). */
export const PRESIGN_TTL_SEC = 15 * 60;
/** Multipart part URLs: a 5 GB lesson needs far longer than 15 minutes on a normal connection; parts can be re-signed when this runs out. */
export const PART_PRESIGN_TTL_SEC = 60 * 60;
export const PART_RESIGNS_PER_HOUR = 60;

/** Every upload lands in the private bucket first, whatever its purpose; processed outputs go to the purpose's own bucket. */
export const SOURCE_BUCKET: MediaBucket = "PRIVATE";
export const sourceKeyOf = (assetId: string) => `incoming/${assetId}/source`;
export const sourcePrefixOf = (assetId: string) => `incoming/${assetId}/`;

export const MAX_PENDING_UPLOADS = 10;
export const UPLOADS_PER_HOUR = 30;

export const TRANSCODE_JOB = "media.transcode";
export const IMAGE_JOB = "media.image";
export const FILE_JOB = "media.file";

/** Sniffed from ffprobe's format_name; anything else (HLS/concat playlists, ...) is refused. */
export const ALLOWED_VIDEO_FORMATS: ReadonlySet<string> = new Set(["mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"]);
export const IMAGE_FORMAT_FOR_MIME: Readonly<Record<string, string>> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };
/** Two attempts: the second covers a transient storage / ffmpeg failure; the final failure marks the asset FAILED. */
export const MEDIA_JOB_ATTEMPTS = 2;

export type MediaKind = "image" | "video" | "file";

export interface MediaRule {
  bucket: MediaBucket;
  mimes: string[];
  maxBytes: number;
  maxDurationSec?: number;
  kind: MediaKind;
}

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm"];
const image: MediaRule = { bucket: "PUBLIC", mimes: IMAGE_MIMES, maxBytes: 10 * MB, kind: "image" };

/** Plan Global Constraints. course_lesson is 5 GB per file in Phase 1; the plan-based quota arrives in Phase 2. */
export const MEDIA_RULES: Record<MediaPurpose, MediaRule> = {
  AVATAR: image,
  BANNER: image,
  THUMBNAIL: image,
  GIG_GALLERY: image,
  REEL: { bucket: "PUBLIC", mimes: VIDEO_MIMES, maxBytes: 200 * MB, maxDurationSec: 90, kind: "video" },
  COURSE_LESSON: { bucket: "PRIVATE", mimes: VIDEO_MIMES, maxBytes: 5 * 1024 * MB, kind: "video" },
  /** A course trailer: public, transcoded like a reel to public HLS, but longer and larger. */
  COURSE_PROMO: { bucket: "PUBLIC", mimes: VIDEO_MIMES, maxBytes: 500 * MB, maxDurationSec: 300, kind: "video" },
  COURSE_RESOURCE: { bucket: "PRIVATE", mimes: ["application/pdf", "application/zip", "application/x-zip-compressed"], maxBytes: 100 * MB, kind: "file" },
};

const CREATOR_PURPOSES: ReadonlySet<MediaPurpose> = new Set(["REEL", "COURSE_LESSON", "COURSE_RESOURCE", "COURSE_PROMO"]);
export const requiresCreator = (purpose: MediaPurpose) => CREATOR_PURPOSES.has(purpose);

/** API purposes are lower-case (`course_lesson`); the enum is upper-case. */
export const API_PURPOSES = ["avatar", "banner", "thumbnail", "gig_gallery", "reel", "course_lesson", "course_resource", "course_promo"] as const;
export type ApiPurpose = (typeof API_PURPOSES)[number];
export const toPurpose = (p: ApiPurpose): MediaPurpose => p.toUpperCase() as MediaPurpose;
export const toApiPurpose = (p: MediaPurpose): ApiPurpose => p.toLowerCase() as ApiPurpose;

/** Exact byte length of every part: PART_SIZE each, the last one carries the remainder. */
export function partSizes(totalBytes: number): number[] {
  const count = Math.ceil(totalBytes / PART_SIZE);
  return Array.from({ length: count }, (_, i) => (i < count - 1 ? PART_SIZE : totalBytes - PART_SIZE * (count - 1)));
}

/** `overrides` carries admin-configured limits (platform settings) that replace the static defaults. */
export function validateUpload(purpose: MediaPurpose, mime: string, size: number, overrides: { maxBytes?: number } = {}): MediaRule {
  const rule: MediaRule = { ...MEDIA_RULES[purpose], ...(overrides.maxBytes !== undefined ? { maxBytes: overrides.maxBytes } : {}) };
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new AppError("VALIDATION_FAILED", 400, "Request validation failed", { fields: { size: ["must be a positive integer number of bytes"] } });
  }
  if (!rule.mimes.includes(mime.toLowerCase())) {
    throw new AppError("MEDIA_TYPE_NOT_ALLOWED", 415, `This file type is not allowed for ${toApiPurpose(purpose)}`, { allowed: rule.mimes });
  }
  if (size > rule.maxBytes) {
    throw new AppError("MEDIA_TOO_LARGE", 413, `File exceeds the ${Math.floor(rule.maxBytes / MB)} MB limit for ${toApiPurpose(purpose)}`, { maxBytes: rule.maxBytes });
  }
  return rule;
}

/** Key layout: `{purpose}/{ownerId}/{assetId}/...`. Everything the pipeline produces lives under this prefix. */
export const assetPrefix = (a: { purpose: MediaPurpose; ownerId: string; id: string }) => `${toApiPurpose(a.purpose)}/${a.ownerId}/${a.id}`;
