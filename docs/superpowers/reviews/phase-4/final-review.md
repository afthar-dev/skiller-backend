# Phase 4 final whole-branch review (reels + moderation)

Range `ee2d778..691d8b3`, branch `phase-4-reels`. Reviewed in passes by one reviewer: all of `src/modules/reels` and `src/modules/moderation`, the cross-module diffs (users, media, notifications, courses, rbac, worker, app), the six migrations and schema, README, drift script, and the e2e specs by name plus the riskiest bodies. No tests were run (instruction). Test claims below come from reading them and the ledger's reported 1207 green.

**Verdict: With fixes.** One Critical and five Important findings. All are small, local fixes that fit the planned single fix wave. The core mechanics (counters, flush, posting limit, signed cursors, visibility seam) are sound.

## Strengths

- **Counters.** Every like, save, share and comment uses a conditional row change, and `bumpCounter` runs in the same transaction only when a row changed (`engagement.service.ts:49-54`, `comments.service.ts:127-130`). I found no double-count or lost-update path, and the FK key-share plus row-update ordering cannot deadlock.
- **View flush.** RENAME, one transaction recording `ReelViewFlush`, then DEL is genuinely exactly-once across all three crash points. Overlapping runs serialise on the `ON CONFLICT` insert (`reel-view-flusher.ts`).
- **Posting limit.** The advisory lock is taken before the count, the count is of `publishedAt` events with deleted rows included, and there is one publish path for API and worker. Parallel publish, delete-and-repost and midnight are all correct, and the media.ready-versus-create gap is closed by the publish at the end of `create` plus the row lock in `reserve`.
- **Hashtag counts.** They follow PUBLISHED through every transition, including HIDDEN -> REMOVED and deleting a HIDDEN reel, with sorted lock order.
- **Visibility seam.** `ReelVisibility.filterVisible` is used on every list, and snapshots are re-checked at serve time. I found no path that shows a hidden, removed or blocked reel to a viewer through the API. The epoch-keyed relations cache is correct against the read-before-write race.
- **Cursors.** Per-context HKDF keys; the For you session is bound to the viewer (`stored.u === viewerId`), so a stolen cursor cannot read a private ranking; tag, sort and search hash are bound.
- **Auto-hide.** It fires once under the per-target lock plus the hold row, and the race is tested.
- **Tests.** `moderation-visibility.e2e-spec.ts:114` proves every surface shows each reel before asserting absence, which is the positive control most such tests lack.

## Critical

### C1. Deleting reported content escapes the strike and destroys the evidence

Files: `src/modules/reels/reels.service.ts:125-133` (via `owned(..., true)` at `:175`), `src/modules/reels/reel-moderation-targets.ts:28,43`, `src/modules/moderation/moderation.service.ts:152-153`.

- **What happens.** A creator may DELETE a reel in any status, including HIDDEN. `ownerOf` then returns null for DELETED, so `uphold` answers `409 TARGET_GONE` ("dismiss the reports instead"). The same applies to a VISIBLE comment deleted before the decision.
- **Failure scenario.** Five people report a reel. The creator receives `moderation.hidden` ("under review"), which is effectively the cue. They delete it. The moderator can only dismiss, so no strike is recorded. Repeating this for ever means the three-strike ban (Decision 7, exit check 3) never fires for anyone who presses delete. The video is also detached, so the evidence is purged 24 h later.
- **Fix.**
  - Refuse creator delete of a HIDDEN reel (409), or at minimum while a `ModerationHold` exists.
  - Have `ownerOf` keep answering for DELETED content (reels and comments) that has OPEN reports, for example by splitting it into `ownerOf` (always the author) and a `reportable` check used by `report()`. `uphold` then strikes even if the content is already gone.
  - Do not release the media of a reel with open reports until the decision.
  - Test: report, delete, uphold gives a strike.

## Important

### I1. Posting ban does not cover edits

Files: `src/modules/reels/reels.service.ts:95-122`, `src/modules/reels/comments.service.ts:111-118`.

