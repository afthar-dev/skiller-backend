import type { Gig, GigFaq, GigGalleryItem, GigPackage } from "@prisma/client";
import type { ProfileSummary } from "../users";
import { GIG_PAYMENT_NOTICE } from "./gig-rules";

export type GigRow = Gig & { packages: GigPackage[]; gallery: GigGalleryItem[]; faqs: GigFaq[] };

const TIER_ORDER: Record<string, number> = { BASIC: 0, STANDARD: 1, PREMIUM: 2 };

export const toPackageView = (p: GigPackage) => ({
  tier: p.tier,
  name: p.name,
  description: p.description,
  pricePaise: p.pricePaise.toString(),
  deliveryDays: p.deliveryDays,
  revisions: p.revisions,
  features: p.features,
});

const packagesOf = (g: GigRow) => [...g.packages].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]).map(toPackageView);
const galleryOf = (g: GigRow) => [...g.gallery].sort((a, b) => a.position - b.position).map((i) => i.assetId);
const faqsOf = (g: GigRow) => [...g.faqs].sort((a, b) => a.position - b.position).map((f) => ({ question: f.question, answer: f.answer }));

/** The seller's own view, in whatever state the gig is in. */
export const toGigView = (g: GigRow) => ({
  id: g.id,
  sellerId: g.sellerId,
  slug: g.slug,
  title: g.title,
  description: g.description,
  categoryId: g.categoryId,
  tags: g.tags,
  status: g.status,
  coverAssetId: g.coverAssetId,
  galleryAssetIds: galleryOf(g),
  packages: packagesOf(g),
  faqs: faqsOf(g),
  createdAt: g.createdAt.toISOString(),
  updatedAt: g.updatedAt.toISOString(),
  publishedAt: g.publishedAt?.toISOString() ?? null,
  paymentNotice: GIG_PAYMENT_NOTICE,
});

/** What anyone sees of a live gig. `paymentNotice` is a stable field: clients show it as given next to the packages and on the inquiry screen. */
export const toPublicGigView = (g: GigRow, seller: ProfileSummary | null) => ({
  id: g.id,
  slug: g.slug,
  title: g.title,
  description: g.description,
  categoryId: g.categoryId,
  tags: g.tags,
  coverAssetId: g.coverAssetId,
  galleryAssetIds: galleryOf(g),
  packages: packagesOf(g),
  faqs: faqsOf(g),
  seller,
  publishedAt: g.publishedAt?.toISOString() ?? null,
  paymentNotice: GIG_PAYMENT_NOTICE,
});

/** A gig in a list: no description, FAQs or gallery; the lowest package price stands in for "from". */
export const toGigCard = (g: Gig & { packages: GigPackage[] }) => {
  const prices = g.packages.map((p) => p.pricePaise);
  const lowest = prices.length > 0 ? prices.reduce((a, b) => (a < b ? a : b)) : null;
  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    categoryId: g.categoryId,
    tags: g.tags,
    coverAssetId: g.coverAssetId,
    startingPricePaise: lowest === null ? null : lowest.toString(),
    sellerId: g.sellerId,
    publishedAt: g.publishedAt?.toISOString() ?? null,
  };
};
