# Final review: web Phase 3 (creator studio and money)

Scope: web `git diff main...phase-3-studio` (lockfile, `schema.gen.ts` and `contract/` skipped) and `backend-review.diff` (`openapi.json` skipped). Read-only review; everything below was checked in the code, not only in the diff.

Verdict: **merge with fixes** (0 Critical, 3 Important, 8 Minor).

---

## Focus 1: auth (refresh grace, mail job ids): no blocking findings

I checked `session.service.ts:83-154`.

- **Token leak:** none. Redis holds only `iv|tag|AES-256-GCM(newToken)` under `sessions:grace:sha256(old)`. The key is `sha256("refresh-grace:" + old)`, so someone who can read Redis and the DB (which has `previousHash = sha256(old)`) still cannot open it. The warning log on a failed store contains only the Redis error message.
- **Longer life for a stolen token:** none beyond one generation. Replay only happens when (a) the presented token is the row's `previousHash`, (b) `rotatedAt` is 10 s old or less by the DB clock (the 12 s Redis TTL is only cleanup), and (c) `sha256(opened) === stale.refreshHash`. Condition (c) means that once the session rotates again, the entry stops opening (it falls back to 409). After 10 s the old token still takes the `AUTH_TOKEN_REUSED` family-revocation path. The trade-off accepted in the ledger holds: a thief who presents `t0` within 10 s of the owner's rotation now gets `t1` instead of a 409. Whichever of them later presents a stale `t1` revokes the family.
- **Bypassing family revocation:** none. The replay path checks `stale.revokedAt` and `expiresAt` first. `revokeFamily` and `revoke` set `revokedAt` on the row the replay reads. The int-spec "never serves a revoked session" would fail if that check were removed (the grace entry still exists and the hash still matches), so the test is meaningful.
- **Mail:** `jobId: mail-${idempotencyKey ?? uuidv7()}` (`mail.service.ts:33`) is unique per mail. The processor turns it into the Resend `Idempotency-Key` (`mail.processor.ts:49`). The e2e test that deletes `bull:mail:id` reproduces the counter-reset collision and would fail on the old code.

---

## Important

### I1. A curriculum reorder from a second tab silently overwrites the first (Review Focus 4 not met)

- **Where:** `skiller-backend/src/modules/courses/curriculum.service.ts:234-257`, `skiller-web/src/features/studio-courses/curriculum-tab.tsx:77-91`, test `curriculum-tab.test.tsx:234`.
- **Failure:** tab A and tab B both load the same curriculum. A moves section 3 to the top and saves. B moves lesson 2 down and saves. B's body is still a full permutation of the same ids, so `assertPermutation` passes and B's arrangement replaces A's with no error. The same happens when B has a draft and A only reorders. `PUT /order` has no version, ETag or `updatedAt` precondition. The client's 409/ORDER_INVALID reload therefore only fires when sections or lessons were added or removed, never for the "two tabs reorder" case that the plan names.
- **Test that passes with the bug:** `curriculum-tab.test.tsx:234` mocks a 422 `ORDER_INVALID` for an ordinary reorder, which the API never returns in that situation.
- **Fix:** make the order save conditional.
  - Backend: return a curriculum `version` (or the max `updatedAt` of the sections and lessons) from `GET /curriculum`. Have `PUT /order` take `expectedVersion` (or `If-Match`) and answer `409 ORDER_STALE` under the existing `lockCourseForEdit` lock when it differs.
  - Web: send the version the draft was built from. The existing reload-and-notice branch then covers this case. Add a backend e2e test (two saves built from the same version, second gets 409) and a web test against that code.

### I2. A finished upload re-attaches itself whenever its field mounts again, which undoes "Remove"

- **Where:** `skiller-web/src/components/upload-field.tsx:21-28`, together with `src/lib/upload/engine.ts` (a slot stays `ready` with its `assetId` until `reset`). Callers: `src/features/profile/profile-images-form.tsx:45-58,66-81`, `src/features/studio-courses/details-tab.tsx:175-200`, `src/features/studio-courses/lesson-editor.tsx:85-113`.
- **Failure:** the "already reported" guard is a component `useRef`, but upload state lives in the engine for the provider's whole lifetime under a fixed slot name (`profile-avatar`, `lesson-<id>-video`).
  - Avatar example: the member uploads an avatar (attached), clicks "Remove avatar" (`avatarAssetId: null`), moves to another settings page, then comes back. `UploadField` mounts with `reported = null` and the slot still `ready` with the old asset, so `onReady` PATCHes the removed avatar back. Depending on what detach did to the asset, the member either sees it restored or gets an attach error.
  - The same happens for a course thumbnail or trailer after Remove, and for a lesson whose video was replaced through another route.