- The ban is checked on create and publish only. A banned user can still `PATCH` any live reel's caption (new text, new hashtags, which also move the trending and tag pages) and edit every existing comment. In other words, they can keep publishing text to live surfaces for the 7 days.
- The plan text says "checked on reel/comment create", but Decision 7 says "can't post", and the user asked for every path. No test covers it.
- Fix: `assertCanPost` in both `update` when `caption` is in the patch, and in `edit`.

### I2. A removed video stays publicly playable for 24 h or more

Files: `src/modules/reels/reel-moderation-targets.ts:65`, `src/modules/media/media-attachments.ts` (`detach`), `src/modules/media/media-cleanup.processor.ts:58`.

- Uphold calls `detach`, which sets `detachedAt`. Cleanup deletes objects only when `detachedAt < now - 24h`, on an hourly run, so up to about 25 h.
- Reel video is public HLS, so anyone holding the URL (a share, a cached page, a previous feed response) can keep playing content a moderator just ruled against (reasons include SEXUAL, VIOLENCE, COPYRIGHT).
- "Removed content never shown" holds only at the API layer. The test at `moderation.e2e-spec.ts:163` asserts only that the video is freed.
- Fix: add a `MediaAttachments.takedown` (or a `detach` option) that makes the asset immediately eligible and enqueues deletion of its objects now (with a CDN purge if one exists), and use it for `to === "REMOVED"`.

### I3. Watch time counts only the first beacon, so `watchSec` and `avgWatchPct` are wrong

File: `src/modules/reels/reel-view-tracker.ts:83-88`.

- `watched` reaches the pending hash only on the beacon that wins the dedupe; every later beacon returns at line 83.
- The API is by design multi-beacon: the ≥ 50 % interest signal in `markSeen` only ever fires from a later beacon, and the plan says the beacon goes "after ≥ 3 s".
- A client beaconing at 3 s and again at the end therefore records 3 s for every view, so `watchSecTotal`, `ReelViewDaily.watchSec` and `avgWatchPct` report about 3 / duration for every creator. A client beaconing only at the end instead loses every abandoned view.
- `reels-views.e2e-spec.ts:59` replays a beacon but never asserts `watchSec`; the analytics tests send one beacon per viewer, so this passes unseen.
- Fix: store the viewer's best-so-far in the dedupe key and `HINCRBY` the positive delta (one Lua step or GETSET), still capped at duration. Add a test: beacons at 3 s then 12 s give `watchSec` 12, views 1.

### I4. For you sessions have no memory bound, on a `noeviction` Redis that also holds security state

File: `src/modules/reels/feeds.service.ts:160-169`.

- Every request without a cursor stores a full list (up to 500 ids, about 20 KB) under a fresh UUID for 30 min. The only cap is 120/min per user or IP.
- One anonymous IP can pin 3,600 sessions, about 72 MB; a hundred IPs, about 7 GB. Normal traffic also grows linearly, because each anonymous landing stores another copy of the same global list.
- README requires `noeviction` (line 296), so filling Redis fails writes for rate limits, revoked-session markers and BullMQ, which is a platform outage rather than a slow feed.
- A signed-in user also pays a full re-rank per pull-to-refresh with no reuse.
- Fix: anonymous sessions should reference a shared versioned global snapshot (the cursor carries version + offset; one list per 5 min, per block size). Signed-in users should have one session key per user (a new first page overwrites it, with the session id inside it for cursor validity), which bounds memory to about 20 KB per active user.

### I5. The candidate window is the newest 500, not "the last 7 days"

File: `src/modules/reels/feeds.service.ts:197-205` (`MAX_CANDIDATES`, line 30).

- `orderBy publishedAt desc, take 500` means that once 500 reels exist in a week, older reels are never candidates, however engaging. That is about 24 creators posting the Free limit of 3 a day.
- At 170 such creators the window is under a day, a two-day-old hit vanishes, and the 30-day top-up never runs because the count is not under 100. Ranking degrades to "recent reels" just as the product starts working, contrary to Decision 6.
- Fix: union of newest N and top-engaged M within 7 days (same SQL as the fill), de-duplicated.

