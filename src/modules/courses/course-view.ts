import type { Category, Course } from "@prisma/client";
import { MIN_RATINGS_TO_SHOW } from "./course-rating";

export interface CourseView {
  id: string;
  ownerType: Course["ownerType"];
  ownerId: string;
  slug: string;
  slugLocked: boolean;
  title: string;
  subtitle: string | null;
  description: string;
  categoryId: string;
  level: Course["level"];
  language: string;
  tags: string[];
  pricePaise: string;
  thumbnailAssetId: string | null;
  promoVideoAssetId: string | null;
  status: Course["status"];
  flaggedAt: string | null;
  flagReason: string | null;
  submittedAt: string | null;
  rejectionReason: string | null;
  publishedAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  ratingAvg: number | null;
  ratingCount: number;
  enrolmentCount: number;
}

export function toCourseView(c: Course): CourseView {
  return {
    id: c.id,
    ownerType: c.ownerType,
    ownerId: c.ownerId,
    slug: c.slug,
    slugLocked: c.slugLockedAt !== null,
    title: c.title,
    subtitle: c.subtitle,
    description: c.description,
    categoryId: c.categoryId,
    level: c.level,
    language: c.language,
    tags: c.tags,
    pricePaise: c.pricePaise.toString(),
    thumbnailAssetId: c.thumbnailAssetId,
    promoVideoAssetId: c.promoVideoAssetId,
    status: c.status,
    flaggedAt: c.flaggedAt?.toISOString() ?? null,
    flagReason: c.flagReason,
    submittedAt: c.submittedAt?.toISOString() ?? null,
    rejectionReason: c.rejectionReason,
    publishedAt: c.publishedAt?.toISOString() ?? null,
    createdById: c.createdById,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    ratingAvg: c.ratingCount >= MIN_RATINGS_TO_SHOW && c.ratingAvg !== null ? Number(c.ratingAvg.toString()) : null,
    ratingCount: c.ratingCount,
    enrolmentCount: c.enrolmentCount,
  };
}

export interface CategoryView {
  id: string;
  slug: string;
  name: string;
  position: number;
  isActive: boolean;
}

export const toCategoryView = (c: Category): CategoryView => ({ id: c.id, slug: c.slug, name: c.name, position: c.position, isActive: c.isActive });

/** What anyone may see of a published course: no moderation fields, no draft state. The rating shows once at least 3 learners rated. */
export const toPublicCourseView = (c: Course) => ({
  id: c.id,
  ownerType: c.ownerType,
  ownerId: c.ownerId,
  ownerName: c.ownerName,
  slug: c.slug,
  title: c.title,
  subtitle: c.subtitle,
  description: c.description,
  categoryId: c.categoryId,
  level: c.level,
  language: c.language,
  tags: c.tags,
  pricePaise: c.pricePaise.toString(),
  thumbnailAssetId: c.thumbnailAssetId,
  promoVideoAssetId: c.promoVideoAssetId,
  publishedAt: c.publishedAt?.toISOString() ?? null,
  ratingAvg: c.ratingCount >= MIN_RATINGS_TO_SHOW && c.ratingAvg !== null ? Number(c.ratingAvg.toString()) : null,
  ratingCount: c.ratingCount,
  enrolmentCount: c.enrolmentCount,
});

/** A course in a catalog listing: the public view without the long description. */
export const toCatalogCard = (c: Course) => {
  const { description: _description, ...card } = toPublicCourseView(c);
  return card;
};
