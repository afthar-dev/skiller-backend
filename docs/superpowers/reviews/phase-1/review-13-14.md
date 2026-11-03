# Review: Tasks 13 + 14 (420986a..99af4d3)

## Spec Compliance
Spec compliant (with accepted deviations). Every file and interface in both briefs has its hunk. Deviations the report lists are reasonable: extra `filename` column, node:24 image, TS fixture script, avatar never upscales, `transcodeToHls` returns renditions.
Two spec-adjacent gaps are covered under Important findings 5 and 6 (90 s cap enforced only to container metadata + 0.5 s tolerance; no content verification).
Cannot verify from diff: global rate limiter / `@RequirePermission` coverage for the 3 routes (all three carry `@RequirePermission("media.upload")`; ok). `media.upload` seeded for the intended roles (Task 5/seed).

## Strengths
- `complete` is genuinely idempotent: conditional PENDING->UPLOADED claim, `jobId = assetId`, guarded UPLOADED->PROCESSING (media.service.ts:93-120). 3x parallel complete is tested.
- `MediaLifecycle` (media-lifecycle.ts) is the single READY/FAILED mover; conditional updates, outbox event in the same tx, so handlers are idempotent. Mail handler adds a Redis NX marker for at-least-once delivery.
- ffmpeg is invoked via `execFile` with an args array and a `cwd` (ffmpeg.ts:69-75, 133): no shell, no user-controlled strings in argv (input path is `<mkdtemp>/source`; output names are fixed). Shell injection: not possible.
- Temp dir always removed in `finally` (transcode.processor.ts:74); partial `hls/` objects are deleted on retry/final failure; source is streamed to disk.
- Cleanup row-delete-first under row lock vs concurrent `attach` is a careful race design; profile/org attach in the same tx as the write; MEDIA_NOT_USABLE leaves the profile untouched (tested).
- Private bucket assets never get URLs (media.service.ts:174+).

## Named risks

(a) Upload-session abuse: CONFIRMED. `POST /media/uploads` (media.controller.ts:37) has no rate limit and no cap on PENDING sessions per user; each call writes a row, opens an R2 multipart upload and signs up to 512 part URLs (5 GB lesson). The repo already has `consumeRateLimit` (used for org invites), so the pattern exists. Cleanup only runs after 24 h.

(b) Replace leaves old asset attached: CONFIRMED (profiles.service.ts update, me.controller.ts PATCH profile; organizations.service.ts update). Old asset keeps `attachedAt`, so neither cleanup nor anything else ever reclaims it; setting the field to `null` also leaks. No detach path exists; also an asset can be attached to several targets, so a future release needs ref-counting.

(c) Content-type spoofing: PARTIAL.
- Video: ffprobe decides (no video stream -> FAILED), declared mime is never compared with the real container; any ffmpeg-demuxable input (HLS/concat playlists, etc.) is accepted. No `-protocol_whitelist` / forced `-f` / `format_name` allowlist, so a text file declared `video/mp4` goes through ffmpeg's playlist demuxers on a worker host.
- Image: sharp `metadata()` is used only as a validity check; `meta.format` is not restricted to jpeg/png/webp, so SVG/GIF/TIFF/HEIF declared as jpeg is accepted and decoded (image.processor.ts:51).
- `course_resource`: no verification at all; goes READY on size match only (media.service.ts:109). Magic bytes (`%PDF-`, `PK\x03\x04`) are not checked.
- Source object stays in the public bucket forever (`{purpose}/{owner}/{id}/source`) with its original EXIF/GPS, and for single-PUT images with a client-chosen Content-Type (presignPut signs no ContentType, r2.client.ts:69), so a `text/html` object can be served from the public origin.

(d) Presigned scope: key/uploadId/partNumber are signed, so another key or part is not reachable. But Content-Length is not signed (r2.client.ts:61, 69), so any part or single PUT may carry up to 5 GB regardless of declared size; the mismatch is detected only at `complete` (then deleted), and never if the client does not call complete (lives until the 24 h cleanup). Worse, the image presigned PUT stays valid for 1 h after `complete`, so the client can overwrite `source` after the size check; the worker then loads it with `toBuffer` into memory (image.processor.ts:48) with no size guard (worker OOM). Multipart kinds are safe post-complete (uploadId consumed).

(e) Temp-file cleanup / injection: cleanup good (finally rm; only a hard worker crash leaves `skiller-media-*` in tmpdir, Minor). Injection safe (execFile args array). Missing: no `timeout` on any `execFile` call (ffmpeg.ts:133, probe, poster), so a crafted input can hang a concurrency-1 worker indefinitely.

