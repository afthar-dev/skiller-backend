-- CreateEnum
CREATE TYPE "GigStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'HIDDEN', 'REMOVED', 'DELETED');

-- CreateEnum
CREATE TYPE "GigTier" AS ENUM ('BASIC', 'STANDARD', 'PREMIUM');

-- CreateEnum
CREATE TYPE "GigOrderStatus" AS ENUM ('PENDING');

-- CreateTable
CREATE TABLE "gigs" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "categoryId" TEXT NOT NULL,
    "tags" TEXT[],
    "status" "GigStatus" NOT NULL DEFAULT 'DRAFT',
    "coverAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "gigs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gig_packages" (
    "gigId" TEXT NOT NULL,
    "tier" "GigTier" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "pricePaise" BIGINT NOT NULL,
    "deliveryDays" INTEGER NOT NULL,
    "revisions" INTEGER NOT NULL,
    "features" TEXT[],

    CONSTRAINT "gig_packages_pkey" PRIMARY KEY ("gigId","tier")
);

-- CreateTable
CREATE TABLE "gig_gallery_items" (
    "gigId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "gig_gallery_items_pkey" PRIMARY KEY ("gigId","assetId")
);

-- CreateTable
CREATE TABLE "gig_faqs" (
    "id" TEXT NOT NULL,
    "gigId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "gig_faqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gig_orders" (
    "id" TEXT NOT NULL,
    "gigId" TEXT NOT NULL,
    "packageTier" "GigTier" NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "pricePaise" BIGINT NOT NULL,
    "status" "GigOrderStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gig_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gigs_slug_key" ON "gigs"("slug");

-- CreateIndex
CREATE INDEX "gigs_sellerId_status_id_idx" ON "gigs"("sellerId", "status", "id");

-- CreateIndex
CREATE INDEX "gigs_categoryId_idx" ON "gigs"("categoryId");

-- CreateIndex
CREATE INDEX "gig_gallery_items_gigId_position_idx" ON "gig_gallery_items"("gigId", "position");

-- CreateIndex
CREATE INDEX "gig_faqs_gigId_position_idx" ON "gig_faqs"("gigId", "position");

-- CreateIndex
CREATE INDEX "gig_orders_gigId_idx" ON "gig_orders"("gigId");

-- CreateIndex
CREATE INDEX "gig_orders_buyerId_idx" ON "gig_orders"("buyerId");

-- CreateIndex
CREATE INDEX "gig_orders_sellerId_idx" ON "gig_orders"("sellerId");

-- AddForeignKey
ALTER TABLE "gigs" ADD CONSTRAINT "gigs_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gig_packages" ADD CONSTRAINT "gig_packages_gigId_fkey" FOREIGN KEY ("gigId") REFERENCES "gigs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gig_gallery_items" ADD CONSTRAINT "gig_gallery_items_gigId_fkey" FOREIGN KEY ("gigId") REFERENCES "gigs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gig_faqs" ADD CONSTRAINT "gig_faqs_gigId_fkey" FOREIGN KEY ("gigId") REFERENCES "gigs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
