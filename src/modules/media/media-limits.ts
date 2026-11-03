import type { MediaPurpose } from "@prisma/client";
import type { SettingsService } from "../admin";
import { MEDIA_RULES } from "./media.rules";

const MB = 1024 * 1024;

/**
 * The effective upload size cap for a purpose. The single source for both `createUpload` (API) and the worker's source check:
 * admin-configurable purposes read the platform setting, everything else uses the static rule.
 */
export async function effectiveMaxBytes(settings: Pick<SettingsService, "get">, purpose: MediaPurpose): Promise<number> {
  if (purpose === "COURSE_LESSON") return (await settings.get("max_upload_mb_course_lesson")) * MB;
  return MEDIA_RULES[purpose].maxBytes;
}