## Minor

1. **Per-creator cap broken by serve-time filtering** (`feeds.service.ts:165` then `136-144`). `interleave` runs before the visibility filter, so any skipped reel (block, mute, hidden) shifts page boundaries across blocks and a page can hold up to 4 from one creator. The accepted ruling covered only a changed `limit`. Filter blocked and muted creators in `rankFor` before interleaving. The test at `reels-feeds.e2e-spec.ts:238` has no filtered rows.
2. **Ban missed under concurrent upholds** (`moderation.service.ts:165-177`). The lock is per target, so two upholds for one owner each count without the other's uncommitted strike: 1 prior + 2 concurrent gives no ban. Add an advisory lock on the owner before the strike insert.
3. **"Per 24 h" versus "per IST day"** (`reel-view-tracker.ts:70`). Decision 5 and Review Focus 2 say 24 h; Task 3 says IST day. A viewer at 23:59 and 00:01 IST counts twice. This is a plan conflict, resolved by the implementation in Task 3's favour; it needs a recorded ruling.
4. **`watchedPct` overwritten by the latest beacon** (`reel-view-tracker.ts:144-146`). A later short beacon lowers it, so the next 50 % crossing emits another `reel.engaged` view despite the "sent once per reel" comment. Use `GREATEST`.
5. **int4 counters can poison the flush** (`reel-view-flusher.ts:114-116`, `reels.watchSecTotal`, `reel_view_daily.watchSec`, `SUM(...)::int` in analytics). `watchSecTotal` overflow (about 24 M full views of a 90 s reel) fails the whole batch and every later one, because stale batches run first and a failure aborts the run. Far off, but the blast radius is all view counting. Use BigInt, and skip or dead-letter after N failures.
6. **Unsigned cursors bypass the NUL guard** (`user-blocks.ts:126-132`, `moderation.service.ts:287-295`). A base64 cursor can decode to an id with `\u0000`, giving a Postgres error and a 500 on `GET /v1/me/blocks`. Use `SignedCursor`.
7. **Raw IP in a Redis key** (`reel-view-tracker.ts:129`). The dedupe key holds the plain address for 25 h, and the UA hash is unsalted. Use a keyed hash of `ip|ua`.
8. **Replies under a hidden or removed top-level comment** (`comments.service.ts:81-84`). They stay in `commentCount`, are unreachable by `list` and `replies`, and can still be replied to via a visible reply's id. Check the top-level status in `create`. The ledger notes the count part.
9. **Reporters' notes never reach moderators** (`moderation.service.ts:245-263`). `note` is stored and described as "shown to moderators only", but no read returns it.
10. **Unlike and unsave answer 404 once the reel is hidden or the creator blocked** (`engagement.service.ts:62,84`). A user cannot withdraw their like or save; removing your own row need not require visibility.
11. **Course targets stay reportable after an uphold** (`course-moderation-targets.ts:29,50`). `ownerOf` ignores the removed state, so new reporters plus a second uphold give a second strike for the same content. A removed review is also indistinguishable from a held one.
12. **Moderator conflicts are narrow** (`moderation.service.ts:239-243`). A moderator can uphold their own report, and can strike a commenter on their own reel (no `conflictsWith` on REEL_COMMENT, unlike the course rule).
13. **`report()` has no visibility gate** (`moderation.service.ts:94-98`). Someone the creator blocked, or a non-enrolled user with an id, can report, and 404 versus 201 confirms existence.
14. **`reels` is missing from the ESLint boundary list** (`eslint.config.mjs:9`). Neither its own imports nor deep imports into it are checked. Its imports are compliant today, and `rbac/permissions.ts` needs the same treatment as the other permission imports.
15. **Follow versus block race** (`follows.service.ts:23`). The check is outside the follow transaction, so a follow can land just after the block's `removeBetween`. The feed still hides it, but counts and the row persist across the block.
16. **`POST /v1/reels/:id/publish` is `AuthenticatedOnly`** (`reels.controller.ts:60`), so someone who lost `reel.create` can still publish a waiting reel.
17. **Growth without retention.** `interest:event:*` keys are one per engagement for 7 days although the comment says redelivery is within minutes (`interest-events.handler.ts:14`); `reel_view_flushes` gains a row a minute for ever; `reel_seen` is unbounded.
18. **Trending may show a tag from a removed reel** for up to the hourly refresh (`hashtag-trending.ts`). No reel is exposed, only the tag text.
19. **Test honesty.** Tests read as genuine: positive controls, real concurrency, and mutation evidence that matches the code. Weak spots:
    - The `toBeDefined` checks after `app.get` are vacuous (`worker.module.int-spec.ts:80-81,103`), because `app.get` throws; the handler and job assertions beside them are real.
    - The boot tests never had a RED, as declared.
    - Missing tests matching the findings above: delete-then-uphold, edit under ban, multi-beacon watch time, cap with filtered rows, concurrent upholds.
    - The "stolen cursor" test (`reels-feeds.e2e-spec.ts:233`) checks `refreshed` but not that the items differ from the owner's list; the code is right.

