# Review: Task 15 (signed private playback + Cloudflare playback gate), 728f8e1..39630c1

Line refs are to the diff file `review-728f8e1..39630c1.diff` (D = diff line) plus the new-file path.

## Spec Compliance
Spec compliant. Brief, global constraints, and the Phase 3 policy hook are all satisfied.
- The manifest path deviates from the brief's `/{assetId}/hls/...` to `course_lesson/{owner}/{asset}/hls/...`. This is justified: Task 14's key layout makes the request path the R2 key, and the Worker has no DB. The `a` == path asset check is kept.
- Token TTL is 600s. Playlist cache is `private, max-age=60`; segment cache is `private, max-age=600`. Invalid token gives 403.
- Every API route has a decorator (`@AuthenticatedOnly` on `playbackGrant`).
- Phase 3 can register an enrolment policy through `PlaybackPolicies.register()` without editing media.
- Cannot verify from diff (⚠️): the playback `secret()` minimum length in config; the player must re-fetch a token for lessons longer than 10 minutes (see Concerns).

## Strengths
- Shared vectors drive both the Jest and vitest suites. I recomputed the HMACs with Node: every "invalid" vector that is meant to fail on a non-signature ground (expired, expires-exactly-now, not-json, missing-exp, wrong-types, oversized) really carries a valid signature under the vector secret. Those tests therefore exercise the intended check and do not pass vacuously.
- Edge token code is correct:
  - `importKey("raw", utf8(secret), HMAC/SHA-256, ["verify"])` matches Node's `createHmac(secret)`.
  - Verification uses `subtle.verify`, which is constant time.
  - The `B64URL` regex runs before `atob`, so `+`, `/` and `=` are rejected.
  - The re-padding arithmetic is correct. A length-mod-4 == 1 string throws in `atob` and is caught.
  - The 512-character cap is checked first.
- CORS is an exact allow-list match with `Vary: Origin`. Arbitrary origins are not reflected, and errors carry CORS headers.
- The strict path allow-list regex is real defense in depth. Only GET and HEAD are allowed.
- The API checks, in order: rate limit, 404, policy (403), then bucket/purpose (422), then READY (409).
- The e2e suite covers the policy hook and the rate limit.

## Mutation judgement (edge and API tests)
| # | Weakening | Caught? | By |
|---|---|---|---|
| 1 | Skip signature verification | YES | vectors "tampered payload/signature/other secret" (edge `index.test.ts` D~2640 and GET 403 "tampered token"), plus the Jest spec |
| 2 | Skip `exp` check | YES | "expired", "expires exactly now" (valid signature), GET 403 "expired token" |
| 3 | Skip `a` == path asset | YES | "403 when the token is for another asset" (valid token A on B path). The `.toLowerCase()` case-folding is untested but harmless |
| 4 | `===` instead of constant-time | NO (Node side) | Not behaviourally observable. The edge side uses `subtle.verify`, so there is no mutation point. Accepted, see Minor 1 |
| 5 | Allow `..` / `%2e%2e` traversal | PARTIAL | See Important 2 |
| 6 | Serve arbitrary extension | PARTIAL | See Important 3 |
| 7 | Rewrite missing `#EXT-X-MAP URI=` | YES | the unit test asserts `#EXT-X-MAP:URI="init.mp4?t=TOK"`, and the variant GET test asserts `URI="init.mp4?t=..."` |
| extra | Max token length removed | YES | the oversized vector is validly signed |
| extra | B64URL regex removed | YES | the "standard base64 padding chars" vector (not caught if `atob` alone were relied on, but the regex test covers it) |

## Issues

### Critical
None.

