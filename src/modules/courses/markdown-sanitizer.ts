import { decodeHTML } from "entities";
import { Parser } from "htmlparser2";

/**
 * Server-side cleaning of author Markdown (lesson articles, course descriptions). Nothing is rendered here: the stored value is still
 * Markdown, and clients must render it with raw HTML disabled. This is the second line of defence that guarantees the stored text
 * carries no HTML and no script-capable link destinations, whatever a client does:
 *
 *  1. Code (fenced blocks and inline spans) is left byte-for-byte: `List<String>` and `#include <stdio.h>` are legitimate in a course.
 *  2. In everything else every HTML tag, comment, declaration and processing instruction is removed, and the contents of
 *     script / style / iframe-like elements go with it. Markdown is left untouched (a character-level parse, not an entity re-encode).
 *  3. Link and image destinations (inline and reference style) must be http, https, mailto, tel or relative. Anything else
 *     (javascript:, data:, vbscript:, file:, entity- or control-character-obfuscated variants) is replaced with "#".
 */
export const MAX_MARKDOWN_CHARS = 50_000;

const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "title", "svg", "math", "xmp", "noembed", "noframes", "plaintext"]);

interface Segment {
  code: boolean;
  text: string;
}

/** Fenced blocks (``` or ~~~) are code; everything between is prose, split again on inline code spans. */
function segments(src: string): Segment[] {
  const out: Segment[] = [];
  const lines = src.split(/(?<=\n)/);
  let prose = "";
  let fence: { char: string; len: number } | null = null;
  let code = "";
  const flushProse = () => {
    if (prose) out.push(...splitInlineCode(prose));
    prose = "";
  };
  for (const line of lines) {
    if (!fence) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        flushProse();
        fence = { char: open[1][0], len: open[1].length };
        code = line;
      } else {
        prose += line;
      }
      continue;
    }
    code += line;
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
      out.push({ code: true, text: code });
      fence = null;
      code = "";
    }
  }
  if (fence) out.push({ code: true, text: code }); // an unclosed fence runs to the end of the document, as in CommonMark
  flushProse();
  return out;
}

function splitInlineCode(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

/** Character ranges [start, end) of every piece of HTML in `text`, including whole script / style style elements. */
function htmlRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let dropDepth = 0;
  let dropStart = 0;
  const parser: Parser = new Parser(
    {
      onopentag(name) {
        if (DROP_WITH_CONTENT.has(name)) {
          if (dropDepth === 0) dropStart = parser.startIndex;
          dropDepth++;
        }
        if (dropDepth === 0) ranges.push([parser.startIndex, parser.endIndex + 1]);
      },
      onclosetag(name, implied) {
        if (DROP_WITH_CONTENT.has(name) && dropDepth > 0) {
          dropDepth--;
          if (dropDepth === 0) ranges.push([dropStart, implied ? parser.endIndex + 1 : parser.endIndex + 1]);
          return;
        }
        if (!implied && dropDepth === 0) ranges.push([parser.startIndex, parser.endIndex + 1]);
      },
      oncomment() {
        if (dropDepth === 0) ranges.push([parser.startIndex, parser.endIndex + 1]);
      },
      onprocessinginstruction() {
        if (dropDepth === 0) ranges.push([parser.startIndex, parser.endIndex + 1]);
      },
      oncdatastart() {
        if (dropDepth === 0) ranges.push([parser.startIndex, parser.endIndex + 1]);
      },
    },
    { decodeEntities: false, recognizeSelfClosing: true, lowerCaseTags: true },
  );
  parser.write(text);
  parser.end();
  if (dropDepth > 0) ranges.push([dropStart, text.length]); // unclosed <script>: it swallows the rest of the segment
  return ranges;
}

