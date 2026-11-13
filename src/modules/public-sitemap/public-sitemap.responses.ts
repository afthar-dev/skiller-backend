import { objectSchema, pageSchema, schemas } from "../../common/openapi/responses";

const { str, isoDate } = schemas;

/** One public page the web may list in a sitemap: the slug (the handle of a profile, the tag of a hashtag) and when it last changed. */
export const sitemapItemSchema = objectSchema({ slug: str, updatedAt: isoDate });
export const sitemapPageSchema = pageSchema(sitemapItemSchema);
