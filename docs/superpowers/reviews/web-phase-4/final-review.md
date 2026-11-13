# Final review: Web Phase 4 (Reels)

Scope: backend `web-phase-4` vs `main` (typed responses plus the new `GET /v1/studio/reels`), web `phase-4-reels` vs `main`. Read-only review. I checked every finding against the source on those branches.

Summary: the work is solid and carefully built. The engagement request loop (last tap wins, rollback to the confirmed state, counts clamped at zero) is correct. Feed lists wait for the session and are keyed member/public. Captions and comments render as React text nodes, so HTML cannot be injected. Hashtag links are encoded. Notification links are limited to internal paths. The single reel and hashtag pages give a real 404 and OG metadata. The new backend endpoint is scoped to the caller, its cursor is signed, and a forged cursor gets 400. I found 0 Critical, 4 Important and 7 Minor issues. The four Important ones are bugs that tests miss: one in playback, one in beacon timing, and two places where state is shown to the wrong viewer.

## Critical

None.

## Important

### I1. A rejected `play()` mutes the whole session, and never retries the play
`src/features/reels/use-reel-playback.ts:114-117`

```ts
void Promise.resolve(video.play()).catch(() => {
  setReelMuted(true);
});
```

- **Scenario A (fast swipe):** the member unmutes and then swipes quickly. Each reel that passes the 60% line gets `play()`. Before playback starts it gets `pause()` (line 111) or the stream is released (line 101). Chrome and Safari then reject the pending `play()` with `AbortError` ("interrupted by a call to pause()"). The catch treats that as an autoplay refusal and sets the session muted. The member's unmute choice is lost while swiping, which breaks "tap to unmute that sticks for the session" (Global Constraints). It is most likely exactly during Review Focus 1.
- **Scenario B (real refusal):** iOS Safari refuses unmuted `play()` without a user gesture with `NotAllowedError`, and a swipe is not a gesture. The code mutes, but the play effect depends only on `[intended, ready]`, which have not changed. So `play()` is never called again and the reel sits paused on its poster. The comment says "fall back to muted rather than not playing", but the code does not play.
- No test covers a rejected `play()`: `player.test.tsx` always resolves.
- **Fix:** look at the error. Ignore `AbortError`. On `NotAllowedError`, set `video.muted = true`, call `setReelMuted(true)`, then retry `video.play()` once. Add tests for both rejection types.

### I2. The watch clock runs while the video is buffering, so a view can be counted with less than 3 s actually watched
`src/features/reels/player.tsx:62-63`, `src/features/reels/use-view-beacon.ts:68-74`

The clock starts on React `onPlay`, the `play` event. That event fires when `play()` is called, before any frame is decoded. `attachHls` reports ready on `MANIFEST_PARSED`, before any segment has arrived.

- **Scenario:** on a slow connection the first segment takes 3 s or more. The viewer sees the poster and a spinner, then swipes away. The first-beacon timer still fires at 3 s with `watchedSec: 3`. The API counts a view, which inflates views and watch time in creator analytics.
- Mid-play rebuffering is also counted as watching.
- This breaks "after 3 s of watching" (Global Constraints, Task 2).
- **Fix:** start the clock on `playing`. Stop it on `waiting`, `pause` and `stalled`. Expose an `onWaiting` alongside `onPlay`/`onPause` and wire it in `Player`. Add a test in which `play` fires but `playing` comes late.

### I3. Per-viewer reel state survives sign-out and switching accounts in the same tab
`src/features/reels/engagement.ts:41`, `src/features/reels/availability.ts:14`; `resetEngagement` (`engagement.ts:136`) and `resetAvailability` (`availability.ts:44`) are only called in tests. `endSession` (`src/features/auth/auth-provider.tsx:83-89`) clears the query cache, but not these module stores, and sign-out is a client navigation (`router.replace("/")`).

- **Scenario (like state):** member A taps Like on reel X. `e.liked` becomes true, while `seeded.liked` stays false from A's earlier copy. A signs out, and a visitor or member B opens the feed in the same tab. The fresh copy says `likedByMe: false`. `seedEngagement` (line 114) ignores it, because the copy equals the last seeded value. So the next person sees reel X as liked by them, with A's count.
- **Scenario (blocks):** A's blocks and mutes in `availability` keep hiding those creators from the next person until a reload.
- On a shared computer this leaks A's activity. The project already treats that case seriously (see the sign-out comment in `auth-provider.tsx`).
- **Fix:** call `resetEngagement()` and `resetAvailability()` from `endSession`, or reset both whenever `me?.profile.userId` changes (one small effect in the reels feature).
- Add a test: like as A, sign out, check that the heart is not pressed.

### I4. On a hashtag page, a signed-in member sees the public copy, with blocked creators, until the session is restored
`src/features/reels/queries.ts:73-80` (`member ? undefined : initial`), rendered by `src/features/reels/grid.tsx:55-57`

While `status === "loading"`, `member` is false, so the server-rendered public page is used as `initialData` under the `public` key. `isPending` is false, so the grid shows those tiles, including reels by creators this member blocked. The first paint is the server HTML. The tiles stay until `/v1/me` resolves and the member key refetches. Task 7 lists this as a known concern, but it breaks Review Focus 4 ("never shown after block").

- **Scenario:** a member who blocked creator C reloads `/hashtags/react`. C's posters and captions (in the tiles' `aria-label`) appear for the length of the refresh plus the `/v1/me` call, which is seconds on a slow network.
- **Fix:** give `initial` only when `status === "signedOut"`. While `loading`, keep the server HTML for crawlers but render the grid as a placeholder (for example `aria-busy` with `invisible` tiles, or the Loading state) so nothing shows until the session is known.
- Add a unit test: status `loading` with an initial page must not show any tiles.

