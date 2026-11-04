# Review: Phase 3 Tasks 1-2 (0538715..410a6a5)

## Spec compliance
Mostly compliant; the Task 2 sanitiser requirement ("no raw HTML, no javascript: links") is NOT met (see Critical 1-2). Moderator default grant exceeds the plan (Important 4).

Probed by running `sanitizeMarkdown` directly (ts-node, scratchpad probe, repo untouched).

## Strengths
- Every curriculum query is scoped by `courseId` (`findFirst({id, courseId})`); `createLesson` checks `sectionId` belongs to the course; reorder demands an exact permutation of the course's own ids, all under a `FOR UPDATE` course lock. No cross-course IDOR found (moving lesson X of course A into B via order, PATCH or POST is impossible).
- Policy: org authorship uses org-scoped rows only, expired roles excluded; unknown/unauthorised -> 404, org member without authoring role -> 403 (as planned). Media ownership check collapses nonexistent/foreign assets into one 422.
- Public curriculum exposes only free-preview VIDEO asset ids; no article bodies, no resource ids; draft/archived -> 404.
- Price: decimal string -> BigInt, range checked on create and update; slug create retries on P2002; media single-attachment enforced by MediaService.attach (attachedAt guard).
- Probe confirmed these are blocked: uppercase scheme, entity-obfuscated scheme, `<javascript:...>` autolink, `<scr<script>ipt>`, comments, `<svg>`, unterminated tag, `data:` image, inline `[x](javascript:..)`, same-line reference definitions.

## Critical

1. `src/modules/courses/markdown-sanitizer.ts:38,63` - code masking disagrees with CommonMark, so anything the sanitiser calls "code" is stored verbatim. Probed, all survive unchanged:
   - Escaped backtick: `\`<script>alert(1)</script>\`` and `\`[x](javascript:alert(1))\``. In CommonMark `\`` is a literal backtick, so the script/link is live. The inline-code regex (line 63) ignores backslash escapes.
   - Inline span crossing a blank line: `` `<script>alert(1)</script>\n\n` `` (line 63 uses `[\s\S]*?`; CommonMark spans cannot cross paragraphs).
   - Fence with backtick in info string: ``` ``` x` ``` + newline + `<script>` (line 38 treats it as a fence, never closed, so the rest is "code"; CommonMark does not open a fence).
   - Fence inside a list item ended by dedent: `- a\n  ```\nx\n<script>alert(1)</script>`.
   The `javascript:` variants are live even when the client renders with raw HTML disabled. Fix: do not skip code by regex heuristics. Safer options: (a) parse with a real CommonMark parser (markdown-it/micromark) and walk tokens, or (b) never exempt code from the link scrub and escape every `<` before a letter/`/`/`!`/`?` even inside code (code renders fine with `&lt;`... only if you accept stored text change) , or (c) honour backslash escapes, paragraph boundaries and the backtick-info-string rule in the masker. Add tests for each case above.

2. `src/modules/courses/markdown-sanitizer.ts:153-154` - link scrub regexes miss valid link syntax. Probed, unchanged output:
   - `[x](\njavascript:alert(1))` (newline between `(` and destination; `([ \t]*)` at line 153 excludes it).
   - `[a [b] c](javascript:alert(1))` (balanced nested brackets in link text; label class stops at first `]`).
   - `[![a](b.png)](javascript:alert(1))` (image-in-link, the most common real-world form; outer match is consumed as `[![a](b.png)`).
   - `[x][1]\n\n[1]:\njavascript:alert(1)` (definition destination on next line; `[ \t]*` then `\S+` at line 154).
   - `[x][1]\n\n> [1]: javascript:alert(1)` and `- [1]: javascript:alert(1)` (definitions inside blockquote/list; `^ {0,3}` anchor).
   Each yields a clickable `javascript:` link in renderers that do not strip it (marked, many others). Fix: scrub with a real tokenizer (see 1), or at minimum replace every occurrence of a dangerous scheme pattern in any `](` / `]:` context and handle newlines, nesting and container prefixes (`^[ >\-*+0-9.]*`).

## Important

3. `src/modules/courses/markdown-sanitizer.ts:153` (+ `segments`/`splitInlineCode`:63) - quadratic backtracking DoS on the event loop. `"[".repeat(50000)` (valid within the 50k article limit, any creator) takes 3.8 s in `sanitizeMarkdown`; 20k chars = 0.7 s; the 10k description limit costs ~170 ms. Synchronous, so it blocks all API requests on the instance. Fix: single-pass tokenizer / cap label length (e.g. `{0,1000}`), and add a perf test (`"["*50000 < 100 ms`).

4. `src/modules/rbac/default-roles.ts:24` - moderator is granted `course.manage_any` by default; Task 1 gives moderators only `course.review`. `manage_any` is author-level (`CoursePolicy.canAuthor`, `course.policy.ts:44`), so every moderator can read/edit/price-change/DELETE any creator's DRAFT course and curriculum and rewrite article text. Existing existence/ownership guarantees (Review: "non-author reads/modifies DRAFT") are void for that role. Fix: grant moderators `course.review` only; let `canModerate` read-only paths (Task 3 queue) not imply authoring, or limit manage_any to super_admin/dedicated role. Controller to confirm intent.

## Minor (7)
1. `courses.service.ts:172` and `categories.service.ts:61` - `slug startsWith base` loads every slug sharing the prefix (unbounded for e.g. "python"). Query `base` and `base-N` only, or use the retry loop alone.
2. `curriculum.service.ts:`public view (`publicView`) checks `status === PUBLISHED` only, not `flaggedAt`; a flagged course still serves free-preview video asset ids. Add `flaggedAt: null` when Task 3 lands (note for Task 3/5).
3. No e2e coverage of cross-course ids: lesson/section id of course A used in course B's PATCH/DELETE/order/`sectionId` on create (code is correct; add regression tests), nor an ex-org-member losing access.
4. `courses.service.ts` update/remove: `lockCourse` on a concurrently deleted course then `findUniqueOrThrow` -> 500 instead of 404.
5. Slugs are user-settable and unrestricted; reserve words that collide with future static routes under `/v1/courses/` (e.g. `search`, `categories`) before Task 5/9 add them.
6. `markdown-sanitizer.ts:~120` redundant ternary `implied ? x : x` in `onclosetag`.
7. `course-media.ts:23` `assetInfo` is read outside the tx and trusted for `info.ownerId`; harmless because `attach` re-verifies under lock, but attach errors then surface as 409/422 MEDIA_NOT_USABLE inconsistently.

## Assessment
**Spec:** NOT compliant on Task 2 sanitiser (Critical 1-2); moderator grant exceeds plan (4). Everything else matches.
**Quality:** Needs fixes. Authorization, ordering, price, slug and module boundaries are sound; the sanitiser needs a rewrite on a real Markdown tokenizer and a perf bound.
