import { isSafeLinkDestination, sanitizeMarkdown } from "./markdown-sanitizer";

describe("sanitizeMarkdown", () => {
  it.each([
    ["script element", "Hi <script>alert(1)</script> there", "Hi  there"],
    ["unclosed script swallows the rest of the paragraph", "Hi <script>alert(1)", "Hi "],
    ["img onerror", "x <img src=x onerror=alert(1)> y", "x  y"],
    ["svg onload with content", "<svg onload=alert(1)><circle/></svg>after", "after"],
    ["anchor keeps its text", '<a href="javascript:alert(1)">click</a>', "click"],
    ["iframe", '<iframe src="https://evil.example"></iframe>ok', "ok"],
    ["style element", "<style>body{display:none}</style>ok", "ok"],
    ["comment", "a<!-- <script>alert(1)</script> -->b", "ab"],
    ["tag re-forming once its neighbours are removed", "<<b>script>alert(1)<</b>/script>", ""],
    ["tag name with an embedded angle bracket", "<scr<script>ipt>alert(1)</scr</script>ipt>", "ipt>alert(1)&lt;/scr&lt;/script>ipt>"],
    ["autolink to javascript", "<javascript:alert(1)>", ""],
    ["uppercase and attributes", '<IMG SRC="x" ONERROR="alert(1)">', ""],
  ])("strips HTML: %s", (_name, input, expected) => {
    const out = sanitizeMarkdown(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/<[A-Za-z/!?]/);
  });

  it.each([
    ["javascript", "[x](javascript:alert(1))"],
    ["mixed case", "[x](JaVaScRiPt:alert(1))"],
    ["leading space", "[x]( javascript:alert(1))"],
    ["numeric entity", "[x](&#106;avascript:alert(1))"],
    ["hex entity", "[x](&#x6a;avascript:alert(1))"],
    ["tab inside scheme", "[x](java&#9;script:alert(1))"],
    ["control character", "[x](\u0001javascript:alert(1))"],
    ["backslash escape", "[x](java\\script:alert(1))"],
    ["data html", "[x](data:text/html,<script>alert(1)</script>)"],
    ["data html base64", "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
    ["vbscript", "[x](vbscript:msgbox(1))"],
    ["file", "[x](file:///etc/passwd)"],
    ["image with javascript", "![x](javascript:alert(1))"],
    ["image with data", "![x](data:image/svg+xml;base64,AAAA)"],
    ["link text with a code span", "[a `x` b](javascript:alert(1))"],
    ["reference definition", "[x][1]\n\n[1]: javascript:alert(1)"],
    ["angle bracket destination", "[x](<javascript:alert(1)>)"],
    ["encoded colon", "[x](javascript%3Aalert(1))"],
  ])("neutralises dangerous destination: %s", (_name, input) => {
    const out = sanitizeMarkdown(input);
    expect(out.toLowerCase()).not.toContain("javascript");
    expect(out.toLowerCase()).not.toContain("data:text/html");
    expect(out.toLowerCase()).not.toContain("data:image");
    expect(out.toLowerCase()).not.toContain("vbscript");
    expect(out).not.toContain("file:");
    expect(out).not.toContain("<script");
  });

  it("never leaves a tag-like sequence behind, however the input is mangled", () => {
    const pieces = ["<", "script", ">", "</", "img ", "onerror=", "!--", "?", "x", "/", "svg", " "];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 300; i++) {
      const input = Array.from({ length: 12 }, () => pieces[next() % pieces.length]).join("");
      expect(sanitizeMarkdown(input)).not.toMatch(/<[A-Za-z/!?]/);
    }
  });

  it("replaces the destination with # so the link text survives", () => {
    expect(sanitizeMarkdown("[click me](javascript:alert(1))")).toBe("[click me](#)");
  });

  it("keeps safe Markdown byte for byte", () => {
    const md = [
      "# Title",
      "",
      "> a quote & more",
      "",
      "- a < b and c > d",
      "- [site](https://example.com/a?b=1&c=2 'title') and [mail](mailto:a@example.com) and [rel](/courses/x) and [anchor](#top)",
      "![diagram](https://cdn.example.com/a.png)",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "[ref]: https://example.com",
      "Entities: &amp; &lt;b&gt; stay as written.",
    ].join("\n");
    expect(sanitizeMarkdown(md)).toBe(md);
  });

  it("leaves fenced and inline code untouched, even when it looks like HTML or a dangerous link", () => {
    const md = ["Use `List<String>` and `<script>alert(1)</script>` here.", "", "```java", "List<String> xs = new ArrayList<>();", "<script>alert(1)</script>", "[x](javascript:alert(1))", "```", "", "~~~html", "<img src=x onerror=alert(1)>", "~~~", "done"].join("\n");
    expect(sanitizeMarkdown(md)).toBe(md);
  });

  it("an unclosed fence keeps the rest of the document as code", () => {
    const md = "text\n```\n<b>bold</b>\nmore";
    expect(sanitizeMarkdown(md)).toBe(md);
  });

  it("strips HTML outside code in a document that also has code", () => {
    const md = "<script>x</script>\n\n```\n<b>kept</b>\n```\n\n<b>gone</b>";
    expect(sanitizeMarkdown(md)).toBe("\n\n```\n<b>kept</b>\n```\n\ngone");
  });

  it("normalises line endings and drops NUL bytes", () => {
    expect(sanitizeMarkdown("a\r\nb\rc\u0000d")).toBe("a\nb\ncd");
  });

  it("a NUL placeholder written by the author cannot resurrect or reorder code", () => {
    expect(sanitizeMarkdown("\u00000\u0000 and `real`")).toBe("0 and `real`");
  });
});

describe("isSafeLinkDestination", () => {
  it.each(["https://a.example", "http://a.example/x", "mailto:a@b.co", "tel:+911234567890", "/relative", "relative/path", "#anchor", "?q=1", "./x:y"])("allows %s", (d) => expect(isSafeLinkDestination(d)).toBe(true));
  it.each(["javascript:x", "data:text/plain,hi", "ftp://x", "  JAVASCRIPT:x", "java\tscript:x"])("rejects %s", (d) => expect(isSafeLinkDestination(d)).toBe(false));
});
