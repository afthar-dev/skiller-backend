# Phase 4 — Reels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Short-video reels — creators post 9:16 videos that can link to their courses; everyone can watch, like, save, share, comment and report; two feeds (Following, For you), hashtag pages, moderation with reports and strikes, and creator reel analytics.

**Architecture:** New `reels` module owning reels, engagement, comments, views, interests, hashtags. Reel video uses Phase 1's `REEL` media purpose (public HLS). Generic `moderation` module (reports, strikes, blocks) built here so courses reviews and later gigs can reuse it. View counting goes through Redis and is flushed to Postgres in batches; feeds are computed at read time over a bounded candidate window (no ML).

**Tech Stack:** As Phases 1–3. Redis (HyperLogLog / sets) for view dedupe and hot counters; Postgres for everything durable.

**Spec:** `docs/superpowers/specs/2026-11-03-skiller-platform-redesign-design.md` §9 (and §7 media, §11 entitlements). Phase 1–3 ledgers' rulings still bind.

## Global Constraints

- Reel video = one `REEL` media asset (public HLS, ≤ 90 s, ≤ 200 MB, 9:16 preferred) attached via `MediaService.attach`.
- Captions and comments are PLAIN TEXT, sanitised with the shared plain-text helper; caption ≤ 2,200 chars, comment ≤ 1,000 chars; hashtags parsed from the caption (`#[\p{L}\p{N}_]{1,50}`, max 10, stored lower-case NFC).
- Posting limit = owner's plan `reels_per_day` (Phase 2 entitlements), counted per IST day.
- Counters (likes, comments, saves, shares, views) are denormalised on the reel and must never go negative or double-count under concurrency or retries.
- Public read endpoints are `@Public` and rate-limited; hidden/removed reels and content from blocked users never appear.
- Every route has `@RequirePermission` / `@Public` / `@AuthenticatedOnly`; module reads/writes only its own tables; outbox handlers idempotent; money untouched.

## Decisions taken for this plan (please confirm)

1. **Who posts:** creators only (users who became a creator; ORG reels not in Phase 4). Every signed-in member can like, save, share, comment, report and follow. Matches Phase 1's rule that `REEL` uploads need creator status.
2. **Visibility:** reels are public. No followers-only or private reels in Phase 4.
3. **Course link:** a reel may link one PUBLISHED course its creator authors (shown as a "View course" card). Gig links come in Phase 5.
4. **Comments:** one level of replies; creators can delete any comment on their own reels and turn comments off per reel.
5. **Views:** a view counts after 3 s of watching, once per viewer per reel per 24 h. Logged-out viewers are identified by an anonymous device id (cookie), falling back to IP + user agent.
6. **For you ranking (explainable, no ML):** candidates = reels from the last 7 days (plus top-engaged of last 30 days to fill), score = recency decay (half-life 24 h) × engagement rate ((likes + 2·comments + 3·saves + 2·shares) / max(views, 20)) × (1 + interest match), where interests come from hashtags and linked-course categories the viewer engaged with. Already-viewed reels are pushed down; at most 2 reels per creator per page.
7. **Moderation:** anyone signed in can report a reel or comment (reason list). A reel with reports from 5 different users is auto-hidden pending review. Moderators uphold (remove + strike) or dismiss. 3 upheld strikes in 90 days → the creator can't post reels or comments for 7 days.
8. **Blocking:** a user can block another user; both stop seeing each other's reels and comments, and the blocked user can't comment on or follow the blocker.

## Review Focus

1. **Like/save/comment counters under concurrency and retries** (double-tap likes, two devices, unlike racing like, deleted comments with replies) — expected: counters always equal the true row counts. Test in Task 2.
2. **View inflation** (replaying the 3 s beacon, rotating anonymous ids, bots hitting the public endpoint) — expected: one view per viewer per reel per 24 h; per-IP caps on anonymous beacons; views only flushed once. Test in Task 3.
3. **Hidden/removed/blocked content leaking** into feeds, hashtag pages, profile tabs, comment threads, notifications or counts — expected: never shown to viewers. Test in Task 6.
4. **Posting limit bypass** (parallel publishes, delete-and-repost, IST midnight boundary) — expected: at most `reels_per_day` published per IST day. Test in Task 1.
5. **Feed pagination stability** (new reels arriving while scrolling, ranking changing between pages) — expected: no duplicates or skips within a session; opaque signed cursors. Test in Task 4.

---

### Task 1: Reel posting

- Models: `Reel(id, creatorId, mediaAssetId @unique, caption, hashtags String[], linkedCourseId?, status PROCESSING|PUBLISHED|HIDDEN|REMOVED|DELETED, commentsEnabled, publishedAt?, likeCount, commentCount, saveCount, shareCount, viewCount, watchSecTotal, createdAt, updatedAt)`, `Hashtag(tag @id, reelCount, lastUsedAt)`.
- `POST /v1/reels { mediaAssetId, caption, linkedCourseId?, commentsEnabled? }` (creator; asset READY or processing — publish automatically on `media.ready`, fail on `media.failed`); `PATCH /v1/reels/:id` (caption, link, commentsEnabled); `DELETE` (soft delete, detach media → cleanup).
- Posting limit `reels_per_day` counted at publish time under a per-creator advisory lock, IST day boundary.
- Course link validated through the courses module's exported lookup (PUBLISHED, authored by the creator).
- `GET /v1/reels/:id` (public), `GET /v1/profiles/:handle/reels` (public, newest first).
- [ ] TDD incl. Review Focus 4. Commit `feat: reel posting`.