(f) 0.5 s tolerance: deviates from the "<= 90 s" constraint (transcode.processor.ts:18, 91); a 90.5 s reel passes. Larger problem: the duration is the container-header `format.duration`, which a crafted MP4 can understate while the streams are longer; the check is never repeated on the rendition output (the post-transcode probe at ffmpeg.ts:137 reads only dimensions). 200 MB cap bounds the abuse but the 90 s rule is bypassable.

## Issues

### Critical (Must Fix)
None.

### Important (Should Fix)
1. media.controller.ts:37 / media.service.ts:59 - no per-user PENDING-session cap and no rate limit on creating upload sessions (named risk a). Add `consumeRateLimit` (e.g. 30/h) plus max N concurrent PENDING (and a bytes-pending budget).
2. r2.client.ts:61,69 - presigned PUT/UploadPart do not sign `Content-Length`/`Content-Type`; clients can upload more than declared, set arbitrary Content-Type on public objects (named risk d). Sign `ContentLength` (PART_SIZE per part, remainder for the last, declared size for images) and `ContentType`.
3. media.service.ts:93 + image.processor.ts:48 - single-PUT image URL remains valid after `complete`; source can be swapped after the size check, and worker buffers the whole object in memory. Re-`head` in the worker and reject `size != declaredSize` (and cap `toBuffer`), or shorten TTL / copy source to an immutable key at complete.
4. ffmpeg.ts:111,133 + transcode.processor.ts:84 - untrusted input handed to ffmpeg with no `-protocol_whitelist file`, no forced demuxer, no `format_name` allowlist (mov/mp4/matroska/webm), and no `execFile` timeout (named risk c/e). Add all three plus a pixel/dimension sanity cap.
5. transcode.processor.ts:18,91 - 90 s limit trusts container metadata and adds a 0.5 s tolerance not in the spec (named risk f). Re-check duration of the produced HLS (sum of segment durations) and drop or tighten the tolerance (e.g. +0.1 s) and document it.
6. image.processor.ts:51 / media.service.ts:109 - declared MIME never verified against content: restrict `meta.format` to jpeg/png/webp (set `failOn: "error"`, limitInputPixels), magic-byte check for `course_resource` pdf/zip (named risk c).
7. me.controller.ts PATCH profile + profiles.service.ts update + organizations.service.ts update - replaced/cleared avatar, banner, logo stay attached forever (named risk b). Detach old asset (clear `attachedAt` or delete after grace) in the same tx.
8. media.service.ts:59-90 / image + transcode - original `source` is left in the PUBLIC bucket (EXIF GPS, arbitrary content-type) after processing. Delete the source for PUBLIC image assets once renditions exist (reels: keep only if a private copy is needed), or store sources in the private bucket.

### Minor (Nice to Have)
1. media.service.ts:74-78 - on `createMultipart` success then failure, the row is deleted but the multipart upload is not aborted; crash between create and uploadId update loses the uploadId. Add an R2 bucket lifecycle rule to abort incomplete multipart uploads after 1 day.
2. media.service.ts:~160 - `finalizeStorage` maps every `completeMultipart` error (network, auth) to `UPLOAD_INCOMPLETE` 409; only InvalidPart/EntityTooSmall should.
3. media.controller.ts:57 - `GET /v1/media/:id` requires `media.upload`, so a `media.manage_any` user without upload permission cannot read (brief: owner or manage_any).
4. media-cleanup.processor.ts:80 - R2 deletes executed inside an open DB transaction (60 s timeout); acceptable at hourly cadence but will hold locks for large HLS prefixes.
5. transcode.processor.ts uploadAll - reads each segment fully into memory x6 concurrency; fine for 6 s segments, note for 1080p high bitrates.
6. Dockerfile.worker copies full node_modules including dev deps (ffmpeg-static etc.); prune with `pnpm prune --prod`.
7. A crashed worker leaves `skiller-media-*` temp dirs; add a startup sweep.
8. media-failed-mail.handler: mail on `UPLOAD_SIZE_MISMATCH` is redundant with the immediate 422 (already noted by implementer).

## Assessment
**Task quality:** Needs fixes

**Reasoning:** The lifecycle, idempotency, and cleanup design are solid and well tested, and ffmpeg invocation is injection-safe. However, upload scope is unbounded (unsigned length/type, no session caps), content is not verified against the declared type, untrusted media reaches ffmpeg without timeout/format/protocol restrictions, and the 90 s rule is bypassable; these should be fixed before relying on this pipeline with untrusted users.
