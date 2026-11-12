# Web Phase 4 — Reels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members watch reels in a full-screen vertical feed (Following and For you), like, save, share, comment, report and block; creators post reels from Studio with a course or gig link; hashtag pages and reel search work; notifications show in the app.

**Architecture:** `src/features/reels` (feed, player, engagement, comments), `src/features/notifications`, and Studio reel posting reusing the Phase 3 upload engine. Feed is client-rendered; hashtag pages and single reel pages are server-rendered with public data for sharing and SEO.

**Tech Stack:** As Phase 3. hls.js for reels (public HLS).

**Spec:** `docs/superpowers/specs/2026-11-06-skiller-web-frontend-design.md` (section 9 Reels, 12 phase 4). Earlier web ledgers bind.

## Global Constraints

- Web branch `phase-4-reels`; backend branch `web-phase-4`, both from `main`.
- Process ruling (user, 2026-11-13): the full backend suite runs once per phase, before merge; between tasks run affected specs only.
- View beacon `POST /v1/reels/:id/views {watchedSec}` after 3 s of watching, then on pause, swipe away and page hide, with the best watched seconds; never more than once per 5 s per reel. Link-click beacon on card tap.
- Likes and saves are optimistic with rollback; counters show API values after settle, never go negative.
- Captions and comments are plain text with line breaks; hashtags in captions link to `/hashtags/<tag>`; mentions are plain text.
- Feeds use the API's signed cursors unchanged; no duplicates when new reels arrive.
- Preload one reel ahead, pause off-screen reels, mute by default with a tap to unmute that sticks for the session, respect reduced motion.
- Full-screen feed at 375 px first; on desktop a centred 9:16 column with actions beside it. Keyboard: up/down moves reels, space pauses, `m` mutes.
- Every data view uses page states; AA contrast.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions taken for this plan (change any you disagree with)

1. **Bottom nav:** "Reels" goes to `/reels` (For you default, Following tab). Signed-out visitors get For you; Following asks them to sign in.
2. **Single reel page** `/reels/[id]` server-rendered (title, OG video/thumbnail) and opens into the feed when scrolled.
3. **Comments** in a bottom sheet on phones, side panel on desktop; one reply level; creator can delete any comment on their reel.
4. **Posting:** Studio → Reels → New: upload (REEL purpose), caption, optional link to one of the creator's published courses or active gigs, comments on/off. Daily limit hit → reel is saved and the screen offers Publish when allowed (`POST /v1/reels/:id/publish`).
5. **Notifications:** bell with unread count in the shell (polled every 60 s and on focus), list page `/notifications`, mark read and read all.
6. **Report and block** from the reel's menu; blocked creators disappear from the current feed at once.

## Review Focus

1. **Fast swiping:** many reels in seconds. Expected: one video playing, earlier ones paused and released, beacons not duplicated, memory flat. Test in Task 3.
2. **Like double tap and offline:** Expected: final state matches the last tap; rollback on failure. Test in Task 4.
3. **Hidden or deleted reel while open:** Expected: page state, feed skips it, no crash. Test in Task 3.
4. **Blocked user content:** Expected: never shown after block, including comments and replies. Test in Task 5.
5. **Daily limit:** Expected: clear message and later publish, no lost upload. Test in Task 6.

---

### Task 1: Backend schemas

Type every reels, feed, hashtag, reel search, studio reels analytics, reports and notifications route listed as untyped; validate live responses in e2e as in Phase 2; lower the untyped ceiling. Affected specs, typecheck, lint, `openapi:check-responses`. Commit `feat: typed responses for reels, feeds and notifications`.

### Task 2: Reel player

`src/features/reels/{player.tsx,use-reel-playback.ts,use-view-beacon.ts}`. Tests: plays only when ≥ 60% visible; pauses off-screen and releases hls instance; beacon after 3 s, then on pause/hide with best seconds, never within 5 s of the last; mute state shared for the session; reduced motion disables autoplay of the next reel.

### Task 3: Feeds

`/reels` (For you, Following), `/reels/[id]`, `/hashtags/[tag]` (top/recent), reel search in the existing search UI, profile Reels tab, saved reels in settings. Tests: cursor paging without duplicates; preload one ahead; hidden or deleted reel shows a state and is skipped; signed-out Following asks to sign in; keyboard navigation; OG metadata on `/reels/[id]` and `/hashtags/[tag]`; real 404 for missing.

### Task 4: Engagement

Like, save, share (Web Share API, copy link fallback; records share), link card with click beacon. Tests: optimistic toggle with rollback; rapid taps end in the last intended state; counters never negative; share recorded once per tap.

### Task 5: Comments, report, block

Comments sheet/panel, replies, edit/delete own, creator deletes any on own reel, comments off state. Report dialog (reasons from API) for reels and comments; block and mute from menu. Tests: plain text rendering; blocked user's reels and comments vanish immediately; report sends once.

### Task 6: Studio reels and notifications

Studio → Reels list (status: processing, published, held by limit, failed) with analytics per reel and totals; New reel flow per decision 4; edit caption/link/comments; delete. Notifications bell and page per decision 5. Tests: daily-limit hold then publish; processing → published updates; link picker shows only own published courses and active gigs; unread count updates after read.

### Task 7: End-to-end and full suite

Flows at both sizes: creator posts a reel (real ffmpeg transcode with a generated test video), it reaches the For you feed; viewer watches 3 s (view counted after flush), likes, saves, comments, replies; creator deletes a comment; viewer reports a reel; viewer blocks creator and their reels vanish; hashtag page lists the reel; daily limit hold then publish; notifications show the like and comment. All earlier flows pass. Then the backend full suite once, and `pnpm e2e` three times; all green.

## Exit check

- [ ] A creator posts a reel linked to a course; a viewer finds it in For you, watches, likes and comments; the creator sees the notification.
- [ ] Fast swiping stays smooth with one video playing.
