import type { Prisma } from "@prisma/client";
import type { SettingsService } from "../admin";
import { documentNumber, financialYear, type DocumentSeries } from "./fiscal-year";
import type { PlatformIdentity } from "./invoice-document";

/**
 * Takes the next number of a series for the financial year of `at`. The counter row is created if missing and then updated in one
 * statement, which locks it until the caller's transaction ends: concurrent issuers queue, numbers are sequential, and an attempt that
 * rolls back (for example a duplicate losing on a unique key) gives its number back, so there are no gaps.
 */
export async function allocateNumber(tx: Prisma.TransactionClient, series: DocumentSeries, at: Date): Promise<string> {
  const fy = financialYear(at);
  const key = `${series}/${fy}`;
  await tx.$executeRaw`INSERT INTO invoice_counters ("fy", "lastNumber") VALUES (${key}, 0) ON CONFLICT ("fy") DO NOTHING`;
  const rows = await tx.$queryRaw<{ lastNumber: number }[]>`UPDATE invoice_counters SET "lastNumber" = "lastNumber" + 1 WHERE "fy" = ${key} RETURNING "lastNumber"`;
  return documentNumber(series, fy, rows[0].lastNumber);
}

export async function platformIdentity(settings: SettingsService): Promise<PlatformIdentity> {
  const [legalName, address, gstin, stateCode, sacCode] = await Promise.all([
    settings.get("platform_legal_name"),
    settings.get("platform_address"),
    settings.get("platform_gstin"),
    settings.get("platform_state_code"),
    settings.get("sac_code"),
  ]);
  return { legalName, address, gstin, stateCode, sacCode };
}

export const invoiceKey = (invoiceId: string) => `invoices/${invoiceId}.pdf`;
export const creditNoteKey = (creditNoteId: string) => `credit-notes/${creditNoteId}.pdf`;
