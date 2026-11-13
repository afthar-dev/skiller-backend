import { AppError } from "../../common/errors/app-error";

export const SITEMAP_KINDS = ["courses", "gigs", "profiles", "categories", "hashtags"] as const;
export type SitemapKind = (typeof SITEMAP_KINDS)[number];

/** Items per page: the sitemap protocol allows 50,000 per file; the web splits at 1,000. */
export const SITEMAP_PAGE_SIZE = 1000;

export const isSitemapKind = (value: string): value is SitemapKind => (SITEMAP_KINDS as readonly string[]).includes(value);

export const sitemapKindNotFound = () => new AppError("SITEMAP_KIND_NOT_FOUND", 404, "Unknown sitemap kind");