- **Fix:** record "handled" in the engine, not in the component. For example, `engine.store.reset(slot)` (or an `attachedAssetId` on the snapshot) once `onReady` has run successfully. Alternatively, have the Remove actions reset the matching slot. Add a test for upload, Remove, remount, with no second PATCH.

### I3. A lesson video is attached only if its editor happens to be open when processing finishes; leaving Studio aborts the upload

- **Where:** `skiller-web/src/features/studio-courses/lesson-editor.tsx:90` (hint "You can leave this page while it uploads"), `curriculum-tab.tsx:332` (each lesson editor starts closed), `upload-field.tsx:24-28` (attach happens in a component effect), `src/app/studio/layout.tsx` and `src/app/(member)/layout.tsx` (two separate `UploadProvider`s, and `dispose()` on unmount).
- **Failures:**
  - The creator starts a 3 GB video, collapses the lesson or opens another Studio tab, and the asset reaches READY. Nothing is mounted to call `fields.save("videoAssetId")`, and the lesson stays "No video yet." The attach happens only if they reopen that exact lesson before leaving Studio. After a reload the engine is empty and `follow()` has already cleared the sessionStorage entry at READY, so the READY asset is orphaned. It counts toward storage until it is cleaned up, and the creator uploads again.
  - Any move from `/studio/...` to a member page (avatar menu, settings) unmounts the Studio provider. That aborts every part in flight, despite the hint.
- **Fix:**
  - Run the attach from the engine: pass an `onReady` action into `start()` that the engine runs once at READY whether or not the field is mounted (this also fixes I2).
  - Mount one `UploadProvider` above both the Studio and member layouts.
  - Add a `beforeunload` prompt while a slot is `uploading`.
  - Reword the hint to what is actually true.

---

## Minor

### M1. The abort comment promises a retry that does not happen

- **Where:** `media.service.ts:217-223`.
- **Problem:** the comment says "the purger retries the abort", but `media-purger.ts:27` aborts only `PENDING` assets with an `uploadId`. An aborted asset is already `FAILED`, so when the R2 abort fails, its parts stay until an R2 lifecycle rule removes them (if there is one).
- **Fix:** have the purger also abort for `FAILED` with `failureReason = 'ABORTED_BY_OWNER'`, or confirm the bucket has an AbortIncompleteMultipartUpload rule and correct the comment.

### M2. Cancel racing complete can leave an orphan asset

- **Where:** `engine.ts:145-157`.
- **Problem:** cancel sends `DELETE` only when the slot is `uploading`, but the `complete` POST is not abortable. If cancel lands while complete is in flight and the server has already claimed `UPLOADED`, the DELETE gets 409 (ignored) and the asset goes on to process and become READY. The slot is reset and the sessionStorage entry is cleared, so nothing attaches it. The server side of the race is safe (conditional updates in both `complete` and `abort`).
- **Fix:** while a complete is in flight, either ignore Cancel or follow the asset and attach it.

### M3. Pending uploads leak toward the 10-upload cap

- **Where:** `engine.ts:253-256` and `engine.ts:251-295`.
- **Problem:** resuming a stored single-PUT image starts over without discarding the old `PENDING` asset. A cancel during `resume()` (before `assetId` is in the store) also discards nothing. Each case holds one of the 10 pending slots until expiry.
- **Fix:** call `discard(saved.assetId)` in both paths.

### M4. The cancel doc in useUpload contradicts the engine

- **Where:** `use-upload.ts:24-25`.
- **Problem:** the doc for `cancel` says "Choosing the same file again continues from the parts that arrived". The engine's cancel now clears the stored upload and DELETEs the asset.
- **Fix:** correct the doc.

### M5. One file in two slots of the same tab shares one asset

