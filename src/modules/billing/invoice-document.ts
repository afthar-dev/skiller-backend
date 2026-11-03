import { join } from "node:path";
import PDFDocument from "pdfkit";
import { formatBps, formatInr } from "./money";

/** Who the platform is on a document; all from platform settings, frozen at issue time. */
export interface PlatformIdentity {
  legalName: string;
  address: string;
  /** Empty until the GST registration is through. */
  gstin: string;
  /** Two-digit GST state code, or empty. */
  stateCode: string;
  /** Service accounting code printed on every line. */
  sacCode: string;
}

/** Everything a tax invoice or credit note prints (amounts are decimal paise strings; a credit note's are negative). Stored as JSON. */
export interface InvoiceDetails {
  docType: "INVOICE" | "CREDIT_NOTE";
  kind: "ORDER" | "SUBSCRIPTION";
  number: string;
  issuedAt: string;
  platform: PlatformIdentity;
  buyer: { name: string; email: string; stateCode?: string | null };
  /** Who sold the item: the creator or organization, or the platform itself for subscriptions. */
  sellerName: string;
  itemTitle: string;
  listPaise: string;
  discountPaise: string;
  totalPaise: string;
  /** GST on the platform fee (orders) or on the whole price (subscriptions). */
  gst: { bps: number; basePaise: string; taxPaise: string; feeTotalPaise: string; baseLabel: string };
  /** Credit notes: the invoice they correct. */
  original?: { number: string; issuedAt: string };
  /** The printed lines, in order. Built by documentLines() at issue time so a retry renders exactly the same document. */
  lines: string[];
}

export type DocumentFacts = Omit<InvoiceDetails, "lines">;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDate = (iso: string) => new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The text of the document, one entry per printed line. Pure: the same facts always give the same lines. */
export function documentLines(f: DocumentFacts): string[] {
  const money = (p: string) => formatInr(BigInt(p));
  const credit = f.docType === "CREDIT_NOTE";
  const placeOfSupply = f.buyer.stateCode || f.platform.stateCode;
  return [
    credit ? "CREDIT NOTE" : "TAX INVOICE",
    f.platform.legalName,
    ...(f.platform.address ? [f.platform.address] : []),
    f.platform.gstin ? `GSTIN: ${f.platform.gstin}` : "GSTIN: applied for",
    `${credit ? "Credit note number" : "Invoice number"}: ${f.number}`,
    `${credit ? "Credit note date" : "Invoice date"}: ${istDate(f.issuedAt)}`,
    ...(credit && f.original ? [`Against invoice: ${f.original.number} dated ${istDate(f.original.issuedAt)}`] : []),
    `Place of supply: ${placeOfSupply ? `State code ${placeOfSupply}` : "Not available"}`,
    "",
    credit ? "Refunded to" : "Billed to",
    f.buyer.name,
    f.buyer.email,
    "",
    `Sold by: ${f.sellerName}`,
    "",
    `Item: ${f.itemTitle}`,
    `SAC: ${f.platform.sacCode}`,
    `List price: ${money(f.listPaise)}`,
    `Discount: ${money(f.discountPaise)}`,
    `${credit ? "Total refunded" : "Total paid"}: ${money(f.totalPaise)}`,
    "",
    `${f.gst.baseLabel}: ${money(f.gst.basePaise)}`,
    `GST (${formatBps(f.gst.bps)}) on platform fee: ${money(f.gst.taxPaise)}`,
    `Platform fee including GST: ${money(f.gst.feeTotalPaise)}`,
    "",
    credit ? "This credit note reverses the invoice above in full. It is a computer generated document." : "Prices are inclusive of GST. This is a computer generated invoice.",
  ];
}

// ── Fonts ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// assets/fonts is at the project root: three levels up from both src/modules/billing (tests) and dist/modules/billing (the images).
const FONT_DIR = join(__dirname, "..", "..", "..", "assets", "fonts");
const FONTS = {
  latin: { regular: join(FONT_DIR, "NotoSans_400Regular.ttf"), bold: join(FONT_DIR, "NotoSans_700Bold.ttf") },
  devanagari: { regular: join(FONT_DIR, "NotoSansDevanagari_400Regular.ttf"), bold: join(FONT_DIR, "NotoSansDevanagari_700Bold.ttf") },
} as const;

const isDevanagari = (ch: string): boolean => {
  const c = ch.codePointAt(0)!;
  return (c >= 0x0900 && c <= 0x097f) || (c >= 0xa8e0 && c <= 0xa8ff) || (c >= 0x1cd0 && c <= 0x1cff);
};
/** Spaces, digits, punctuation and symbols belong to whichever script run they sit in. */
const NEUTRAL = /^[\s\p{N}\p{P}\p{S}]$/u;

export interface TextRun {
  text: string;
  devanagari: boolean;
}

/** Splits a line into runs of one script, so each run can be set in the font that has its glyphs. */
export function splitRuns(line: string): TextRun[] {
  const runs: TextRun[] = [];
  for (const ch of line) {
    const isDev = isDevanagari(ch);
    const last = runs[runs.length - 1];
    if (last && (NEUTRAL.test(ch) || last.devanagari === isDev)) last.text += ch;
    else runs.push({ text: ch, devanagari: isDev });
  }
  // A leading neutral run (e.g. "  "): its script is that of the next letter run, so merge it forward.
  if (runs.length > 1 && !/[\p{L}\p{M}]/u.test(runs[0].text)) {
    const first = runs.shift()!;
    runs[0].text = first.text + runs[0].text;
  }
  return runs;
}

/** Renders the stored lines as a PDF. Latin text uses Noto Sans, Devanagari runs Noto Sans Devanagari (both embedded as subsets). */
export function renderInvoicePdf(details: InvoiceDetails): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: `${details.docType === "CREDIT_NOTE" ? "Credit note" : "Invoice"} ${details.number}`, Author: details.platform.legalName } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      doc.registerFont("latin", FONTS.latin.regular);
      doc.registerFont("latin-bold", FONTS.latin.bold);
      doc.registerFont("dev", FONTS.devanagari.regular);
      doc.registerFont("dev-bold", FONTS.devanagari.bold);
      details.lines.forEach((line, i) => {
        const bold = i <= 1 || line === "Billed to" || line === "Refunded to";
        const size = i === 0 ? 20 : i === 1 ? 12 : 10;
        if (line === "") {
          doc.font("latin").fontSize(10).text(" ");
          return;
        }
        const runs = splitRuns(line);
        runs.forEach((run, j) => {
          doc.font(`${run.devanagari ? "dev" : "latin"}${bold ? "-bold" : ""}`).fontSize(size).text(run.text, { continued: j < runs.length - 1 });
        });
      });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
