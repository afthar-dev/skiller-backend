# Fix wave report: Web Phase 4 (Reels)

Nothing pushed or merged. M3 left as is, by instruction.

## Commits
Web (`skiller-web`, branch `phase-4-reels`):
- 99f466a I1 rejected play(): AbortError ignored; NotAllowedError mutes and retries play() once; other errors leave the mute alone
- 9cb85a5 I2 watch clock starts on `playing`, stops on `waiting`/`stalled`/`pause`
- a5bf2c0 M1 + M2 beacon last-sent/best kept per reel id in a module map (`resetViewBeacons` for tests); a hidden tab keeps its waiting send; only `pagehide` drops it
- d066083 I3 `onSessionEnded` (auth) fired from `endSession`; reels `session-reset.ts` clears engagement and availability stores
- 1822355 I4 hashtag grid: while session is loading, SSR tiles stay in the DOM but `invisible`, `aria-hidden`, `aria-busy`, with a visible Loading overlay; signed out shows public copy; member fetches own list
- 91edca6 M5 + M7 failure codes mapped to plain text with generic fallback; edit form dirty check uses `caption.trim()`
- 96fd3ec M6 feed items are `article` with `aria-posinset` and `aria-setsize` (-1 while more pages exist)
- 702c33c e2e selectors `section[data-reel-*]` -> `article[...]`
- 4b39cb3 typecheck fix for M5, and the `u/[handle]` page test auth mock gets `onSessionEnded`

Backend (`skiller-backend`, branch `web-phase-4`):
- 43b8609 M4 index `reels(creatorId, createdAt DESC, id DESC)`, migration `20261113120000_reels_creator_created_index`

## Verification
- Web: typecheck, lint, build, api:check clean. Unit tests 712 passed (95 files), up from 705 before the wave.
- Backend: typecheck, lint, openapi:check-responses ok (88 allowlisted, ceiling 88), prisma validate ok, schema-drift check ok on a scratch Postgres (container since stopped), reels unit specs 363 passed (50 suites). OpenAPI did not change, so no `api:generate`.
- `E2E_BUILD_BACKEND=1 E2E_PG_PORT=55600 pnpm e2e`: 118 passed, 0 failed.
- Docker was not stopped or restarted.

## Notes / not fixed
- M3 untouched (mute treated like block on the client).
- I4: crawlers still get the tiles in the server HTML; the poster images of hidden tiles may still be requested by the browser while the session loads.
- I3 is wired through a small auth hook (`onSessionEnded`) rather than reels code inside auth, to avoid an import cycle. Any test that mocks `@/features/auth` and imports the reels index needs `onSessionEnded` in its mock (done for the one that failed).
- M1: a remounted slide still counts its own seconds from zero, so it only reports once it exceeds the best already sent for that reel.
- The `auth-provider` test "a lost session redirects once" failed once under parallel load and passed on rerun alone and in the final full run (timing flake, pre-existing).
- The studio-reels test fixture used `VIDEO_TOO_LONG`, which the backend never emits; the tests now use `DURATION_EXCEEDED`.
