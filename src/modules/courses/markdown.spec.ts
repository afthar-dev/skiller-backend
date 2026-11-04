import { AppError } from "../../common/errors/app-error";
import { assertSafeMarkdown, createMarkdownRenderer, isSafeLinkDestination } from "./markdown";

const issuesOf = (src: string) => {
  try {
    assertSafeMarkdown(src);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    expect(e.code).toBe("MARKDOWN_UNSAFE");
    expect(e.status).toBe(422);
    return (e.details as { issues: Array<{ line: number; kind: string; value: string }> }).issues;
  }
  return null;
};

describe("assertSafeMarkdown rejects", () => {
  it.each([
    ["script element", "Hi <script>alert(1)</script> there"],
    ["img onerror", "x <img src=x onerror=alert(1)> y"],
    ["html block", "<div>\nhello\n</div>"],
    ["comment", "a<!-- c -->b"],
    ["svg", "<svg onload=alert(1)>"],
    ["escaped backtick makes the span literal", "\\`<script>alert(1)</script>\\`"],
    ["inline span cannot cross a blank line", "`<script>alert(1)</script>\n\n`"],
    ["fence with a backtick in the info string is no fence", "``` x`\n<script>alert(1)</script>"],
    ["list item fence ended by dedent", "- a\n  ```\nx\n<script>alert(1)</script>"],
    ["escaped backtick around a link", "\\`[x](javascript:alert(1))\\`"],
    ["newline before the destination", "[x](\njavascript:alert(1))"],
    ["nested brackets in link text", "[a [b] c](javascript:alert(1))"],
    ["image inside a link", "[![a](b.png)](javascript:alert(1))"],
    ["multi-line reference definition", "[x][1]\n\n[1]:\njavascript:alert(1)"],
    ["reference definition in a blockquote", "[x][1]\n\n> [1]: javascript:alert(1)"],
    ["reference definition in a list", "[x][1]\n\n- [1]: javascript:alert(1)"],
    ["unused reference definition", "[1]: javascript:alert(1)"],
    ["plain javascript", "[x](javascript:alert(1))"],
    ["mixed case", "[x](JaVaScRiPt:alert(1))"],
    ["numeric entity", "[x](&#106;avascript:alert(1))"],
    ["data html", "[x](data:text/html,hi)"],
    ["data image", "![x](data:image/svg+xml;base64,AAAA)"],
    ["vbscript", "[x](vbscript:msgbox(1))"],
    ["file", "[x](file:///etc/passwd)"],
    ["ftp", "[x](ftp://example.com)"],
    ["angle destination", "[x](<javascript:alert(1)>)"],
    ["autolink", "<javascript:alert(1)>"],
  ])("%s", (_n, src) => {
    expect(issuesOf(src)).not.toBeNull();
    expect(issuesOf(src)!.length).toBeGreaterThan(0);
  });

  it("reports the line and kind of each issue", () => {
    const issues = issuesOf("fine\n\n<b>x</b>\n\n[y](javascript:1)")!;
    expect(issues.map((i) => i.kind).sort()).toEqual(["html", "html", "link"].sort());
    expect(issues.find((i) => i.kind === "link")).toMatchObject({ line: 5, value: "javascript:1" });
    expect(issues.find((i) => i.kind === "html")!.line).toBe(3);
  });
});

describe("assertSafeMarkdown accepts and returns the text unchanged", () => {
  const md = [
    "# Title",
    "",
    "> a quote & more",
    "",
    "- a < b and c > d, 5 > 3",
    "- [site](https://example.com/a?b=1&c=2 'title') [mail](mailto:a@example.com) [tel](tel:+911234567890) [rel](/courses/x) [anchor](#top) [r2](a/b.md)",
    "![diagram](https://cdn.example.com/a.png)",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "Use `List<String>` and `<script>alert(1)</script>` here.",
    "",
    "```java",
    "List<String> xs = new ArrayList<>();",
    "<script>alert(1)</script>",
    "[x](javascript:alert(1))",
    "```",
    "",
    "~~~html",
    "<img src=x onerror=alert(1)>",
    "~~~",
    "",
    "    <div>indented code</div>",
    "",
    "[ref]: https://example.com",
    "Entities: &amp; &lt;b&gt; stay as written. Escaped \\<b> too.",
    "",
    "Mixed line endings\r\nare kept.",
  ].join("\n");

  it("a rich document", () => {
    expect(assertSafeMarkdown(md)).toBe(md);
  });

  it("empty and plain text", () => {
    expect(assertSafeMarkdown("")).toBe("");
    expect(assertSafeMarkdown("just words")).toBe("just words");
  });
});

describe("performance", () => {
  const timed = (src: string) => {
    const start = performance.now();
    try {
      assertSafeMarkdown(src);
    } catch {
      /* rejection is fine, only the time matters */
    }
    return performance.now() - start;
  };

  it("50,000 opening brackets validate in under 300 ms", () => {
    expect(timed("[".repeat(50_000))).toBeLessThan(300);
  });

  it.each([
    ["nested link starts", "[a](".repeat(12_500)],
    ["backticks", "`a".repeat(25_000)],
    ["emphasis runs", "*a_".repeat(16_000)],
    ["mixed adversarial", "[![`<a ".repeat(7_000)],
    ["deep blockquotes", "> ".repeat(25_000) + "x"],
    ["unclosed angle brackets", "<a ".repeat(16_000)],
  ])("50k of %s stays under 300 ms", (_n, src) => {
    expect(timed(src.slice(0, 50_000))).toBeLessThan(300);
  });
});

describe("reference renderer config", () => {
  it("renders with raw HTML off and refuses unsafe links", () => {
    const md = createMarkdownRenderer();
    expect(md.render("<b>x</b>")).not.toContain("<b>");
    expect(md.render("[x](javascript:alert(1))")).not.toContain("href");
    expect(md.render("[x](https://example.com)")).toContain('href="https://example.com"');
  });
});

describe("isSafeLinkDestination", () => {
  it.each(["https://a.example", "http://a.example/x", "mailto:a@b.co", "tel:+911234567890", "/relative", "relative/path", "#anchor", "?q=1"])("allows %s", (d) => expect(isSafeLinkDestination(d)).toBe(true));
  it.each(["javascript:x", "data:text/plain,hi", "ftp://x", "JAVASCRIPT:x", "blob:x"])("rejects %s", (d) => expect(isSafeLinkDestination(d)).toBe(false));
});
