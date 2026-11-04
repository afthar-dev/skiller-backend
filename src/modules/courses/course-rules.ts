import { randomBytes } from "node:crypto";
import { AppError } from "../../common/errors/app-error";

/** ISO 639-1 codes courses may be taught in: the Indian languages the platform serves plus common world languages. */
export const COURSE_LANGUAGES = ["en", "hi", "ta", "te", "bn", "mr", "gu", "kn", "ml", "pa", "ur", "or", "as", "fr", "de", "es", "ar", "zh", "ja"] as const;
export const COURSE_LEVELS = ["BEGINNER", "INTERMEDIATE", "ADVANCED", "ALL"] as const;

/** Free, or between 99 and 1,00,000 rupees (paise). */
export const MIN_PAID_PRICE_PAISE = 9_900n;
export const MAX_PRICE_PAISE = 10_000_000n;

export function assertValidCoursePrice(pricePaise: bigint): void {
  if (pricePaise === 0n) return;
  if (pricePaise < MIN_PAID_PRICE_PAISE || pricePaise > MAX_PRICE_PAISE) {
    throw new AppError("COURSE_PRICE_INVALID", 422, "A course is free or costs between Rs 99 and Rs 1,00,000", {
      minPaise: MIN_PAID_PRICE_PAISE.toString(),
      maxPaise: MAX_PRICE_PAISE.toString(),
    });
  }
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** ASCII-folded kebab-case. Returns "" when nothing ASCII is left (e.g. a Devanagari title): callers then use randomSlug(). */
export function slugify(text: string, maxLength = 60): string {
  const folded = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return folded.slice(0, maxLength).replace(/-+$/g, "");
}

export function randomSlug(prefix = "course"): string {
  const suffix = Array.from(randomBytes(6), (b) => (b % 36).toString(36)).join("");
  return `${prefix}-${suffix}`;
}

/** The first of `base`, `base-2`, `base-3`, ... that is not taken. */
export function firstFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
