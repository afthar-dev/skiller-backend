-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "buyerUserId" TEXT,
    "sellerOwnerType" "SellerOwnerType",
    "sellerOwnerId" TEXT,
    "objectKey" TEXT NOT NULL,
    "totalPaise" BIGINT NOT NULL,
    "taxPaise" BIGINT NOT NULL,
    "details" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_number_key" ON "credit_notes"("number");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_refundId_key" ON "credit_notes"("refundId");

-- CreateIndex
CREATE INDEX "credit_notes_buyerUserId_id_idx" ON "credit_notes"("buyerUserId", "id");

-- CreateIndex
CREATE INDEX "credit_notes_uploadedAt_createdAt_idx" ON "credit_notes"("uploadedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