### Important
1. `src/modules/media/playback.service.ts:43` (D~3254): the `asset.bucket !== "PRIVATE"` half of the guard is untested. The e2e "not playable" test uses `REEL`/`PUBLIC` and `COURSE_RESOURCE`/`PRIVATE`, and the purpose check alone fails both. Deleting the bucket check would leave the suite green. This is exactly the "never issue tokens for PUBLIC-bucket assets" requirement. Fix: add a case with `purpose: "COURSE_LESSON", bucket: "PUBLIC"` (status READY) expecting 422 `MEDIA_NOT_PLAYABLE`.
2. `edge/playback-gate/test/index.test.ts` (D~2735-2750), traversal tests pass for the wrong reason. In workerd the URL parser resolves literal `..`, `%2e%2e` and `\` before the handler runs. The "encoded dot segments", "literal dot segments" and "backslash" cases are normalised to another asset's valid path and fail on token mismatch, not on the traversal guard. The `url.pathname.includes("..")` guard at `src/index.ts:76` and the `%` exclusion are never the deciding factor in any test. Removing the `..` check, or admitting `%` into `NAME`, leaves the tests green. No exploit exists because R2 keys are flat and the token binds the asset. Fix: add tests that hit the guard directly, such as `/${prefix}/hls/a..b.m3u8` (regex-valid, contains `..`) expecting 403, and a literal `%` inside a segment name.
3. `edge/playback-gate/src/index.ts:25` and the edge test, the extension and layout allow-list is under-tested. Only `.php`, `/incoming/`, a wrong prefix and a bare asset id are tested. Not caught: adding `json` or other extensions to the group; dropping the `hls/` requirement so that `/course_lesson/O/A/source.mp4` or `/course_lesson/O/A/anything.m3u8` is served; allowing `poster.png`. Fix: add valid-token 403 cases for `/${prefix}/source.mp4`, `/${prefix}/hls/360p/x.json`, `/${prefix}/foo.ts` and `/${prefix}/poster.png`.

### Minor (6)
1. `src/modules/media/playback-token.ts:32`: the `timingSafeEqual` versus `===` swap cannot be caught behaviourally. If wanted, add a spy-based test. Signature base64 decoding is lenient about non-canonical trailing bits on both sides (equivalent encodings of the same HMAC verify). This is harmless.
2. `edge/playback-gate/src/index.ts:58-66` and `:102-108`: range handling is only tested with `bytes=a-b`. Suffix (`bytes=-N`) and open-ended (`bytes=N-`) ranges are untested. `object.range` for a suffix request may be `{suffix}`, which would give an offset of 0 and a wrong `Content-Length`/`Content-Range`. An out-of-bounds offset may make R2 throw, which becomes an unhandled 500. Validate against `object.size`, or wrap the `get` in try/catch and return 416.
3. `edge/playback-gate/src/index.ts`: there is no OPTIONS handler, so a CORS preflight (for example a non-safelisted Range) returns 405 without CORS headers. Error bodies are `{error:{code}}` only. That is acceptable for the edge, since the API error-shape constraint applies to API routes.
4. HEAD test (`index.test.ts` D~2705) checks only status and an empty body. It does not check `Content-Length`, `Cache-Control` or `Content-Type` parity. Implementation is correct (it wraps the GET response).
5. `edge/playback-gate/wrangler.toml`: production `ALLOWED_ORIGINS` includes `http://localhost:5173`; split per environment before deploy. `@cloudflare/vitest-pool-workers` is deprecated (already noted by the implementer).
6. The edge `rewritePlaylist` is untested for `#EXT-X-MEDIA` and `#EXT-X-I-FRAME-STREAM-INF` `URI=`. The same regex path applies, so this is low risk.

## Other checks
- No bucket or status bypass exists in the API. The bucket and purpose check precedes the READY check. The edge only binds `PRIVATE_BUCKET`, so a PUBLIC key would 404 anyway.
- Concerns that are not defects:
  - The token is reused for every segment with a 10-minute lifetime, so VOD lessons longer than 10 minutes need the player to re-call `/playback` (120/hour limit). This is a design point for the frontend task.
  - Segments cached with `max-age=600` can outlive the token in a browser cache. They are private, so this is acceptable.
  - Existence oracle: 404 versus 403 (brief-mandated).

## Assessment
**Task quality:** Needs fixes (test gaps only; production code is sound).

**Reasoning:** The Worker and token code are correct and secure, and the core mutations (1, 2, 3, 7, token length) are caught by real, validly-signed vectors. The Important items are test-coverage holes: the untested PUBLIC-bucket guard, the traversal tests that pass by token mismatch, and the under-covered extension allow-list. Item 4 (the `===` swap) is not behaviourally testable.
