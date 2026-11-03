import type { MediaBucket, MediaPurpose } from "@prisma/client";
import { AppError } from "../../common/errors/app-error";

const MB = 1024 * 1024;

export const PART_SIZE = 10 * MB;
export const PRESIGN_TTL_SEC = 3600;

export const TRANSCODE_JOB = "media.transcode";
export const IMAGE_JOB = "media.image";
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
  COURSE_RESOURCE: { bucket: "PRIVATE", mimes: ["application/pdf", "application/zip", "application/x-zip-compressed"], maxBytes: 100 * MB, kind: "file" },
};

const CREATOR_PURPOSES: ReadonlySet<MediaPurpose> = new Set(["REEL", "COURSE_LESSON", "COURSE_RESOURCE"]);
export const requiresCreator = (purpose: MediaPurpose) => CREATOR_PURPOSES.has(purpose);

/** API purposes are lower-case (`course_lesson`); the enum is upper-case. */
export const API_PURPOSES = ["avatar", "banner", "thumbnail", "gig_gallery", "reel", "course_lesson", "course_resource"] as const;
export type ApiPurpose = (typeof API_PURPOSES)[number];
export const toPurpose = (p: ApiPurpose): MediaPurpose => p.toUpperCase() as MediaPurpose;
export const toApiPurpose = (p: MediaPurpose): ApiPurpose => p.toLowerCase() as ApiPurpose;

export function validateUpload(purpose: MediaPurpose, mime: string, size: number): MediaRule {
  const rule = MEDIA_RULES[purpose];
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
