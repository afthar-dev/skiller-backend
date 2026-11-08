import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type GigStatus, type GigTier } from "@prisma/client";
import { CLOCK, type Clock } from "../../common/clock/clock";
import { AppError } from "../../common/errors/app-error";
import { toPage, type PageQuery } from "../../common/http/pagination";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditService } from "../audit";
import { EntitlementsService } from "../billing";
import { assertSafeMarkdown, CourseCategories, firstFreeSlug, randomSlug, slugify } from "../courses";
import { MediaAttachments } from "../media";
import { assertValidPackagePrice, COUNTED_STATUSES, EDITABLE_STATUSES, gigNotFound, notPublishable, reasonsNotPublishable, stateInvalid } from "./gig-rules";
import { toGigView, type GigRow } from "./gig-view";

export interface PackageInput {
  tier: GigTier;
  name: string;
  description: string;
  pricePaise: bigint;
  deliveryDays: number;
  revisions: number;
  features: string[];
}

export interface GigFields {
  title: string;
  description: string;
  categoryId: string;
  tags: string[];
  packages: PackageInput[];
  faqs: Array<{ question: string; answer: string }>;
  coverAssetId: string | null;
  galleryAssetIds: string[];
}

export type CreateGigInput = Omit<GigFields, "coverAssetId" | "galleryAssetIds"> & Partial<Pick<GigFields, "coverAssetId" | "galleryAssetIds">>;
export type UpdateGigInput = Partial<GigFields>;

export interface ActionMeta {
  ip?: string;
  requestId?: string;
}

const INCLUDE = { packages: true, gallery: true, faqs: true } as const;
const TX_OPTIONS = { timeout: 15_000, maxWait: 15_000 } as const;
const isSlugTaken = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && String((err.meta?.target as string[] | string | undefined) ?? "").includes("slug");
const mediaNotUsable = () => new AppError("MEDIA_NOT_USABLE", 422, "This picture cannot be used here: it must be your own, fully processed upload of the right type");

