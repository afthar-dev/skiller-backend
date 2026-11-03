-- CreateEnum
CREATE TYPE "LedgerOwnerType" AS ENUM ('USER', 'ORG', 'PLATFORM');

-- CreateEnum
CREATE TYPE "LedgerAccountKind" AS ENUM ('AVAILABLE', 'PENDING', 'PAYOUT_LOCKED', 'GATEWAY_CLEARING', 'PLATFORM_REVENUE', 'TAX_PAYABLE', 'REFUNDS');

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "ownerType" "LedgerOwnerType" NOT NULL,
    "ownerId" TEXT,
    "kind" "LedgerAccountKind" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_lines" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,

    CONSTRAINT "ledger_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_balances" (
    "accountId" TEXT NOT NULL,
    "balancePaise" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_balances_pkey" PRIMARY KEY ("accountId")
);

-- CreateIndex
-- NULLS NOT DISTINCT: platform accounts have a null ownerId and must still be unique per kind.
CREATE UNIQUE INDEX "ledger_accounts_owner_kind_key" ON "ledger_accounts"("ownerType", "ownerId", "kind") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_refType_refId_description_key" ON "journal_entries"("refType", "refId", "description");

-- CreateIndex
CREATE INDEX "ledger_lines_entryId_idx" ON "ledger_lines"("entryId");

-- CreateIndex
CREATE INDEX "ledger_lines_accountId_idx" ON "ledger_lines"("accountId");

-- AddForeignKey
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
