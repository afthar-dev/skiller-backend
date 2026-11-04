import type { Category, Course } from "@prisma/client";

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
    ratingAvg: c.ratingAvg === null ? null : Number(c.ratingAvg.toString()),
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
