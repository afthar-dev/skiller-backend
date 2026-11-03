# Re-review: Tasks 13 + 14, fix round 1 (99af4d3..614b544)

## Finding Verdicts
1. Upload abuse caps - ADDRESSED. media.service.ts enforceCaps: 10 PENDING/user count + consumeRateLimit 30/h, both 429 UPLOAD_LIMIT_REACHED (retryAfter preserved). Called before the row is created. (Count-then-insert is not atomic; see Minor 4.)
2. Presigned URLs - ADDRESSED. r2.client.ts presignPut signs content-length + content-type (signableHeaders), presignParts signs exact per-part length via media.rules.ts partSizes; TTL 15 min (media.rules.ts PRESIGN_TTL_SEC). Content-type omitted on parts is accepted per brief.
3. Source swap / OOM - ADDRESSED. media.service.ts finalizeStorage records sourceEtag; source-fetch.ts verifySource (ETag, size == declared, <= maxBytes) then downloadTo with IfMatch to a temp file; image processor no longer buffers the source; file processor reads 8 bytes with IfMatch. 412 -> SOURCE_CHANGED.
4. ffmpeg hardening - ADDRESSED. ffmpeg.ts INPUT_GUARD `-protocol_whitelist file` on probe/transcode/poster; only the local temp path is passed (transcode.processor.ts:~83); ALLOWED_VIDEO_FORMATS check (transcode.processor.ts, after probe) -> MEDIA_TYPE_MISMATCH; execFile timeout + killSignal SIGKILL -> MediaTimeoutError -> PROCESSING_TIMEOUT.
5. Duration - ADDRESSED. ffmpeg.ts probe takes max of format and all stream durations; tolerance removed; transcodeToHls adds `-t maxDurationSec` on output (reels pass 90). Threshold value not judged, per instruction.
6. Content verification - ADDRESSED. image.processor.ts: meta.format must equal IMAGE_FORMAT_FOR_MIME[mime] (jpeg/png/webp), failOn error, 100 MP limit. file.processor.ts: %PDF- / PK\x03\x04 vs declared mime before READY, else MEDIA_TYPE_MISMATCH. media.service.ts routes kind "file" through FILE_JOB; media-worker.module.ts and test/support/media-worker.ts register FileProcessor.
7. Replacement leak - ADDRESSED for the single-reference case. MediaService.detach (media.service.ts) called in the same tx from me.controller.ts swap (avatar/banner) and organizations.service.ts update (logo); attach clears detachedAt; cleanup selects `attachedAt null AND (detachedAt null & created<cutoff OR detachedAt<cutoff)` and still re-checks `attachedAt: null` under the row lock in deleteMany, so a re-attach race resolves to "attach wins" or MEDIA_NOT_USABLE. Shared-asset case is a new Important, below.
8. Sources never in PUBLIC bucket - ADDRESSED. All uploads at `incoming/{id}/source` in SOURCE_BUCKET (PRIVATE) for presign, multipart, head, complete, abort (cleanup). Image: deletePrefix(incoming) after READY; reel: deleted after READY unless COURSE_LESSON; resource: server-side copy to `{prefix}/source` in the (PRIVATE) bucket then incoming deleted. Public outputs (image webp, reel hls/poster) are written to asset.bucket (PUBLIC) under assetPrefix, which urls() in media.service.ts builds from, so they remain reachable by public URL. Cleanup deletes both `incoming/{id}/` and the asset prefix.

## New Breakage in the Fix Diff

### Important
1. Detach with a shared asset deletes an in-use asset. media.service.ts detach (`updateMany attachedAt -> null` unconditionally, no reference check), called from me.controller.ts swap and organizations.service.ts update. The same READY AVATAR-purpose asset can legitimately be attached to the user's profile avatar AND an org logo (org attach uses actorId + "AVATAR"; the review already noted multi-target attach) or to two orgs. Replacing/clearing it on one target clears attachedAt for all; after 24 h the cleanup job deletes the objects and row, breaking the other target (dangling logoAssetId/avatarAssetId, 404 images). Previously the asset simply stayed attached. Fix: before detach, check that no Profile.avatarAssetId/bannerAssetId or Organization.logoAssetId (excluding the row being changed) still references the asset (in the same tx), or reject re-using an already-attached asset on a second target.

### Minor
1. media-cleanup/image.processor.ts:~85, transcode.processor.ts:~123, file.processor.ts:~56: source deletion happens after markReady; if the delete throws, the retry returns early (status READY) and the `incoming/{id}/` source (original EXIF for images) is never removed, because attached assets are not cleaned. Make the delete best-effort with a sweep (or retry the delete on READY).
2. profiles.service.ts update: `current` is read without a row lock, so two concurrent PATCHes can both detach the same old asset and leave the loser's newly attached asset attached to nothing (never cleaned). Use `SELECT ... FOR UPDATE` or read-then-compare inside the update.
3. ffmpeg.ts transcodeToHls: TRANSCODE_TIMEOUT_MS is applied per rung (up to 4 x 30 min per job); also the BullMQ job lock is not extended in this diff. Consider a total budget.
4. media.service.ts enforceCaps: PENDING count then insert is not atomic, so a parallel burst can exceed 10 (still bounded by the 30/h limit).
5. profiles.service.ts update now always does an extra findUniqueOrThrow inside the tx even when no media field is patched.

## Out-of-Scope Observations
None new. Prior Minor items (multipart abort on failed create, completeMultipart error mapping, GET needing media.upload, R2 deletes inside DB tx, Dockerfile prune, temp-dir sweep) remain open as the report states.

## Verdict
**Fix round:** All 8 findings addressed; 1 new Important (detach of a multiply-referenced asset leads to deletion of an in-use asset), 5 Minor. Report lists covering tests and their output (28/28 media-upload e2e, 26 suites / 250 tests); I did not re-run them.
