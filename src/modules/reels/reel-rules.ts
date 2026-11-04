import { AppError } from "../../common/errors/app-error";

export const CAPTION_MAX = 2200;
/** Statuses a creator may still edit; the rest are decided by moderation or are over. */
export const EDITABLE_STATUSES: readonly string[] = ["PROCESSING", "PUBLISHED", "LIMIT_REACHED"];
/** The reel counts toward hashtag totals exactly while it has this status. */
export const COUNTED_STATUS = "PUBLISHED";

export const reelNotFound = () => new AppError("REEL_NOT_FOUND", 404, "Reel not found");
export const mediaNotUsable = (status = 422) => new AppError("MEDIA_NOT_USABLE", status, "This video cannot be used for a reel: it must be your own upload of the reel type that did not fail processing");
export const courseNotLinkable = () => new AppError("COURSE_NOT_LINKABLE", 422, "You can link only a published course that you author");
export const stateInvalid = (message: string) => new AppError("REEL_STATE_INVALID", 409, message);
