# Re-review: fix round 1 (410a6a5..b84e441)

## Finding Verdicts
- Critical 1 (code masking disagrees with CommonMark) - ADDRESSED. markdown.ts:57-67 uses the real markdown-it block/inline tokens, no regex masking. Probed with real backslashes: escaped-backtick script and link (rejected), span across blank line, fence with backtick info string, list-dedent fence: all rejected. Real code (inline, fence, indented) containing HTML is accepted unchanged.
- Critical 2 (link scrub misses syntax) - ADDRESSED. newline-before-destination, nested brackets, image-in-link, definition on next line, definitions in blockquote/list: all rejected (via link_open href plus env.references).
- Important 3 (quadratic DoS) - ADDRESSED. 50k "[" = 124 ms; "![" x25k = 214 ms; nested lists 5000 deep = 258 ms; ~40 other 50k adversarial inputs all < 120 ms. Linear.
- Important 4 (moderator manage_any) - ADDRESSED. default-roles.ts moderator = user.view, media.manage_any, course.review. CoursePolicy.canReview/loadForRead read-only (writes still go through loadForAuthor, reviewer gets 403 / draft 404). REVOKED_DEFAULT_GRANTS deleteMany + holder cache invalidation in permission-sync.ts, tested in int-spec.

## New breakage in the fix diff
Important (1):
- markdown.ts:59 (validator maxNesting default 100): content nested deeper than 100 block levels is silently dropped from the token stream, so it is never inspected. Probe: ">".repeat(100) + " <script>x</script>", ">".repeat(101) + " [x](javascript:1)", "<script>x" after 100 ">", and a 60-deep nested "- " list + "<script>" all return ZERO issues and are stored verbatim (99 levels are caught, 100+ are not). Harmless to a markdown-it client with the same default (it drops the content too, rendered output empty), but any other CommonMark renderer (marked, commonmark.js, micromark, server-side email/preview renderers) renders live HTML / javascript: links. Violates "reject any html token / unsafe href". Fix: detect truncation and reject (e.g. a cheap pre-pass bounding container-marker depth, or run the validator with a high maxNesting inside try/catch RangeError and reject on overflow, or reject when total parsed line coverage < source), and add a spec case.

Minor (5):
1. course.policy.ts canReview: `|| flaggedAt !== null` lets reviewers read flagged DRAFT courses; report says drafts stay 404.
2. permission-sync.ts: REVOKED_DEFAULT_GRANTS is applied on every seed/release, not one-off; an operator can never deliberately re-grant manage_any to moderator (comment says "one-off").
3. `[x](//evil.com)` protocol-relative is classed relative and accepted (equivalent to an allowed http link; acceptable, document it).
4. `a<b`, `x <div\nfoo`, `<a href="x"`, `<img src=x onerror=alert(1)//` (unterminated, mid-paragraph) are plain text in CommonMark so are accepted and stored; safe with html:false clients, but a lenient non-CommonMark HTML pass could treat them as tags. `<div` / `<script` alone at line start is an html_block and rejected.
5. False positives outside code: "List<String>", "if a<b and c>d" (`<b and c>` is a valid tag) are rejected as HTML; users must wrap in backticks.

## Required-design checks (all pass)
- html:true validator, html_block/html_inline rejected (also comments, PI, CDATA, declarations, tables/footnote/strike content, HTML inside link text).
- Autolinks `<javascript:..>`, `<JaVaScRiPt:..>`: rejected. `<https://a.com>`, `<a@b.com>`: accepted.
- `[x](  javascript:..  )`, `<javascript:..>` dest, `&#106;avascript:`, `&#x6A;`, `javascript&colon;`, `JAVASCRIPT&#58;`, leading NBSP / U+2028: rejected. Percent-encoded `javascript%3A`, `%6Aavascript:`, `java&#10;script:`, tab/NUL/control/ZWSP-prefixed: href stays percent-encoded by normalizeLink (no scheme match, browsers do not decode), safe. `\evil.com`, `/\evil.com` become `%5C...`, safe.
- data:/file:/vbscript: for links and images rejected (data:image too, intended). Linkify off, typographer off, no footnote plugin.
- NUL / control chars: no crash, no bypass. Perf: see Finding 3.
- Exported createMarkdownRenderer(): html:false, linkify:false, typographer:false, validateLink = isSafeLinkDestination (same function as validator). Rendered output of script/link/autolink/data probes is escaped text.
- Old markdown-sanitizer(.spec).ts deleted, no remaining references; htmlparser2/entities removed from package.json; markdown-it ^14.3.3 + @types added.

## Out-of-Scope Observations
None.

## Verdict
Findings 1-4 addressed; one new Important (nesting-limit blind spot, markdown.ts:59) open.