## Minor

### M1. The 5 s beacon gap and the best seconds are per Player instance, but slides more than 2 away unmount
`src/features/reels/use-view-beacon.ts:21-24`, `src/features/reels/feed.tsx:187` (`KEEP_AROUND = 2`)

- **Scenario:** the viewer watches reel A for 3 s, so the beacon goes at t=3. They swipe 3 reels down. A's Player unmounts and schedules a "leave" send for t=8. They swipe back by t=4 and watch 3 s, so the new instance (with `lastSent = -Infinity`) sends at t=7. The old leave timer sends at t=8. That is two beacons 1 s apart for one reel, which breaks "never more than once per 5 s per reel".
- **Fix:** keep `lastSent` and `bestSent` in a module-level `Map<reelId, …>`.

### M2. Hiding the tab cancels a beacon that was waiting for the 5 s gap, and those seconds are lost
`src/features/reels/use-view-beacon.ts:49,54`

`send("hide")` first clears `waiting`, then returns without sending when it is inside the gap.

- **Scenario:** first beacon at t=3. Pause at t=4 queues a send for t=8. The tab is hidden at t=5, which drops the queued send. If the viewer never plays again, the best 4 s is never reported.
- **Fix:** in `hide` mode, leave a pending `waiting` timer in place (timers still fire in background tabs). Only `pagehide` should give up.

### M3. Mute is applied on the client like a block
`src/features/reels/availability.ts:31`, `src/features/reels/reel-menu.tsx:31,40`, `src/features/reels/comments.tsx:257,327`, `src/features/reels/grid.tsx:57`

`hideCreator` is used for both mute and block. The API applies mutes to discovery lists only (`ReelVisibility` passes `mutes: false` for direct pages, profile tabs, saved reels and comments).

- **Effect 1:** after a mute, the creator's comments and their profile, saved and direct-link reels vanish for this visit, then come back after a reload. The behaviour is inconsistent.
- **Effect 2:** if a mute request fails after a block of the same creator succeeded, `showCreator` shows the blocked creator again.
- **Fix:** keep `muted` and `blocked` as separate sets. Filter comments and non-discovery lists by `blocked` only. Make `showCreator` undo only the set its own action added.

### M4. Backend: `GET /v1/studio/reels` sorts on `createdAt` without a matching index
`src/modules/reels/reels.service.ts:193-213`, `prisma/schema.prisma` (Reel indexes are `[creatorId, publishedAt, id]`, `[creatorId, status, id]`, …)

The query filters on `creatorId` and the status, sorts by `(createdAt desc, id desc)`, and pages with a keyset cursor. With no `[creatorId, createdAt, id]` index, Postgres reads all of a creator's rows and sorts them. That is fine at today's volumes; add the index if creators keep long histories.

The authorization is otherwise sound: the caller is always `user.id`, a cursor from another user only sets a position in the caller's own list, the cursor is HMAC-signed, `DELETED` is excluded, and `failureReason` is shown only to the owner (the owner is the viewer).

### M5. The Studio "Failed" text shows the raw failure code
`src/features/studio-reels/status.ts:17`

`failureReason` holds codes such as `PROCESSING_ERROR` (`media-lifecycle.ts:74`), so creators read "The video could not be processed: PROCESSING_ERROR."

**Fix:** map known codes to plain words, and fall back to the generic sentence for any other code.

### M6. The feed's ARIA structure
`src/features/reels/feed.tsx:174-191`, `src/features/reels/slide.tsx:72-77`

`role="feed"` expects `article` children with `aria-posinset`/`aria-setsize`. The children here are `section`s labelled "Reel n of count", and `count` changes as pages load. Screen readers that use the feed pattern (NVDA, JAWS) will not page through it as intended.

**Fix:** use `<article aria-posinset={i+1} aria-setsize={hasNextPage ? -1 : count}>`.

### M7. The Studio edit form stays "dirty" after saving a caption with trailing whitespace
`src/features/studio-reels/reel-editor.tsx:26,36`

The form submits `caption.trim()`, but compares the untrimmed local state with the reel the API returns. Typing "abc " and saving leaves Save enabled, and the "Saved" note never shows.

**Fix:** compare `caption.trim() !== reel.caption`, or set the local state to `reel.caption` on success.

## Checked and fine

- **One video playing:** the stream is attached only while the reel is visible or is the preload. It is paused and hls is destroyed when it leaves, an attach that is aborted while hls.js is still loading is destroyed, and slides more than 2 away render no video.
- **Rapid like/save taps:** one request loop per reel and kind, the last tap wins, a failure rolls back to the confirmed state, and counts never go below 0.
- **Paging:** cursors are passed unchanged, and `flattenReels` dedupes across pages and against the `first` reel.
- **Hidden or deleted reels:** a 404 from like, comment or the viewer copy marks the reel unavailable. The slide shows a state with Next, and navigation skips it.
- **Daily limit:** `LIMIT_REACHED` shows Publish, a 403 is reported in place, and the asset is kept in the form until the reel is created.
- **Notifications:** the count is polled every 60 s and on focus. Mark read is optimistic and rolls back on failure. Links are internal only.
- **Safe rendering:** captions, comments and notifications are plain text, and hashtag links are encoded.
- **Server-rendered pages:** they use cached public reads. With no visitor IP, the rate-limit guard lets a trusted public SSR read through, so SSR does not hit the per-IP read limit.
- **Keyboard:** Up/Down/J/K, Space and M are ignored while typing or with a dialog open.
- **Reduced motion:** no autoplay, and scrolling is instant.

## Verdict

**Ready to merge after fixes.** Fix I1–I4 in the planned fix wave. Each is small and local, and each should get the unit test named above. The Minor items can go in the same wave or be logged for later.
