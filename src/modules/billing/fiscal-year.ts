const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Indian financial year (April to March, in IST) of an instant, in the short form used in document numbers: 2027-02-10 -> "26-27".
 * The year boundary is midnight IST, not midnight UTC.
 */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1; // getUTCMonth: 0 = January, 3 = April
  const yy = (y: number) => String(y % 100).padStart(2, "0");
  return `${yy(start)}-${yy(start + 1)}`;
}

/** GST caps a document serial number at 16 characters: "SKL/26-27/000001" is exactly 16. */
export type DocumentSeries = "SKL" | "SKC";
export const SERIES_FOR = { INVOICE: "SKL", CREDIT_NOTE: "SKC" } as const satisfies Record<string, DocumentSeries>;
export const documentNumber = (series: DocumentSeries, fy: string, sequence: number): string => `${series}/${fy}/${String(sequence).padStart(6, "0")}`;
