const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Indian financial year (April to March, in IST) of an instant, as it appears in invoice numbers: 2027-02-10 -> "2026-27".
 * The year boundary is midnight IST, not midnight UTC.
 */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1; // getUTCMonth: 0 = January, 3 = April
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export const invoiceNumber = (fy: string, sequence: number): string => `SKL/${fy}/${String(sequence).padStart(6, "0")}`;