- **Where:** `store.ts:66-68`.
- **Problem:** the fingerprint (`purpose|org|name|size|mtime`) has no slot in it. Starting the same file for two lessons in one tab makes both slots resume the same asset, send the same parts and attach the same asset id to both lessons.
- **Fix:** include the slot in the fingerprint, or refuse a second slot while one is running.

### M6. The withdraw attempt key is lost on remount

- **Where:** `use-withdraw.ts:17`.
- **Problem:** the key lives in a ref. A dropped response (the payout was created), followed by leaving the Earnings page and coming back to retry, sends a new key, which makes a second payout if the balance allows. Double taps and retries within the page are covered correctly. The step-up 403 comes from a guard before the idempotency interceptor, so keeping the key across step-up is right.
- **Fix:** keep `{amount, key}` in sessionStorage for a few minutes, or after a network error show "check Payouts before retrying".

### M7. A grandparent token is not treated as reuse (existing behaviour, unchanged here)

- **Where:** `session.service.ts:123-134`.
- **Problem:** after `t0 -> t1 -> t2`, presenting `t0` matches neither `refreshHash` nor `previousHash` and returns `AUTH_SESSION_EXPIRED` without revoking the family. Theft detection therefore covers only the immediately previous token. This predates the change and the grace window does not make it worse.
- **Fix:** keep a short hash history per family, or a `refresh_token_hashes` table.

### M8. Web casts payloads to the new schemas instead of letting the types check them

- **Where:** `use-plan-change.ts:69-71`, `use-withdraw.ts:42`, `payout-account.tsx:66`.
- **Problem:** responses are cast with `as SubscriptionChange` / `as Payout` / `as PayoutAccount`. The ledger notes these schemas were not checked against live responses, and the casts mean a drift would not show up in typecheck either. The web e2e (108 x3 green) exercises these flows, so the risk is low.
- **Fix:** remove the casts where `unwrap` already gives the generated type.

---

## Checked and fine

- **Payout account form:** PAN and account number live only in component state. The call is not a react-query mutation, nothing is written to storage, logs or the URL, the form is cleared on success, and validation text never echoes the input. The API client's `pristine` WeakMap holds the request only in memory, for the step-up resend.
- **Withdraw:** one key per attempt (`createAttemptKeys` fingerprints the amount). A 4xx, except `IDEMPOTENCY_IN_PROGRESS`, renews the key. A network error or 5xx keeps it (the interceptor releases the key on 5xx and stores 4xx). The double-tap guard works. Under review is disabled up front from `underReview` and also from the error. The UPI maximum and the minimum come from `details.maxPaise` / `details.minPaise`, which match `payouts.service.ts:157,171`. `underReview` hides the flag's name (spec plus e2e).
- **Subscriptions:** checkout or change is chosen by the subscription row. `AT_PERIOD_END` sends no payment. A dismissed Razorpay window makes no claim. The page polls `/subscriptions/me` and never verifies in the browser.
- **Coupons:** percent goes to bps and rupees to paise by string arithmetic. The end date is the end of the day in IST, and the API decides what is allowed.
- **Upload engine:** sessionStorage holds only the asset id, part size, part count and ETags, never URLs. A 403 re-signs once per part through a shared re-sign. Retries are 3 with backoff. Polling stops at READY or FAILED, on a 4xx, or on dispose.
- **DELETE /v1/media/uploads/:id:** owner only (404 otherwise), and `PENDING -> FAILED` is conditional, so it cannot race `complete`'s `PENDING -> UPLOADED` claim. FAILED assets are off the cap and the quota. e2e covers 204, 404, 409 and the freed slot.
- **MediaUrlResolver:** depends only on Prisma and config. `ProfilesService` no longer injects `MediaService`; only the module-level forwardRef remains. Every module that builds `ProfilesService` provides the resolver: users, users-worker, billing-worker, courses-worker, plus both test harnesses. The worker boot int-spec asserts this. `publicUrlsOf` returns URLs only for `PUBLIC` + `READY`, and the e2e covers PROCESSING and PRIVATE returning null.
- **Locked in review:** `isLocked` is used by details, curriculum, lesson, quiz and pricing (fieldsets disabled, edit controls hidden). The publish tab offers Withdraw.
- **Markdown issues:** the web parser matches the backend `{line, kind, value}` shape and shows every issue.
