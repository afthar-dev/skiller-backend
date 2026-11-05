import { AppError } from "../../common/errors/app-error";

/** Package prices in paise: 99 to 10,00,000 rupees. Display only: Skiller does not take gig payments. */
export const MIN_PACKAGE_PRICE_PAISE = 9_900n;
export const MAX_PACKAGE_PRICE_PAISE = 100_000_000n;

export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 10_000;
export const TAGS_MAX = 10;
export const TAG_MAX = 30;
export const GALLERY_MAX = 10;
export const FAQS_MAX = 10;
export const FEATURES_MAX = 10;
export const FEATURE_MAX = 100;
export const PACKAGE_NAME_MAX = 60;
export const PACKAGE_DESCRIPTION_MAX = 500;
export const FAQ_QUESTION_MAX = 200;
export const FAQ_ANSWER_MAX = 1000;
export const MAX_DELIVERY_DAYS = 365;
export const MAX_REVISIONS = 100;

export const GIG_TIERS = ["BASIC", "STANDARD", "PREMIUM"] as const;
export type GigTierName = (typeof GIG_TIERS)[number];

/** The seller may still change a gig in these states; HIDDEN and REMOVED are moderation's, DELETED is over. */
export const EDITABLE_STATUSES: readonly string[] = ["DRAFT", "ACTIVE", "PAUSED"];
/** A gig counts against `max_active_gigs` while it is live or held back by a report (a dismissal puts it back live, so the slot stays taken). */
export const COUNTED_STATUSES = ["ACTIVE", "HIDDEN"] as const;

/** Shown on every gig page and in the inquiry screen: Skiller does not take part in the deal. */
export const GIG_PAYMENT_NOTICE =
  "Payments for gigs happen outside Skiller and are not protected by the platform. Agree on scope, price and delivery with the seller in writing before you pay anyone.";

export const gigNotFound = () => new AppError("GIG_NOT_FOUND", 404, "Gig not found");
export const stateInvalid = (message: string) => new AppError("GIG_STATE_INVALID", 409, message);
export const priceInvalid = (field = "pricePaise") =>
  new AppError("GIG_PRICE_INVALID", 422, "A package price must be between 99 and 10,00,000 rupees", { field, minPaise: MIN_PACKAGE_PRICE_PAISE.toString(), maxPaise: MAX_PACKAGE_PRICE_PAISE.toString() });

export function assertValidPackagePrice(pricePaise: bigint, field = "pricePaise"): void {
  if (pricePaise < MIN_PACKAGE_PRICE_PAISE || pricePaise > MAX_PACKAGE_PRICE_PAISE) throw priceInvalid(field);
}

export interface PublishReason {
  code: "NO_DESCRIPTION" | "NO_BASIC_PACKAGE" | "NO_COVER";
  message: string;
}

/** What a gig still lacks to go (or stay) live. */
export function reasonsNotPublishable(gig: { description: string; coverAssetId: string | null }, tiers: readonly string[]): PublishReason[] {
  const reasons: PublishReason[] = [];
  if (gig.description.trim() === "") reasons.push({ code: "NO_DESCRIPTION", message: "Describe what you offer" });
  if (!tiers.includes("BASIC")) reasons.push({ code: "NO_BASIC_PACKAGE", message: "Add a Basic package" });
  if (!gig.coverAssetId) reasons.push({ code: "NO_COVER", message: "Add a cover picture" });
  return reasons;
}

export const notPublishable = (reasons: PublishReason[]) => new AppError("GIG_NOT_PUBLISHABLE", 422, "This gig is not ready to go live", { reasons });
