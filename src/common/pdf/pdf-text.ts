import { join } from "node:path";

// assets/fonts is at the project root: three levels up from both src/common/pdf (tests) and dist/common/pdf (the images).
const FONT_DIR = join(__dirname, "..", "..", "..", "assets", "fonts");
export const PDF_FONTS = {
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

/** The slice of a pdfkit document the helpers use (kept structural so callers need no pdfkit import for types). */
export interface PdfDocLike {
  registerFont(name: string, src: string): unknown;
  font(name: string): PdfDocLike;
  fontSize(size: number): PdfDocLike;
  text(text: string, options?: object): PdfDocLike;
  text(text: string, x: number, y: number, options?: object): PdfDocLike;
}

/** Registers the four embedded Noto faces under the names `latin`, `latin-bold`, `dev` and `dev-bold`. */
export function registerNotoFonts(doc: PdfDocLike): void {
  doc.registerFont("latin", PDF_FONTS.latin.regular);
  doc.registerFont("latin-bold", PDF_FONTS.latin.bold);
  doc.registerFont("dev", PDF_FONTS.devanagari.regular);
  doc.registerFont("dev-bold", PDF_FONTS.devanagari.bold);
}

/**
 * Writes one line of text with each script run in its own font. `options` go to every run (alignment, width, ...); the cursor moves
 * to the next line afterwards. With `x`/`y` the line starts at that position.
 */
export function writeRuns(doc: PdfDocLike, line: string, o: { size: number; bold?: boolean; x?: number; y?: number; options?: object }): void {
  const runs = splitRuns(line);
  runs.forEach((run, j) => {
    doc.font(`${run.devanagari ? "dev" : "latin"}${o.bold ? "-bold" : ""}`).fontSize(o.size);
    const options = { ...(o.options ?? {}), continued: j < runs.length - 1 };
    if (j === 0 && o.x !== undefined && o.y !== undefined) doc.text(run.text, o.x, o.y, options);
    else doc.text(run.text, options);
  });
}
