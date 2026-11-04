import { randomInt } from "node:crypto";
import PDFDocument from "pdfkit";
import { registerNotoFonts, writeRuns } from "../../common/pdf/pdf-text";

/** No 0, 1, I, L or O: a code read aloud or typed from paper cannot be confused. */
export const CERTIFICATE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CERTIFICATE_CODE_LENGTH = 10;

/** 10 characters from the alphabet, drawn with the platform CSPRNG (randomInt is unbiased). */
export function generateCertificateCode(): string {
  let code = "";
  for (let i = 0; i < CERTIFICATE_CODE_LENGTH; i++) code += CERTIFICATE_CODE_ALPHABET[randomInt(CERTIFICATE_CODE_ALPHABET.length)];
  return code;
}

/** Caps for the text frozen on a certificate (in characters). */
export const CERTIFICATE_NAME_MAX = 80;
export const CERTIFICATE_TITLE_MAX = 120;

const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/gu;

/**
 * Text that is frozen on a certificate and printed on a public page and a PDF: NFC, every run of whitespace (newlines included) one
 * space, no control, format, zero-width or bidi-override characters, trimmed and cut to `max` characters. One visual line, always.
 */
export function sanitizeSnapshotText(input: string, max: number): string {
  const text = input.normalize("NFC").replace(/\s+/gu, " ").replace(BIDI_CONTROLS, "").replace(/\p{C}/gu, "").replace(/\s+/gu, " ").trim();
  return Array.from(text).slice(0, max).join("").trim();
}

/** Everything a certificate prints; frozen on the certificate row at issue time. */
export interface CertificateFacts {
  code: string;
  learnerName: string;
  courseTitle: string;
  issuerName: string;
  issuedAt: string;
  verifyUrl: string;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Dates on documents are Indian dates, like invoices: "5 November 2026". */
export const istLongDate = (iso: string): string => {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** The printed lines in order: heading, "certifies that", name, "has completed", course, issuer, date, code, verify URL. */
export function certificateLines(f: CertificateFacts): string[] {
  return [
    "Certificate of Completion",
    "This certifies that",
    f.learnerName,
    "has successfully completed the course",
    f.courseTitle,
    `Issued by ${f.issuerName}`,
    `Date of issue: ${istLongDate(f.issuedAt)}`,
    `Certificate code: ${f.code}`,
    `Verify this certificate at ${f.verifyUrl}`,
  ];
}

/** A4 landscape certificate. Latin text in Noto Sans, Devanagari runs (names, titles) in Noto Sans Devanagari; both embedded. */
export function renderCertificatePdf(f: CertificateFacts): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 56, info: { Title: `Certificate ${f.code}`, Author: f.issuerName } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      registerNotoFonts(doc);
      const lines = certificateLines(f);
      const width = doc.page.width - 112;
      doc.rect(28, 28, doc.page.width - 56, doc.page.height - 56).lineWidth(1.5).stroke("#444444");
      const sizes = [30, 12, 26, 12, 20, 12, 11, 11, 10];
      const gaps = [18, 10, 10, 10, 26, 6, 4, 4, 0];
      doc.y = 96;
      lines.forEach((line, i) => {
        writeRuns(doc, line, { size: sizes[i], bold: i === 0 || i === 2 || i === 4, options: { align: "center", width, lineBreak: true } });
        doc.moveDown(gaps[i] / sizes[i]);
      });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
