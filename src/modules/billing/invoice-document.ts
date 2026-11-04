import PDFDocument from "pdfkit";
import { registerNotoFonts, splitRuns, writeRuns, type TextRun } from "../../common/pdf/pdf-text";
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

// Fonts and script-run splitting are shared with other documents (certificates): see src/common/pdf/pdf-text.ts.
export { splitRuns };
export type { TextRun };

/** Renders the stored lines as a PDF. Latin text uses Noto Sans, Devanagari runs Noto Sans Devanagari (both embedded as subsets). */
export function renderInvoicePdf(details: InvoiceDetails): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: `${details.docType === "CREDIT_NOTE" ? "Credit note" : "Invoice"} ${details.number}`, Author: details.platform.legalName } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      registerNotoFonts(doc);
      details.lines.forEach((line, i) => {
        const bold = i <= 1 || line === "Billed to" || line === "Refunded to";
        const size = i === 0 ? 20 : i === 1 ? 12 : 10;
        if (line === "") {
          doc.font("latin").fontSize(10).text(" ");
          return;
        }
        writeRuns(doc, line, { size, bold });
      });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