/** The seller's side of gigs: create, edit, go live, pause, delete. Public reads live in GigsPublicService. */
@Injectable()
export class GigsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaAttachments,
    private readonly categories: CourseCategories,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(sellerId: string, input: CreateGigInput): Promise<ReturnType<typeof toGigView>> {
    this.assertPrices(input.packages);
    await this.assertCategory(input.categoryId);
    const description = assertSafeMarkdown(input.description);
    const base = slugify(input.title) || randomSlug("gig");
    for (let attempt = 0; ; attempt++) {
      const slug = await this.freeSlug(base, attempt);
      try {
        const row = await this.prisma.$transaction(async (tx) => {
          const gig = await tx.gig.create({
            data: { sellerId, slug, title: input.title, description, categoryId: input.categoryId, tags: input.tags },
          });
          await tx.gigPackage.createMany({ data: input.packages.map((p) => ({ gigId: gig.id, ...p })) });
          await this.refreshStartingPrice(tx, gig.id);
          await tx.gigFaq.createMany({ data: input.faqs.map((f, position) => ({ gigId: gig.id, ...f, position })) });
          if (input.coverAssetId) {
            await this.useAsset(tx, sellerId, input.coverAssetId, "THUMBNAIL");
            await tx.gig.update({ where: { id: gig.id }, data: { coverAssetId: input.coverAssetId } });
          }
          const gallery = input.galleryAssetIds ?? [];
          for (const assetId of gallery) await this.useAsset(tx, sellerId, assetId, "GIG_GALLERY");
          await tx.gigGalleryItem.createMany({ data: gallery.map((assetId, position) => ({ gigId: gig.id, assetId, position })) });
          return tx.gig.findUniqueOrThrow({ where: { id: gig.id }, include: INCLUDE });
        }, TX_OPTIONS);
        return toGigView(row);
      } catch (err) {
        if (!isSlugTaken(err) || attempt >= 6) throw err;
      }
    }
  }

  async list(sellerId: string, page: PageQuery, status?: GigStatus) {
    const rows = await this.prisma.gig.findMany({
      where: { sellerId, status: status ?? { not: "DELETED" }, ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      include: INCLUDE,
      orderBy: { id: "desc" },
      take: page.limit + 1,
    });
    const { items, nextCursor } = toPage(rows, page.limit);
    return { items: items.map(toGigView), nextCursor };
  }

  async get(sellerId: string, id: string) {
    return toGigView(await this.owned(sellerId, id));
  }

  async update(sellerId: string, id: string, patch: UpdateGigInput) {
    await this.owned(sellerId, id);
    if (patch.packages) this.assertPrices(patch.packages);
    if (patch.categoryId !== undefined) await this.assertCategory(patch.categoryId);
    const description = patch.description === undefined ? undefined : assertSafeMarkdown(patch.description);

    const row = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockOwned(tx, sellerId, id);
      if (!EDITABLE_STATUSES.includes(current.status)) throw stateInvalid("This gig is under review or taken down and cannot be edited");
      const data: Prisma.GigUncheckedUpdateInput = {};
      if (patch.title !== undefined) data.title = patch.title;
      if (description !== undefined) data.description = description;
      if (patch.categoryId !== undefined) data.categoryId = patch.categoryId;
      if (patch.tags !== undefined) data.tags = patch.tags;

      if (patch.coverAssetId !== undefined && patch.coverAssetId !== current.coverAssetId) {
        if (patch.coverAssetId) await this.useAsset(tx, sellerId, patch.coverAssetId, "THUMBNAIL");
        if (current.coverAssetId) await this.media.detach(tx, current.coverAssetId);
        data.coverAssetId = patch.coverAssetId;
      }
      if (patch.galleryAssetIds !== undefined) {
        const before = new Set(current.gallery.map((i) => i.assetId));
        const after = new Set(patch.galleryAssetIds);
        for (const assetId of patch.galleryAssetIds) if (!before.has(assetId)) await this.useAsset(tx, sellerId, assetId, "GIG_GALLERY");
        for (const assetId of before) if (!after.has(assetId)) await this.media.detach(tx, assetId);
        await tx.gigGalleryItem.deleteMany({ where: { gigId: id } });
        await tx.gigGalleryItem.createMany({ data: patch.galleryAssetIds.map((assetId, position) => ({ gigId: id, assetId, position })) });
      }
      if (patch.packages) {
        await tx.gigPackage.deleteMany({ where: { gigId: id } });
        await tx.gigPackage.createMany({ data: patch.packages.map((p) => ({ gigId: id, ...p })) });
        await this.refreshStartingPrice(tx, id);
      }
      if (patch.faqs) {
        await tx.gigFaq.deleteMany({ where: { gigId: id } });
        await tx.gigFaq.createMany({ data: patch.faqs.map((f, position) => ({ gigId: id, ...f, position })) });
      }
      await tx.gig.update({ where: { id }, data });
      const updated = await tx.gig.findUniqueOrThrow({ where: { id }, include: INCLUDE });
      // A live gig stays complete: an edit that would leave it without a cover or description is refused.
      if (updated.status === "ACTIVE") {
        const reasons = reasonsNotPublishable(updated, updated.packages.map((p) => p.tier));
        if (reasons.length > 0) throw notPublishable(reasons);
      }
      return updated;
    }, TX_OPTIONS);
    return toGigView(row);
  }

  /** DRAFT or PAUSED -> ACTIVE (the first time stamps publishedAt). Already live is a no-op. The plan's `max_active_gigs` is checked under a lock per seller, so parallel calls cannot exceed it. */
  async activate(sellerId: string, id: string, meta: ActionMeta = {}) {
    await this.owned(sellerId, id);
    // Read before the transaction: inside it this needs a second pooled connection, and parallel activations then starve the pool (P2024 -> 500).
    const limit = await this.entitlements.limit({ ownerType: "USER", ownerId: sellerId }, "max_active_gigs");
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gig-seller:${sellerId}`}))`;
      const gig = await this.lockOwned(tx, sellerId, id);
      if (gig.status === "ACTIVE") return gig;
      if (gig.status !== "DRAFT" && gig.status !== "PAUSED") throw stateInvalid("This gig is under review or taken down and cannot go live");
      const reasons = reasonsNotPublishable(gig, gig.packages.map((p) => p.tier));
      if (reasons.length > 0) throw notPublishable(reasons);
      const others = await tx.gig.count({ where: { sellerId, status: { in: [...COUNTED_STATUSES] }, id: { not: id } } });
      this.entitlements.enforce("max_active_gigs", limit, others + 1);
      await tx.gig.update({ where: { id }, data: { status: "ACTIVE", publishedAt: gig.publishedAt ?? this.clock.now() } });
      await this.audit.record(tx, { actorId: sellerId, action: "gig.activate", targetType: "gig", targetId: id, before: { status: gig.status }, after: { status: "ACTIVE" }, ...meta });
      return tx.gig.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    }, TX_OPTIONS);
    return toGigView(row);
  }

  /** ACTIVE -> PAUSED: off every public surface; the slot is free again. Already paused is a no-op. */
  async pause(sellerId: string, id: string, meta: ActionMeta = {}) {
    await this.owned(sellerId, id);
    const row = await this.prisma.$transaction(async (tx) => {
      const gig = await this.lockOwned(tx, sellerId, id);
      if (gig.status === "PAUSED") return gig;
      if (gig.status !== "ACTIVE") throw stateInvalid("Only a live gig can be paused");
      await tx.gig.update({ where: { id }, data: { status: "PAUSED" } });
      await this.audit.record(tx, { actorId: sellerId, action: "gig.pause", targetType: "gig", targetId: id, before: { status: "ACTIVE" }, after: { status: "PAUSED" }, ...meta });
      return tx.gig.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    }, TX_OPTIONS);
    return toGigView(row);
  }

  /** Soft delete: the row and its address stay, the pictures are released. Deleting twice is harmless. */
  async remove(sellerId: string, id: string, meta: ActionMeta = {}): Promise<void> {
    const found = await this.prisma.gig.findUnique({ where: { id }, select: { sellerId: true } });
    if (!found || found.sellerId !== sellerId) throw gigNotFound();
    await this.prisma.$transaction(async (tx) => {
      const gig = await this.lockOwned(tx, sellerId, id, true);
      if (gig.status === "DELETED") return;
      for (const assetId of [gig.coverAssetId, ...gig.gallery.map((i) => i.assetId)]) if (assetId) await this.media.detach(tx, assetId);
      await tx.gigGalleryItem.deleteMany({ where: { gigId: id } });
      await tx.gig.update({ where: { id }, data: { status: "DELETED", coverAssetId: null } });
      await this.audit.record(tx, { actorId: sellerId, action: "gig.delete", targetType: "gig", targetId: id, before: { status: gig.status }, after: { status: "DELETED" }, ...meta });
    }, TX_OPTIONS);
  }

  /** How many gigs of this seller count against the plan. */
  countedFor(sellerId: string): Promise<number> {
    return this.prisma.gig.count({ where: { sellerId, status: { in: [...COUNTED_STATUSES] } } });
  }

  /** The catalog filters and sorts on the lowest package price; call in the transaction that writes the packages. */
  private async refreshStartingPrice(tx: Prisma.TransactionClient, gigId: string): Promise<void> {
    await tx.$executeRaw`UPDATE "gigs" SET "startingPricePaise" = (SELECT min("pricePaise") FROM "gig_packages" WHERE "gigId" = ${gigId}) WHERE "id" = ${gigId}`;
  }

  private async owned(sellerId: string, id: string): Promise<GigRow> {
    const gig = await this.prisma.gig.findUnique({ where: { id }, include: INCLUDE });
    if (!gig || gig.sellerId !== sellerId || gig.status === "DELETED") throw gigNotFound();
    return gig;
  }

  /** The seller's gig under its row lock (serialises edits, activation and deletion). */
  private async lockOwned(tx: Prisma.TransactionClient, sellerId: string, id: string, allowDeleted = false): Promise<GigRow> {
    await tx.$queryRaw`SELECT "id" FROM "gigs" WHERE "id" = ${id} FOR UPDATE`;
    const gig = await tx.gig.findUnique({ where: { id }, include: INCLUDE });
    if (!gig || gig.sellerId !== sellerId || (gig.status === "DELETED" && !allowDeleted)) throw gigNotFound();
    return gig;
  }

  /** Attaches an upload to the gig: the seller's own personal upload of this purpose that finished processing. */
  private async useAsset(tx: Prisma.TransactionClient, sellerId: string, assetId: string, purpose: "THUMBNAIL" | "GIG_GALLERY"): Promise<void> {
    const info = await this.media.assetInfo(assetId);
    if (!info || info.ownerId !== sellerId || info.orgId !== null || info.purpose !== purpose || info.status !== "READY") throw mediaNotUsable();
    await this.media.attach(tx, assetId, sellerId, purpose);
  }

  private assertPrices(packages: PackageInput[]): void {
    packages.forEach((p, i) => assertValidPackagePrice(p.pricePaise, `packages[${i}].pricePaise`));
  }

  private async assertCategory(categoryId: string): Promise<void> {
    if (!(await this.categories.isActive(categoryId))) throw new AppError("CATEGORY_INVALID", 422, "Choose an existing, active category");
  }

  private async freeSlug(base: string, attempt: number): Promise<string> {
    if (attempt >= 3) return randomSlug(base.slice(0, 50));
    const taken = new Set((await this.prisma.gig.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((g) => g.slug));
    return firstFreeSlug(base, taken);
  }
}