function stripHtml(text: string): string {
  let current = text;
  // Removing a tag can splice its neighbours into a new one (`<scr<b>ipt>`), so repeat until stable.
  for (let pass = 0; pass < 10; pass++) {
    const ranges = htmlRanges(current).sort((a, b) => a[0] - b[0]);
    if (ranges.length === 0) return current;
    let out = "";
    let pos = 0;
    for (const [start, end] of ranges) {
      if (end <= pos) continue;
      out += current.slice(pos, Math.max(start, pos));
      pos = Math.max(pos, end);
    }
    out += current.slice(pos);
    if (out === current) return current;
    current = out;
  }
  return current; // pathological nesting: neutraliseMarkup (applied by the caller) escapes whatever is left
}

/** Whatever still looks like the start of a tag, end tag, comment or declaration is escaped, so no HTML parser can disagree with ours. */
const neutraliseMarkup = (text: string) => text.replace(/<(?=[A-Za-z/!?])/g, "&lt;");

/** C0/C1 controls, space, soft hyphen, zero-width and bidi marks, line/paragraph separators, BOM: all ignored by URL parsers inside a scheme. */
const INVISIBLE = new RegExp(`[\\x00-\\x20\\x7f-\\x9f\\xad\\u200b-\\u200f\\u2028\\u2029\\ufeff]`, "g");

/** True when the destination is relative or uses an allowed scheme, after undoing the tricks a renderer would undo. */
export function isSafeLinkDestination(raw: string): boolean {
  let dest = raw.trim();
  if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1);
  dest = decodeHTML(dest.replace(/\\(?=[!-/:-@[-`{-~])/g, ""));
  // Browsers ignore tabs / newlines / control characters inside a URL scheme.
  dest = dest.replace(INVISIBLE, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(dest);
  if (scheme) return SAFE_SCHEMES.has(scheme[1].toLowerCase());
  // "javascript&colon;" style leftovers or an encoded colon before the first slash still mean a scheme to some parsers.
  return !/^[^/?#]*(?:%3a|&#x?0*(?:58|3a);?|&colon;)/i.test(dest);
}

const INLINE_LINK = /(!?\[(?:[^\]\\]|\\[\s\S])*\]\()([ \t]*)(<[^>\n]*>|(?:[^\s()\\]|\\[\s\S]|\((?:[^\s()\\]|\\[\s\S])*\))*)/g;
const REFERENCE_DEFINITION = /^( {0,3}\[(?:[^\]\\\n]|\\.)+\]:[ \t]*)(<[^>\n]*>|\S+)/gm;

function scrubLinks(text: string): string {
  const safe = (dest: string) => (dest === "" || isSafeLinkDestination(dest) ? dest : "#");
  return text
    .replace(INLINE_LINK, (_m, head: string, space: string, dest: string) => `${head}${space}${safe(dest)}`)
    .replace(REFERENCE_DEFINITION, (_m, head: string, dest: string) => `${head}${safe(dest)}`);
}

// Private-use characters bracket a placeholder; they and NUL are removed from the input first, so an author cannot forge one.
const MARK = String.fromCharCode(0xe000);
const PLACEHOLDER = new RegExp(`${MARK}(\\d+)${MARK}`, "g");
const FORBIDDEN_INPUT = new RegExp(`[\\x00${MARK}]`, "g");

export function sanitizeMarkdown(src: string): string {
  const text = src.replace(/\r\n?/g, "\n").replace(FORBIDDEN_INPUT, "");
  // Code is swapped for opaque placeholders so tags and links are processed over the whole prose: a link whose text contains a code
  // span ([a `x` b](javascript:...)) must not be split in two and slip past the scrubber.
  const code: string[] = [];
  const masked = segments(text)
    .map((s) => {
      if (!s.code) return s.text;
      code.push(s.text);
      return `${MARK}${code.length - 1}${MARK}`;
    })
    .join("");
  return scrubLinks(neutraliseMarkup(stripHtml(masked))).replace(PLACEHOLDER, (_m, n: string) => code[Number(n)] ?? "");
}

