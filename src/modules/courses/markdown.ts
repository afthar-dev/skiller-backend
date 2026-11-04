import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { AppError } from "../../common/errors/app-error";

/**
 * Author Markdown (lesson articles, course descriptions) is VALIDATED, never rewritten: it is parsed with a real CommonMark parser
 * (markdown-it) with raw HTML enabled, so every piece of HTML shows up as an `html_block` / `html_inline` token, and every link or
 * image destination is checked after the parser's own normalisation (entities decoded, escapes resolved). Any HTML or any destination
 * that is not http, https, mailto, tel or relative rejects the whole text with MARKDOWN_UNSAFE. Valid text is stored byte for byte.
 *
 * Clients render with `createMarkdownRenderer()` (html: false and the same link rule), so even text stored before a rule change cannot
 * produce markup or script-capable links.
 */
export const MAX_MARKDOWN_CHARS = 50_000;
const MAX_REPORTED_ISSUES = 20;
/** Deepest container nesting (blockquote / list levels) accepted. markdown-it silently drops anything beyond its maxNesting, so depth is capped far below the parser limit and nothing is ever left uninspected. */
export const MAX_MARKDOWN_DEPTH = 20;
const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);

/** `url` is what markdown-it passes to validateLink: already normalised, so it holds no raw whitespace or control characters. */
export function isSafeLinkDestination(url: string): boolean {
  // Protocol-relative: browsers read `//host`, `\\host`, `/\host` and `\/host` as another site, not a path on ours. A leading backslash is never a path.
  if (/^[/\\]{2}/.test(url) || url.startsWith("\\")) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  return scheme ? SAFE_SCHEMES.has(scheme[1].toLowerCase()) : true;
}

/** The renderer configuration clients must use: raw HTML off, no linkify, only safe link destinations. */
export function createMarkdownRenderer(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: false });
  md.validateLink = isSafeLinkDestination;
  return md;
}

// Validation parses with HTML on (to see it) and an accepting validateLink (so unsafe links still become tokens we can inspect).
const validator = new MarkdownIt({ html: true, linkify: false });
// maxNesting is a real markdown-it option that its typings omit.
(validator.options as { maxNesting?: number }).maxNesting = 10_000;
validator.validateLink = () => true;

export interface MarkdownIssue {
  line: number;
  kind: "html" | "link";
  value: string;
}

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}...` : s);

function maxLevel(tokens: Token[]): number {
  let max = 0;
  for (const t of tokens) {
    if (t.level > max) max = t.level;
    if (t.children) max = Math.max(max, maxLevel(t.children));
  }
  return max;
}

function walk(tokens: Token[], line: number, issues: MarkdownIssue[]): void {
  for (const token of tokens) {
    if (issues.length >= MAX_REPORTED_ISSUES) return;
    const here = token.map ? token.map[0] + 1 : line;
    if (token.type === "html_block" || token.type === "html_inline") {
      issues.push({ line: here, kind: "html", value: clip(token.content.trim()) });
    } else if (token.type === "link_open" || token.type === "image") {
      const dest = token.attrGet(token.type === "image" ? "src" : "href") ?? "";
      if (!isSafeLinkDestination(dest)) issues.push({ line: here, kind: "link", value: clip(dest) });
    }
    if (token.children) walk(token.children, here, issues);
  }
}

const tooDeep = () => new AppError("MARKDOWN_TOO_DEEP", 422, `Markdown may nest quotes and lists at most ${MAX_MARKDOWN_DEPTH} levels deep`, { maxDepth: MAX_MARKDOWN_DEPTH });
const CONTAINER_MARKER = /^ *(?:>|[-*+](?= )|[0-9]{1,9}[.)](?= ))/;

/** Cheap per-line count of leading quote / list markers, so absurd nesting is refused before the (recursive) parser sees it. */
function exceedsMarkerDepth(src: string): boolean {
  for (const line of src.split(String.fromCharCode(10))) {
    let rest = line;
    for (let depth = 0; ; depth++) {
      const m = CONTAINER_MARKER.exec(rest);
      if (!m) break;
      if (depth >= MAX_MARKDOWN_DEPTH) return true;
      rest = rest.slice(m[0].length);
    }
  }
  return false;
}

export function findMarkdownIssues(src: string): MarkdownIssue[] {
  if (exceedsMarkerDepth(src)) throw tooDeep();
  const env: { references?: Record<string, { href: string }> } = {};
  let tokens: Token[];
  try {
    tokens = validator.parse(src, env);
  } catch (err) {
    if (err instanceof RangeError) throw tooDeep(); // stack exhausted by nesting the marker scan did not foresee
    throw err;
  }
  if (maxLevel(tokens) > MAX_MARKDOWN_DEPTH) throw tooDeep();
  const issues: MarkdownIssue[] = [];
  walk(tokens, 1, issues);
  // Definitions nobody references yet are still stored, and a later edit could reference them.
  for (const [label, ref] of Object.entries(env.references ?? {})) {
    if (issues.length < MAX_REPORTED_ISSUES && !isSafeLinkDestination(ref.href)) issues.push({ line: 1, kind: "link", value: clip(`[${label}]: ${ref.href}`) });
  }
  return issues;
}

/** Returns `src` untouched, or throws MARKDOWN_UNSAFE listing what is wrong. */
export function assertSafeMarkdown(src: string): string {
  const issues = findMarkdownIssues(src);
  if (issues.length > 0) {
    throw new AppError("MARKDOWN_UNSAFE", 422, "Raw HTML and links other than http, https, mailto, tel or relative are not allowed in Markdown", { issues });
  }
  return src;
}