## Review Focus lines (plan), checked deliberately

1. Counters under concurrency and retries: **met**, with no retry-unsafe path. `commentCount` equals VISIBLE rows; see minor 8 for what those rows mean under hidden parents.
2. View inflation: **met as ruled**. Replay, per-IP cap and flush-once all hold. The "24 h" wording is minor 3, and watch time is I3.
3. Hidden, removed or blocked leaks: **met at the API**. Not met for the video URL (I2).
4. Posting limit bypass: **met**, including worker auto-publish.
5. Feed pagination stability: **met**. Signed cursors work, no duplicates within a session, viewer-bound. Memory is I4.

## Rulings weighed

All Ruling lines in the ledger were read and none is overturned.

- Hold, the 0.05 engagement floor (formula matches Decision 6 plus the ruling), viewer-keyed sessions, LIMIT_REACHED reuse for bans and the API-only course targets are all sound.
- The course-targets ruling is safe because `report` and decisions run only in the API.
- The "ban checked on create" scope from the plan is why I1 is Important rather than Critical.

## Declined to judge

- Suspended or deleted accounts keep their reels and comments public and in feeds. No event exists, and courses behave the same (`catalog.service.ts:113`). Spec silent, but a reasonable user would expect them gone; the executor should rule.
- Moderators cannot act without an open report, except by filing one themselves. Outside the plan.
- HIDDEN reels stay playable by URL while under review (reversible hold). I2 covers only REMOVED.
- Brigading: five cheap accounts can hide any reel, repeatedly, after each dismissal (Decision 7; no account-age weighting).
- Creator self-likes and repeated comments (30/min, each worth 2) feed the engagement rate. Decision 6 is silent.
- Anonymous 1-year device cookie and consent (DPDP). Legal question, not in the plan.
- `TRUST_PROXY` defaults to 0; if unset in production every per-IP cap is shared by all clients. Deployment config from Phase 1.
- Blocked viewers' beacons counting, `commentCount` including blocked users, cookie rotation capped not eliminated, anonymous shares uncounted, hashtag-top boundary skips, `newFollowers` not attributed to reels, `uniqueViewers` approximate: accepted rulings.
- Retried comment POST creates a duplicate comment (no idempotency key). Counters stay true; spec does not ask for it.
- Moderation notices are in-app only by default (`transactional: false`). Product choice.
- Not verified by execution: the suite, the compiled `dist` boot order (`moderation/index.ts` is import-order sensitive; boot tests cover the ts-jest path only), and query plans.

## Assessment

**Ready to merge: With fixes.** Fix C1 and I1-I5 in the planned fix wave, each with the matching test; the minors can be triaged. Nothing needs redesign, and the counter, flush and limit machinery should not be touched.