### Task 2: Likes, saves, shares, comments

- Models: `ReelLike(reelId, userId) @@id`, `ReelSave(reelId, userId, createdAt) @@id`, `ReelShare(id, reelId, userId?, channel, createdAt)`, `ReelComment(id, reelId, userId, parentId?, body, status VISIBLE|HIDDEN|REMOVED|DELETED, likeCount?, createdAt)`.
- Idempotent `PUT/DELETE /v1/reels/:id/like`, `/save`; `POST /v1/reels/:id/shares {channel}` (rate-limited, counted once per user per reel per day); comments CRUD with one reply level, creator delete on own reel, commentsEnabled respected; `GET /v1/me/saved-reels`.
- Counter updates in the same tx as the row change (conditional insert/delete → increment/decrement only when a row actually changed).
- Notifications: creator on like/comment (batched 1 per reel per 10 min), commenter on reply.
- [ ] TDD incl. Review Focus 1. Commit `feat: reel engagement and comments`.

### Task 3: Views and watch time

- `POST /v1/reels/:id/views { watchedSec }` (`@Public`; beacon after ≥ 3 s; anonymous device id cookie `skiller_did` (httpOnly, 1 year) issued if missing); dedupe key per (viewer, reel, IST day) in Redis (`SET NX EX`); per-IP limit 300/h for anonymous; watched seconds capped at reel duration.
- Redis counters per reel flushed every minute to `viewCount` / `watchSecTotal` with atomic GETDEL-style swap (no double flush, no loss on flush failure); `ReelViewDaily(reelId, day, views, watchSec)` for analytics.
- Viewer history `ReelSeen(userId, reelId, lastSeenAt)` for signed-in users (feeds push seen reels down).
- [ ] TDD incl. Review Focus 2. Commit `feat: reel views`.

### Task 4: Feeds and interests

- `UserInterest(userId, key ("tag:<hashtag>" | "cat:<categoryId>"), weight float, updatedAt)` updated by engagement events (like +1, save +2, comment +1.5, share +2, view ≥ 50% +0.5; decay 2%/day applied lazily).
- `GET /v1/feed/following` (reels from followed creators, newest first), `GET /v1/feed/for-you` (Decision 6), both cursor-paginated with signed cursors that snapshot the candidate set per session (store the ranked id list for 30 min in Redis keyed by cursor session) so pages never duplicate/skip; logged-out for-you = global trending.
- Exclusions everywhere: non-PUBLISHED, blocked users (both ways), creators the viewer muted.
- [ ] TDD incl. Review Focus 5. Commit `feat: reel feeds`.

### Task 5: Hashtags and reel search

- `GET /v1/hashtags/:tag/reels` (top / recent), `GET /v1/hashtags/trending` (last 24 h growth), reel search by caption/hashtag (`simple` tsvector + trigram, like courses).
- [ ] TDD. Commit `feat: hashtags and reel search`.

### Task 6: Moderation — reports, strikes, blocks

- New `moderation` module: `Report(id, targetType REEL|REEL_COMMENT|COURSE_REVIEW|COURSE_QA, targetId, reporterId, reason, note?, status OPEN|UPHELD|DISMISSED, createdAt, decidedBy?, decidedAt?) @@unique([targetType, targetId, reporterId])`, `Strike(id, userId, reportId, createdAt, expiresAt)`, `UserBlock(blockerId, blockedId) @@id`, `UserMute(userId, mutedId) @@id`.
- Target owners register a `ModerationTarget` provider (hide/remove/restore, owner id) — reels and comments now; course reviews/Q&A adapters wired to Phase 3's hide functions.
- Auto-hide at 5 distinct reporters (Decision 7); moderator queue (`moderation.review`), uphold/dismiss with audit; strikes → posting ban 7 days at 3 strikes in 90 days (checked on reel/comment create).
- Block/mute endpoints; blocks enforced in reels, comments, follows (Phase 1 follow endpoint rejects blocked) and notifications.
- [ ] TDD incl. Review Focus 3. Commit `feat: moderation reports, strikes and blocks`.

### Task 7: Creator reel analytics, wiring, docs

- `GET /v1/studio/reels/analytics?from&to` and per reel: views, unique viewers, average watch %, likes/comments/saves/shares, link clicks to course (`POST /v1/reels/:id/link-click` beacon), follower growth attributed to reels; deeper charts for `analytics_level` standard/advanced.
- Worker boot test (view flush, interest decay, auto-publish on media.ready, notification batching); API boot test; openapi; README Reels section incl. new hand-written indexes.
- [ ] TDD. Commit `chore: reel analytics, wiring, docs`.

## Phase 4 exit check

- [ ] Creator uploads a reel linked to their course → published after transcode → appears in followers' Following feed and in For you.
- [ ] Likes/comments/views counts exact after a burst of parallel actions.
- [ ] Five reports auto-hide a reel; moderator upholds → strike recorded; third strike blocks posting.
