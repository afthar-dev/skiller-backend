import PDFDocument from "pdfkit";
import { formatBps, formatInr } from "./money";

/** Everything an invoice prints, frozen when the invoice is issued (amounts are decimal paise strings: it is stored as JSON). */
export interface InvoiceDetails {
  kind: "ORDER" | "SUBSCRIPTION";
  number: string;
  issuedAt: string;
  /** Empty until the platform's GST registration is through. */
  platformGstin: string;
  buyer: { name: string; email: string };
  /** Who sold the item: the creator or organization, or the platform itself for subscriptions. */
  sellerName: string;
  itemTitle: string;
  listPaise: string;
  discountPaise: string;
  totalPaise: string;
  /** GST on the platform fee (orders) or on the whole price (subscriptions). */
  gst: { bps: number; basePaise: string; taxPaise: string; feeTotalPaise: string; baseLabel: string };
  /** The printed lines, in order. Built by invoiceLines() at issue time so a retry renders exactly the same document. */
  lines: string[];
}

export type InvoiceFacts = Omit<InvoiceDetails, "lines">;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDate = (iso: string) => new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The text of the invoice, one entry per printed line. Pure: the same facts always give the same lines. */
export function invoiceLines(f: InvoiceFacts): string[] {
  const money = (p: string) => formatInr(BigInt(p));
  const lines = [
    "TAX INVOICE",
    "Skiller",
    f.platformGstin ? `GSTIN: ${f.platformGstin}` : "GSTIN: applied for",
    `Invoice number: ${f.number}`,
    `Invoice date: ${istDate(f.issuedAt)}`,
    "",
    "Billed to",
    f.buyer.name,
    f.buyer.email,
    "",
    `Sold by: ${f.sellerName}`,
    "",
    `Item: ${f.itemTitle}`,
    `List price: ${money(f.listPaise)}`,
    `Discount: ${money(f.discountPaise)}`,
    `Total paid: ${money(f.totalPaise)}`,
    "",
    `${f.gst.baseLabel}: ${money(f.gst.basePaise)}`,
    `GST (${formatBps(f.gst.bps)}) on platform fee: ${money(f.gst.taxPaise)}`,
    `Platform fee including GST: ${money(f.gst.feeTotalPaise)}`,
    "",
    "Prices are inclusive of GST. This is a computer generated invoice.",
  ];
  return lines;
}

/** Renders the stored lines as a single-page PDF. */
export function renderInvoicePdf(details: InvoiceDetails): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: `Invoice ${details.number}`, Author: "Skiller" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    details.lines.forEach((line, i) => {
      if (i === 0) doc.font("Helvetica-Bold").fontSize(20);
      else if (i === 1) doc.font("Helvetica-Bold").fontSize(12);
      else if (line === "Billed to") doc.font("Helvetica-Bold").fontSize(10);
      else doc.font("Helvetica").fontSize(10);
      doc.text(line === "" ? " " : line);
    });
    doc.end();
  });
}
