/** Bidi marks, embeddings, overrides and isolates (LRM, RLM, LRE..RLO, LRI..PDI). They are format characters too; named so callers can see why they go. */
export const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/gu;

/**
 * User text that other people read and that is plain text, not Markdown (reviews, questions, answers). NFC; line breaks kept (CRLF, CR,
 * NEL and the Unicode line / paragraph separators become LF, at most one blank line in a row); tabs and runs of spaces become one space;
 * every other control, format, zero-width and bidi character goes; trimmed and cut to `max` characters (never inside a character).
 * Rendering must escape it: it is never HTML.
 */
export function sanitizePlainText(input: string, max: number): string {
  const text = input
    .normalize("NFC")
    .replace(/\r\n?|\p{Zl}|\p{Zp}|\u0085/gu, "\n")
    .replace(BIDI_CONTROLS, "")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/(?!\n)\p{C}/gu, "")
    .replace(/ ?\n ?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return Array.from(text).slice(0, max).join("").trim();
}
